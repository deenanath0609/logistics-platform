import { prisma } from "@/lib/prisma";
import { nextNumber } from "@/lib/numbering/number-series";
import { recordAudit } from "@/server/services/audit";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import type {
  ComplaintCategory,
  ComplaintPriority,
  ComplaintStatus,
  Prisma,
} from "@/generated/prisma/client";
import { deadlinesFrom } from "./sla";
import { findTransition } from "./workflow";

/**
 * Complaint write path.
 *
 * Every mutation here follows the same shape as the rest of the system:
 * check the permission, do the work in one transaction, write an audit
 * row. Complaints are the record of what the company did when it let a
 * customer down, so a status that changed without a trail is worse than
 * useless.
 */

export type ComplaintResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ────────────────────────────────────────────────────────────
// Portal safety
// ────────────────────────────────────────────────────────────

/**
 * The only filter that may be used to build a thread for the customer.
 *
 * `ComplaintMessage.isInternal` defaults to true, which means a message
 * saved without thinking about it is private. That default is the whole
 * protection, and it only works if the read side never forgets the filter
 * — so the filter is a named export rather than an object literal typed
 * out at each call site.
 */
export const CUSTOMER_VISIBLE = { isInternal: false } as const;

/** Messages the customer is allowed to see, ordered oldest first. */
export async function customerVisibleMessages(complaintId: string) {
  return prisma.complaintMessage.findMany({
    where: { complaintId, ...CUSTOMER_VISIBLE },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      body: true,
      createdAt: true,
      authorUserId: true,
      authorCustomerUserId: true,
      attachmentId: true,
    },
  });
}

// ────────────────────────────────────────────────────────────
// Create
// ────────────────────────────────────────────────────────────

export type CreateComplaintInput = {
  category: ComplaintCategory;
  priority: ComplaintPriority;
  subject: string;
  description: string;
  shipmentId?: string | null;
  customerId?: string | null;
  branchId?: string | null;
  assignedToId?: string | null;
};

export async function createComplaint(
  input: CreateComplaintInput,
  actor: SessionUser,
): Promise<ComplaintResult<{ id: string; number: string }>> {
  if (!can(actor, "complaint.create")) {
    return { ok: false, error: "You do not have permission to log a complaint." };
  }

  // Where the complaint lands: the branch that has to answer for it. A
  // complaint about a consignment belongs to the branch delivering it, not
  // to whoever happened to pick up the phone.
  let branchId = input.branchId ?? null;
  let customerId = input.customerId ?? null;

  if (input.shipmentId) {
    const shipment = await prisma.shipment.findUnique({
      where: { id: input.shipmentId },
      select: { destinationBranchId: true, consignorId: true },
    });
    if (!shipment) {
      return { ok: false, error: "That consignment does not exist." };
    }
    branchId ??= shipment.destinationBranchId;
    customerId ??= shipment.consignorId;
  }

  branchId ??= actor.primaryBranch?.id ?? null;

  const raisedAt = new Date();
  const { respondBy, resolveBy } = deadlinesFrom(
    raisedAt,
    input.category,
    input.priority,
  );

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Numbered inside the transaction so an abandoned complaint does not
      // burn a number out of the series.
      const number = await nextNumber({ document: "COMPLAINT" }, tx);

      return tx.complaint.create({
        data: {
          orgId: actor.orgId,
          number,
          category: input.category,
          priority: input.priority,
          status: input.assignedToId ? "ASSIGNED" : "OPEN",
          subject: input.subject,
          description: input.description,
          shipmentId: input.shipmentId ?? null,
          customerId,
          branchId,
          raisedByUserId: actor.id,
          assignedToId: input.assignedToId ?? null,
          respondBy,
          resolveBy,
          createdAt: raisedAt,
        },
        select: { id: true, number: true },
      });
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Complaint",
      entityId: created.id,
      entityRef: created.number,
      branchId,
      after: {
        category: input.category,
        priority: input.priority,
        subject: input.subject,
        shipmentId: input.shipmentId ?? null,
        respondBy,
        resolveBy,
      },
    });

    return { ok: true, data: created };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

// ────────────────────────────────────────────────────────────
// Messages
// ────────────────────────────────────────────────────────────

export type AddMessageInput = {
  complaintId: string;
  body: string;
  /**
   * Defaults to true, mirroring the column. A caller that wants the
   * customer to read it has to say so, every time.
   */
  isInternal?: boolean;
  attachmentId?: string | null;
};

