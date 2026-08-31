import { prisma, tenantTransaction, type Tx } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { appendShipmentEvent } from "@/lib/shipment/events";
import { nextAttemptDate } from "./assignment";

/**
 * What happens at the consignor's door.
 *
 * Everything up to this point existed and none of it did: a pickup could be
 * raised, assigned and cancelled, and then it stopped. `IN_PROGRESS`,
 * `COMPLETED` and `FAILED` were in the enum, `PickupAttempt` was in the
 * schema, `nextAttemptDate` was written and tested, and no code path reached
 * any of them. A carrier could dispatch an executive and had nowhere to
 * record that the goods were collected.
 *
 * This is the other half, and it is written the way `delivery/execute.ts`
 * is written, for the same reason: a pickup executive is standing in a
 * doorway with a phone that may have no signal. Each function therefore
 * takes a client-generated `idempotencyKey` and the device's own clock, and
 * each is safe to call twice with the same key — the queue on the device
 * will replay it, possibly hours later, possibly out of order.
 *
 * ── What a failed attempt is ────────────────────────────────
 *
 * A row, not a flag. `PickupAttempt` keeps every visit, so a second attempt
 * that succeeds does not erase the first that did not — the consignor who
 * asks "you came yesterday and left" gets an answer. The request goes back
 * to `ASSIGNED` for the next working day rather than to `FAILED`, because
 * the job is not over; `FAILED` is where it lands when the branch gives up,
 * which is a decision an office makes and not something the doorstep
 * decides.
 */

/** Everything a field action carries, whatever it is. */
export type PickupFieldContext = {
  /** Client-generated UUID. The offline queue retries on this. */
  idempotencyKey: string;
  /** Device clock at the moment of the act, not of the sync. */
  occurredAt: Date;
  latitude?: number | null;
  longitude?: number | null;
  deviceId?: string | null;
};

export type PickupResult =
  | { ok: true; attemptNumber: number; alreadyRecorded?: true }
  | { ok: false; error: string };

type LoadedAssignment = {
  id: string;
  status: string;
  assignedToId: string;
  startedAt: Date | null;
  request: {
    id: string;
    number: string;
    branchId: string;
    status: string;
    shipmentId: string | null;
    requestedDate: Date;
    expectedPackages: number | null;
  };
  attempts: { attemptNumber: number; outcome: string }[];
};

/**
 * The live assignment for a pickup, with the checks every caller needs.
 *
 * Superseded assignments are excluded deliberately. A reassignment leaves
 * the old row behind as history, and an executive whose phone still holds
 * the stale task must not be able to complete work that now belongs to
 * somebody else — they are told it moved rather than silently allowed.
 */
async function loadAssignment(
  assignmentId: string,
  actor: SessionUser,
): Promise<LoadedAssignment | { error: string }> {
  const assignment = await prisma.pickupAssignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      status: true,
      assignedToId: true,
      startedAt: true,
      supersededAt: true,
      request: {
        select: {
          id: true,
          number: true,
          branchId: true,
          status: true,
          shipmentId: true,
          requestedDate: true,
          expectedPackages: true,
        },
      },
      attempts: {
        select: { attemptNumber: true, outcome: true },
        orderBy: { attemptNumber: "desc" },
      },
    },
  });

  if (!assignment) return { error: "That pickup is no longer on your list." };
  if (assignment.supersededAt) {
    return { error: "This pickup has been reassigned to somebody else." };
  }

  // An executive may only touch their own stop. An ops user with a wider
  // scope may act on behalf of one — a phone that died mid-round is an
  // ordinary Tuesday, and the office finishing the record is the fix.
  const own = assignment.assignedToId === actor.id;
  if (!own && !can(actor, "pickup.assign")) {
    return { error: "That pickup belongs to another executive." };
  }
  if (!coversBranch(actor, assignment.request.branchId)) {
    return { error: "That pickup is outside your scope." };
  }

  return assignment as LoadedAssignment;
}

/**
 * Marks the executive as on the way.
 *
 * Idempotent by nature rather than by key: starting a run twice is the same
 * as starting it once, and the first `startedAt` is the one that means
 * anything.
 */
