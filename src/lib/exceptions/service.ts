import { prisma, tenantTransaction } from "@/lib/prisma";
import { coversBranch } from "@/server/repositories/scope";
import { nextNumber } from "@/lib/numbering/number-series";
import { enqueueOutbox } from "@/server/services/outbox";
import { recordAudit } from "@/server/services/audit";
import type { SessionUser } from "@/lib/auth/session";
import type {
  Exception,
  ExceptionKind,
  ExceptionPriority,
  ExceptionStatus,
  Prisma,
} from "@/generated/prisma/client";
import { KIND_DEFS, STATUS_LABEL, kindLabel, transitionTo } from "./kinds";

/**
 * Writing to the exception tower.
 *
 * Everything that opens an exception comes through `raiseException`, and
 * it is idempotent on `dedupeKey`. That is not a nicety: the SLA scanner
 * runs every few minutes over the same open shipments, and a tower that
 * grows a new "SLA at risk" row every pass is a tower nobody can read by
 * lunchtime.
 */

export type RaiseInput = {
  orgId: string;
  kind: ExceptionKind;
  title: string;
  detail?: string | null;
  priority?: ExceptionPriority;
  shipmentId?: string | null;
  tripId?: string | null;
  vehicleId?: string | null;
  branchId?: string | null;
  /**
   * The branch that owns the problem, which is not always where it was
   * noticed — a shortage belongs to the branch that dispatched.
   */
  ownerBranchId?: string | null;
  assignedToId?: string | null;
  reasonCodeId?: string | null;
  detectedAt?: Date;
  /** "sla-scanner", "hub", "gps", "manual". */
  source?: string;
  /**
   * Stable across scans for the same underlying problem. Omitting it
   * means "this really is a new occurrence every time", which is almost
   * never what a detector wants.
   */
  dedupeKey?: string | null;
};

export type RaiseResult = {
  exception: Exception;
  /** False when an identical exception already existed. */
  created: boolean;
};

/**
 * Opens an exception, or returns the one already open for this problem.
 *
 * The unique index on `(orgId, dedupeKey)` is the actual guarantee — the
 * lookup before it is only an optimisation, and the `P2002` catch is what
 * makes two scanners racing on the same shipment harmless.
 */