export async function addMessage(
  input: AddMessageInput,
  actor: SessionUser,
): Promise<ComplaintResult<{ id: string }>> {
  if (!can(actor, "complaint.create")) {
    return { ok: false, error: "You do not have permission to reply." };
  }

  const isInternal = input.isInternal ?? true;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const complaint = await tx.complaint.findUnique({
        where: { id: input.complaintId },
        select: { id: true, number: true, branchId: true, firstResponseAt: true },
      });
      if (!complaint) return null;

      const message = await tx.complaintMessage.create({
        data: {
          complaintId: complaint.id,
          body: input.body,
          authorUserId: actor.id,
          isInternal,
          attachmentId: input.attachmentId ?? null,
        },
        select: { id: true },
      });

      // The response clock stops on the first thing the *customer* can
      // read. An internal note saying "chasing the driver" is work, not a
      // response, and stopping the clock on it would make the SLA measure
      // how fast we talk to ourselves.
      if (!isInternal && !complaint.firstResponseAt) {
        await tx.complaint.update({
          where: { id: complaint.id },
          data: { firstResponseAt: new Date() },
        });
      }

      return { message, complaint };
    });

    if (!result) return { ok: false, error: "That complaint no longer exists." };

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "ComplaintMessage",
      entityId: result.message.id,
      entityRef: result.complaint.number,
      branchId: result.complaint.branchId,
      after: { isInternal, length: input.body.length },
    });

    return { ok: true, data: result.message };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

// ────────────────────────────────────────────────────────────
// Transitions
// ────────────────────────────────────────────────────────────

export type TransitionInput = {
  complaintId: string;
  to: ComplaintStatus;
  /** Required by some transitions; becomes a customer-visible message. */
  note?: string | null;
  assignedToId?: string | null;
};

export async function transitionComplaint(
  input: TransitionInput,
  actor: SessionUser,
): Promise<ComplaintResult<{ status: ComplaintStatus }>> {
  const complaint = await prisma.complaint.findUnique({
    where: { id: input.complaintId },
    select: {
      id: true,
      number: true,
      status: true,
      branchId: true,
      assignedToId: true,
      resolvedAt: true,
      firstResponseAt: true,
    },
  });
  if (!complaint) return { ok: false, error: "That complaint no longer exists." };

  const transition = findTransition(complaint.status, input.to);
  if (!transition) {
    return {
      ok: false,
      error: `A complaint cannot go from ${complaint.status.toLowerCase()} to ${input.to.toLowerCase()}.`,
    };
  }

  if (!can(actor, transition.permission)) {
    return { ok: false, error: `You do not have permission to ${transition.label.toLowerCase()}.` };
  }

  const note = input.note?.trim() ?? "";
  if (transition.requiresNote && note.length === 0) {
    return { ok: false, error: `${transition.label} needs a note explaining it.` };
  }
  if (transition.requiresAssignee && !input.assignedToId) {
    return { ok: false, error: "Choose who owns this complaint." };
  }

  const now = new Date();
  const data: Prisma.ComplaintUpdateInput = { status: input.to };

  if (input.assignedToId) {
    data.assignedTo = { connect: { id: input.assignedToId } };
  }

  if (input.to === "RESOLVED") {
    data.resolvedAt = now;
    data.resolution = note;
  }
  if (input.to === "CLOSED") {
    data.closedAt = now;
  }
  if (input.to === "REOPENED") {
    data.reopenedAt = now;
    // The original deadlines stand. A customer who had to come back has
    // already waited; restarting their clock would hide exactly that.
    data.resolvedAt = null;
    data.closedAt = null;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.complaint.update({ where: { id: complaint.id }, data });

      if (note.length > 0) {
        // A transition note is the outcome, so the customer sees it. The
        // separate reply box is where internal asides go.
        await tx.complaintMessage.create({
          data: {
            complaintId: complaint.id,
            body: note,
            authorUserId: actor.id,
            isInternal: false,
          },
        });

        if (!complaint.firstResponseAt) {
          await tx.complaint.update({
            where: { id: complaint.id },
            data: { firstResponseAt: now },
          });
        }
      }
    });

    await recordAudit({
      user: actor,
      action: "STATUS_CHANGE",
      entity: "Complaint",
      entityId: complaint.id,
      entityRef: complaint.number,
      branchId: complaint.branchId,
      before: { status: complaint.status, assignedToId: complaint.assignedToId },
      after: { status: input.to, assignedToId: input.assignedToId ?? complaint.assignedToId },
      reason: note || transition.label,
    });

    return { ok: true, data: { status: input.to } };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("No active number series")) {
    return "No COMPLAINT number series is configured. Set one up under Masters → Number series.";
  }
  if (message.includes("Foreign key constraint")) {
    return "A referenced record is missing or has been removed.";
  }

  console.error("[complaints]", error);
  return "Something went wrong. Nothing was changed.";
}