export async function startPickup(
  input: { assignmentId: string },
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "pickup.execute")) {
    return { ok: false, error: "You do not have permission to run pickups." };
  }

  const loaded = await loadAssignment(input.assignmentId, actor);
  if ("error" in loaded) return { ok: false, error: loaded.error };

  if (loaded.status === "COMPLETED") {
    return { ok: false, error: "That pickup is already complete." };
  }

  if (loaded.startedAt) return { ok: true };

  await tenantTransaction(async (tx) => {
    await tx.pickupAssignment.update({
      where: { id: loaded.id },
      data: { status: "IN_PROGRESS", startedAt: new Date() },
    });
    await tx.pickupRequest.update({
      where: { id: loaded.request.id },
      data: { status: "IN_PROGRESS" },
    });
  });

  return { ok: true };
}

/**
 * Goods collected.
 *
 * `packagesCollected` is recorded as counted and never written back over
 * the booking. A consignor who said six and handed over five is a
 * conversation the office has to have, and overwriting the expectation
 * would delete the evidence that there was ever a difference — the
 * difference is money.
 */
export async function recordPickupCollected(
  input: {
    assignmentId: string;
    packagesCollected: number;
    weightCollected?: number | null;
    receiverName?: string | null;
    remarks?: string | null;
  } & PickupFieldContext,
  actor: SessionUser,
): Promise<PickupResult> {
  if (!can(actor, "pickup.execute")) {
    return { ok: false, error: "You do not have permission to run pickups." };
  }
  if (!Number.isInteger(input.packagesCollected) || input.packagesCollected < 1) {
    return { ok: false, error: "Enter how many packages you collected." };
  }

  const loaded = await loadAssignment(input.assignmentId, actor);
  if ("error" in loaded) return { ok: false, error: loaded.error };

  const replay = await findReplay(input.idempotencyKey);
  if (replay) return { ok: true, attemptNumber: replay, alreadyRecorded: true };

  if (loaded.status === "COMPLETED") {
    return { ok: false, error: "That pickup is already complete." };
  }

  const attemptNumber = (loaded.attempts[0]?.attemptNumber ?? 0) + 1;

  await tenantTransaction(async (tx) => {
    await writeAttempt(tx, {
      loaded,
      actor,
      attemptNumber,
      outcome: "COLLECTED",
      input,
      packagesCollected: input.packagesCollected,
      weightCollected: input.weightCollected ?? null,
      receiverName: input.receiverName ?? null,
    });

    await tx.pickupAssignment.update({
      where: { id: loaded.id },
      data: { status: "COMPLETED", completedAt: input.occurredAt },
    });
    await tx.pickupRequest.update({
      where: { id: loaded.request.id },
      data: { status: "COMPLETED" },
    });
  });

  // The shipment moves through the spine, never by writing currentStatus.
  // A pickup raised without a booking behind it — a consignor who called
  // before the paperwork existed — simply has nothing to move.
  if (loaded.request.shipmentId) {
    const event = await appendShipmentEvent(
      {
        shipmentId: loaded.request.shipmentId,
        eventType: "PICKUP_COMPLETED",
        branchId: loaded.request.branchId,
        occurredAt: input.occurredAt,
        payload: {
          pickupNumber: loaded.request.number,
          packagesCollected: input.packagesCollected,
          attemptNumber,
        },
      },
      actor,
    );

    if (!event.ok && event.code !== "INVALID_TRANSITION") {
      return { ok: false, error: event.error };
    }
  }

  return { ok: true, attemptNumber };
}

/**
 * Nobody there, or the consignor turned it away.
 *
 * The request goes back to `ASSIGNED` for the next working day rather than
 * to `FAILED`. `FAILED` is the office giving up, which is a decision made
 * with a calendar and a customer on the phone — not one made at a locked
 * shutter.
 */