export async function raiseException(
  input: RaiseInput,
): Promise<RaiseResult> {
  const dedupeKey = input.dedupeKey ?? null;

  if (dedupeKey) {
    // A dedupe key is only unique within a tenant now, so the lookup is a
    // `findFirst` the extension scopes rather than a `findUnique`.
    const existing = await prisma.exception.findFirst({
      where: { dedupeKey },
    });
    if (existing) return { exception: existing, created: false };
  }

  const def = KIND_DEFS[input.kind];
  const detectedAt = input.detectedAt ?? new Date();
  const escalateAfter = def?.escalateAfterMinutes ?? 720;

  const data: Omit<Prisma.ExceptionUncheckedCreateInput, "number"> = {
    orgId: input.orgId,
    kind: input.kind,
    priority: input.priority ?? def?.priority ?? "NORMAL",
    title: input.title,
    detail: input.detail ?? undefined,
    shipmentId: input.shipmentId ?? undefined,
    tripId: input.tripId ?? undefined,
    vehicleId: input.vehicleId ?? undefined,
    branchId: input.branchId ?? undefined,
    ownerBranchId: input.ownerBranchId ?? input.branchId ?? undefined,
    assignedToId: input.assignedToId ?? undefined,
    reasonCodeId: input.reasonCodeId ?? undefined,
    detectedAt,
    escalateAt: new Date(detectedAt.getTime() + escalateAfter * 60_000),
    source: input.source ?? "system",
    dedupeKey: dedupeKey ?? undefined,
  };

  try {
    const exception = await tenantTransaction(async (tx) => {
      // Numbered inside the transaction so an exception that fails to
      // write does not burn a number out of the series.
      const number = await nextNumber({ document: "EXCEPTION" }, tx);

      const created = await tx.exception.create({
        data: { ...data, number },
      });

      await tx.exceptionAction.create({
        data: {
          orgId: created.orgId,
          exceptionId: created.id,
          action: "OPENED",
          note: `${kindLabel(input.kind)} detected by ${def?.detectedBy ?? input.source ?? "the system"}.`,
        },
      });

      await enqueueOutbox(
        {
          eventType: "exception.opened",
          aggregate: "Exception",
          aggregateId: created.id,
          payload: {
            number: created.number,
            kind: created.kind,
            priority: created.priority,
            title: created.title,
            shipmentId: created.shipmentId,
            ownerBranchId: created.ownerBranchId,
          },
        },
        tx,
      );

      return created;
    });

    return { exception, created: true };
  } catch (error) {
    // Another pass won the race on the unique dedupe key. That is the
    // index doing its job, not a failure.
    if (isUniqueViolation(error) && dedupeKey) {
      const existing = await prisma.exception.findFirst({
        where: { dedupeKey },
      });
      if (existing) return { exception: existing, created: false };
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

// ────────────────────────────────────────────────────────────
// Working an exception
// ────────────────────────────────────────────────────────────

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/** The shape every write below needs to decide whether the actor may act. */
type ScopedException = {
  branchId: string | null;
  ownerBranchId: string | null;
  assignedToId: string | null;
};

/**
 * May this person work this exception?
 *
 * The same rule the tower's list and detail screens read with: your
 * branches, or anything routed to you personally wherever it was raised —
 * a Delhi shortage handed to the claims desk in Mumbai is theirs to work.
 *
 * It belongs here rather than only on the page. The screens were scoped
 * and these writes were not, so a branch manager who could not *see* a
 * sister branch's exception could still acknowledge it, reassign it, or
 * close it with a resolution note by posting its id — and the audit
 * trail would show a Gurugram manager resolving a Jaipur shortage.
 */
export function canWorkException(
  user: SessionUser,
  exception: ScopedException,
): boolean {
  if (user.branchIds === null) return true;
  if (exception.assignedToId === user.id) return true;
  if (exception.ownerBranchId && coversBranch(user, exception.ownerBranchId)) {
    return true;
  }
  return Boolean(exception.branchId && coversBranch(user, exception.branchId));
}

const OUT_OF_SCOPE =
  "That exception belongs to another branch and is not assigned to you.";

/** A note on the thread, changing nothing else. */
export async function addExceptionNote(
  exceptionId: string,
  note: string,
  actor: SessionUser,
): Promise<ActionResult> {
  const trimmed = note.trim();
  if (!trimmed) return { ok: false, error: "Say something." };

  const exception = await prisma.exception.findUnique({
    where: { id: exceptionId },
    select: { branchId: true, ownerBranchId: true, assignedToId: true },
  });
  if (!exception) return { ok: false, error: "That exception is gone." };
  if (!canWorkException(actor, exception)) {
    return { ok: false, error: OUT_OF_SCOPE };
  }

  await prisma.exceptionAction.create({
    data: {
      orgId: actor.orgId,
      exceptionId,
      action: "NOTE",
      note: trimmed,
      userId: actor.id,
    },
  });

  return { ok: true, message: "Note added." };
}

export async function assignException(
  exceptionId: string,
  assignedToId: string | null,
  actor: SessionUser,
): Promise<ActionResult> {
  const exception = await prisma.exception.findUnique({
    where: { id: exceptionId },
    select: {
      id: true,
      number: true,
      assignedToId: true,
      ownerBranchId: true,
      branchId: true,
    },
  });
  if (!exception) return { ok: false, error: "That exception is gone." };
  if (!canWorkException(actor, exception)) {
    return { ok: false, error: OUT_OF_SCOPE };
  }

  const assignee = assignedToId
    ? await prisma.user.findUnique({
        where: { id: assignedToId },
        select: { id: true, name: true },
      })
    : null;

  if (assignedToId && !assignee) {
    return { ok: false, error: "That user no longer exists." };
  }

  await tenantTransaction(async (tx) => {
    await tx.exception.update({
      where: { id: exceptionId },
      data: {
        assignedToId: assignee?.id ?? null,
        // Handing it to someone counts as acknowledging it exists.
        status: assignee ? "ACKNOWLEDGED" : "OPEN",
        acknowledgedAt: assignee ? new Date() : null,
      },
    });

    await tx.exceptionAction.create({
      data: {
        orgId: actor.orgId,
        exceptionId,
        action: assignee ? "ASSIGNED" : "UNASSIGNED",
        note: assignee ? `Assigned to ${assignee.name}.` : "Owner removed.",
        userId: actor.id,
      },
    });
  });

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "Exception",
    entityId: exceptionId,
    entityRef: exception.number,
    branchId: exception.ownerBranchId,
    before: { assignedToId: exception.assignedToId },
    after: { assignedToId: assignee?.id ?? null },
  });

  return {
    ok: true,
    message: assignee ? `Assigned to ${assignee.name}.` : "Owner removed.",
  };
}

/**
 * Moves an exception along its workflow.
 *
 * The note requirement is checked here as well as in the UI, because the
 * UI is a convenience and this is the boundary. `resolution` is written to
 * the row itself rather than only to the thread — the register report
 * reads it, and a resolution nobody can export is a resolution nobody can
 * review.
 */
export async function transitionException(
  input: {
    exceptionId: string;
    to: ExceptionStatus;
    note: string;
  },
  actor: SessionUser,
): Promise<ActionResult> {
  const exception = await prisma.exception.findUnique({
    where: { id: input.exceptionId },
    select: {
      id: true,
      number: true,
      status: true,
      ownerBranchId: true,
      branchId: true,
      assignedToId: true,
      resolution: true,
    },
  });
  if (!exception) return { ok: false, error: "That exception is gone." };
  if (!canWorkException(actor, exception)) {
    return { ok: false, error: OUT_OF_SCOPE };
  }

  const transition = transitionTo(exception.status, input.to);
  if (!transition) {
    return {
      ok: false,
      error: `An exception cannot go from ${exception.status.toLowerCase()} to ${input.to.toLowerCase()}.`,
    };
  }

  if (!actor.permissions.has(transition.permission)) {
    return { ok: false, error: `You cannot ${transition.label.toLowerCase()} this.` };
  }

  const note = input.note.trim();
  if (transition.requiresNote && note.length < 5) {
    return {
      ok: false,
      error:
        "A resolution note is required. Write what was actually done — the next person reads this, not the status.",
    };
  }

  const now = new Date();
  const settled = input.to === "RESOLVED" || input.to === "DISMISSED";
  const closing = input.to === "CLOSED";
  const reopening = !settled && !closing;

  const data: Prisma.ExceptionUncheckedUpdateInput = {
    status: input.to,
    escalateAt: reopening || settled || closing ? null : undefined,
  };

  if (input.to === "ACKNOWLEDGED" || input.to === "IN_PROGRESS") {
    data.acknowledgedAt = now;
    // Reopening clears the settlement so the ageing report stops counting
    // it as done. Leaving the old timestamps would report a resolution
    // that has since been undone.
    data.resolvedAt = null;
    data.resolvedById = null;
    data.closedAt = null;
  }

  if (settled) {
    data.resolvedAt = now;
    data.resolvedById = actor.id;
    data.resolution = note;
  }

  if (closing) data.closedAt = now;

  await tenantTransaction(async (tx) => {
    await tx.exception.update({ where: { id: input.exceptionId }, data });

    await tx.exceptionAction.create({
      data: {
        orgId: actor.orgId,
        exceptionId: input.exceptionId,
        action: input.to,
        note: note || null,
        userId: actor.id,
      },
    });
  });

  if (settled || closing) {
    await enqueueOutbox({
      eventType: "exception.resolved",
      aggregate: "Exception",
      aggregateId: input.exceptionId,
      payload: { number: exception.number, status: input.to },
    });
  }

  await recordAudit({
    user: actor,
    action: "STATUS_CHANGE",
    entity: "Exception",
    entityId: input.exceptionId,
    entityRef: exception.number,
    branchId: exception.ownerBranchId,
    before: { status: exception.status },
    after: { status: input.to },
    reason: note || transition.label,
  });

  return { ok: true, message: `${STATUS_LABEL[input.to]}.` };
}
