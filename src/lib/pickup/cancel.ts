import { prisma, tenantTransaction } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { appendShipmentEvent } from "@/lib/shipment/events";
import type { PickupStatus } from "@/generated/prisma/client";

/**
 * Calling a collection off.
 *
 * Three things have to happen together, and until now only the first of
 * them did:
 *
 *  1. the request closes, and the reason goes in its own `cancelReason`
 *     column. It used to be written into `notes` — which is not a
 *     scratchpad but the branch's own instructions to the executive, the
 *     gate code and whom to ask for, and precisely what the next attempt at
 *     that address needs. A cancellation destroyed it;
 *
 *  2. the live assignment is superseded, so the stop leaves the run. The
 *     day list already hid it, because that query filters on the request's
 *     status — but the assignment itself stayed open, which meant the load
 *     counters on the pickup desk still charged the executive for a stop
 *     nobody was making, and `loadAssignment` in `execute.ts` still let it
 *     be completed. A phone holding the cached task, or an offline queue
 *     replaying hours later, could post a collection against a pickup the
 *     branch had cancelled;
 *
 *  3. the consignment behind it, if there is one, is told.
 *
 * ── On (3), and what the state machine does not have ────────
 *
 * There is no `PICKUP_CANCELLED`. It is not in `ShipmentEventType` and
 * there is no rule in `TRANSITIONS` that takes a consignment back out of
 * `PICKUP_ASSIGNED` — the only events valid from there are another
 * `PICKUP_ASSIGNED`, `PICKUP_ATTEMPTED`, `PICKUP_COMPLETED`, and the
 * pre-dispatch ones that either say nothing about status or cancel the
 * whole booking.
 *
 * So this posts `BOOKING_AMENDED`, which is a real rule used for what it is
 * defined to do: valid from every pre-dispatch status, `to: null`, meaning
 * recorded without moving the status. The consignment stays at
 * `PICKUP_ASSIGNED` and its log now says why nobody is coming, instead of
 * saying nothing at all.
 *
 * That is survivable, not correct. `PICKUP_ASSIGNED` appears in its own
 * `from` list and in `PICKUP_COMPLETED`'s, so re-raising and re-assigning a
 * pickup recovers the consignment completely and nothing is stuck. But
 * between the cancellation and the next pickup the status reads "assigned
 * for pickup" while no assignment exists, and no amount of care in this
 * file fixes that: it needs a new transition rule — `PICKUP_CANCELLED`,
 * from `PICKUP_ASSIGNED` back to `BOOKED` — which is a change to the spine
 * and not one this screen may make on its own.
 */

export type CancelPickupInput = {
  pickupRequestId: string;
  /** Mandatory, and kept. Not written over the branch's notes. */
  reason: string;
  /** The clock of the act. Defaults to now. */
  cancelledAt?: Date;
};

export type CancelPickupResult =
  | {
      ok: true;
      number: string;
      branchId: string;
      previousStatus: PickupStatus;
      /** Executives the stop was taken away from. */
      unassigned: string[];
      /**
       * What the consignment was told. `NONE` when there is no consignment
       * — a blind pickup has nothing to move.
       */
      shipmentEvent: "RECORDED" | "REFUSED" | "NONE";
    }
  | { ok: false; error: string };

export async function cancelPickupRequest(
  input: CancelPickupInput,
  actor: SessionUser,
): Promise<CancelPickupResult> {
  if (!can(actor, "pickup.cancel")) {
    return { ok: false, error: "You do not have permission to cancel pickups." };
  }

  const reason = input.reason.trim();
  if (reason.length < 3) {
    return { ok: false, error: "Give a reason — it goes on the record." };
  }

  const request = await prisma.pickupRequest.findUnique({
    where: { id: input.pickupRequestId },
    select: {
      id: true,
      number: true,
      branchId: true,
      status: true,
      shipmentId: true,
      assignments: {
        where: { supersededAt: null },
        select: { id: true, assignedToId: true },
      },
    },
  });

  if (!request) return { ok: false, error: "That pickup no longer exists." };
  if (!coversBranch(actor, request.branchId)) {
    return { ok: false, error: "That pickup is outside your scope." };
  }
  if (request.status === "COMPLETED") {
    return { ok: false, error: "That pickup has already been collected." };
  }
  if (request.status === "CANCELLED") {
    return { ok: false, error: "That pickup is already cancelled." };
  }

  const cancelledAt = input.cancelledAt ?? new Date();
  const unassigned = request.assignments.map((a) => a.assignedToId);

  await tenantTransaction(async (tx) => {
    await tx.pickupRequest.update({
      where: { id: request.id },
      data: {
        status: "CANCELLED",
        cancelledAt,
        cancelReason: reason,
        cancelledById: actor.id,
      },
    });

    // Superseded rather than deleted, the same way a reassignment leaves
    // its history behind: who was sent, and when it was taken off them,
    // has to survive.
    await tx.pickupAssignment.updateMany({
      where: { pickupRequestId: request.id, supersededAt: null },
      data: { supersededAt: cancelledAt, status: "CANCELLED" },
    });
  });

  let shipmentEvent: "RECORDED" | "REFUSED" | "NONE" = "NONE";

  if (request.shipmentId) {
    // See the note above: the nearest honest rule, because none exists that
    // moves the status back.
    const event = await appendShipmentEvent(
      {
        shipmentId: request.shipmentId,
        eventType: "BOOKING_AMENDED",
        branchId: request.branchId,
        occurredAt: cancelledAt,
        remarks: `Pickup ${request.number} cancelled — ${reason}`,
        payload: {
          pickupNumber: request.number,
          pickupCancelled: true,
          reason,
          unassigned,
        },
      },
      actor,
    );

    if (!event.ok && event.code !== "INVALID_TRANSITION") {
      return { ok: false, error: event.error };
    }
    shipmentEvent = event.ok ? "RECORDED" : "REFUSED";
  }

  return {
    ok: true,
    number: request.number,
    branchId: request.branchId,
    previousStatus: request.status,
    unassigned,
    shipmentEvent,
  };
}