export async function recordPickupFailed(
  input: {
    assignmentId: string;
    /**
     * Required, and the state machine agrees: `PICKUP_ATTEMPTED` names
     * `reasonCodeId` in its `requires`. "Nobody there", "premises closed"
     * and "consignor cancelled" are three different conversations for the
     * branch to have the next morning, and a free-text remark is not
     * something a report can count.
     */
    reasonCodeId: string;
    remarks?: string | null;
  } & PickupFieldContext,
  actor: SessionUser,
): Promise<PickupResult> {
  if (!can(actor, "pickup.execute")) {
    return { ok: false, error: "You do not have permission to run pickups." };
  }
  if (!input.reasonCodeId) {
    return { ok: false, error: "Choose why the pickup could not be made." };
  }

  const loaded = await loadAssignment(input.assignmentId, actor);
  if ("error" in loaded) return { ok: false, error: loaded.error };

  const replay = await findReplay(input.idempotencyKey);
  if (replay) return { ok: true, attemptNumber: replay, alreadyRecorded: true };

  if (loaded.status === "COMPLETED") {
    return { ok: false, error: "That pickup is already complete." };
  }

  const attemptNumber = (loaded.attempts[0]?.attemptNumber ?? 0) + 1;
  const retryOn = asStoredDate(nextAttemptDate(input.occurredAt));

  await tenantTransaction(async (tx) => {
    await writeAttempt(tx, {
      loaded,
      actor,
      attemptNumber,
      outcome: "FAILED",
      input,
      packagesCollected: null,
      weightCollected: null,
      receiverName: null,
    });

    // The assignment stays with the same executive and the request is moved
    // to the next working day. Reassigning is the branch's call, and the
    // screen offers it.
    await tx.pickupAssignment.update({
      where: { id: loaded.id },
      data: { status: "ASSIGNED", startedAt: null },
    });
    await tx.pickupRequest.update({
      where: { id: loaded.request.id },
      data: { status: "ASSIGNED", requestedDate: retryOn },
    });
  });

  if (loaded.request.shipmentId) {
    const event = await appendShipmentEvent(
      {
        shipmentId: loaded.request.shipmentId,
        eventType: "PICKUP_ATTEMPTED",
        branchId: loaded.request.branchId,
        occurredAt: input.occurredAt,
        // The state machine names `reasonCodeId` in this event's `requires`,
        // and leaving it off is how the first version of this silently wrote
        // nothing: the append was refused, the refusal was treated as a
        // transition that did not apply, and the shipment's log showed a
        // collection with no record of the visit that failed first.
        reasonCodeId: input.reasonCodeId,
        remarks: input.remarks ?? null,
        payload: {
          pickupNumber: loaded.request.number,
          attemptNumber,
          retryOn: retryOn.toISOString(),
        },
      },
      actor,
    );

    if (!event.ok && event.code !== "INVALID_TRANSITION") {
      return { ok: false, error: event.error };
    }
  }

  return { ok: true, attemptNumber };
}

// ────────────────────────────────────────────────────────────

/**
 * Has this exact action already been recorded?
 *
 * The device queues by `idempotencyKey`, and a reply lost on the road is
 * indistinguishable to it from a request that never arrived — so it sends
 * again. Returning the original attempt number rather than refusing is what
 * makes the retry harmless: the executive sees the same answer they would
 * have seen the first time, and nothing is written twice.
 */
async function findReplay(idempotencyKey: string): Promise<number | null> {
  const existing = await prisma.pickupAttempt.findFirst({
    where: { idempotencyKey },
    select: { attemptNumber: true },
  });
  return existing?.attemptNumber ?? null;
}

/**
 * A calendar day, as a `date` column will actually store it.
 *
 * `nextAttemptDate` returns local midnight, which is the right answer for a
 * person reading a screen and the wrong one for the column: Postgres stores
 * `date` by taking the UTC calendar day, so local midnight in any positive
 * offset — IST is +5:30, which is where this runs — lands on the *previous*
 * day once converted. A pickup rescheduled for tomorrow came back saved as
 * today, and the executive's list would have shown it again the same
 * afternoon.
 *
 * Taking the local year, month and day and rebuilding them at UTC midnight
 * keeps the day the person chose.
 */
function asStoredDate(day: Date): Date {
  return new Date(
    Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0),
  );
}

type AttemptWrite = {
  loaded: LoadedAssignment;
  actor: SessionUser;
  attemptNumber: number;
  outcome: "COLLECTED" | "FAILED";
  input: PickupFieldContext & { reasonCodeId?: string | null; remarks?: string | null };
  packagesCollected: number | null;
  weightCollected: number | null;
  receiverName: string | null;
};

async function writeAttempt(tx: Tx, write: AttemptWrite): Promise<void> {
  await tx.pickupAttempt.create({
    data: {
      orgId: write.actor.orgId,
      assignmentId: write.loaded.id,
      attemptNumber: write.attemptNumber,
      outcome: write.outcome,
      reasonCodeId: write.input.reasonCodeId ?? null,
      packagesCollected: write.packagesCollected,
      weightCollected: write.weightCollected,
      receiverName: write.receiverName,
      latitude: write.input.latitude ?? null,
      longitude: write.input.longitude ?? null,
      deviceId: write.input.deviceId ?? null,
      remarks: write.input.remarks ?? null,
      attemptedAt: write.input.occurredAt,
      createdById: write.actor.id,
      idempotencyKey: write.input.idempotencyKey,
    },
  });
}
