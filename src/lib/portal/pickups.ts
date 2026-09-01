import { prisma, tenantTransaction } from "@/lib/prisma";
import type { PickupSlot, PickupStatus } from "@/generated/prisma/client";
import type { CustomerSession } from "@/lib/auth/customer-session";
import { nextNumber } from "@/lib/numbering/number-series";
import { appendShipmentEvent } from "@/lib/shipment/events";
import { amendmentActorFor } from "./service-actor";
import { customerOwnedFilter } from "./visibility";

/**
 * Pickup requests raised from the portal.
 *
 * A blind pickup — no shipment yet, just "come and collect something" —
 * which is exactly the case `PickupRequest.shipmentId` was made nullable
 * for. The branch is derived from the PIN code being collected from, never
 * posted: routing is the network's decision.
 */

export type PortalPickupInput = {
  addressId: string;
  requestedDate: Date;
  slot: PickupSlot;
  expectedPackages?: number | null;
  expectedWeight?: number | null;
  goodsDescription?: string | null;
  notes?: string | null;
};

export type PortalPickupResult =
  | { ok: true; id: string; number: string }
  | { ok: false; error: string; field?: string };

export async function createPortalPickup(
  session: CustomerSession,
  input: PortalPickupInput,
): Promise<PortalPickupResult> {
  // The account id is in the WHERE clause, so another account's address id
  // resolves to nothing rather than to somebody else's front door.
  const address = await prisma.customerAddress.findFirst({
    where: {
      id: input.addressId,
      ...customerOwnedFilter(session),
      isActive: true,
    },
    select: {
      id: true,
      contactName: true,
      phone: true,
      address: true,
      cityId: true,
      pincode: true,
      landmark: true,
      latitude: true,
      longitude: true,
    },
  });

  if (!address) {
    return {
      ok: false,
      error: "Choose one of your saved addresses.",
      field: "addressId",
    };
  }

  const [customer, pincode] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: session.customerId },
      select: { name: true, phone: true, branchId: true, isBlocked: true },
    }),
    // Per-tenant geography: the PIN code is unique within the tenant, and
    // the extension supplies that half of the key.
    prisma.pincode.findFirst({
      where: { code: address.pincode },
      select: { servingBranchId: true },
    }),
  ]);

  if (!customer) return { ok: false, error: "That account no longer exists." };
  if (customer.isBlocked) {
    return {
      ok: false,
      error: "Collections on this account are on hold. Please speak to your account manager.",
    };
  }

  const branchId = pincode?.servingBranchId ?? customer.branchId;
  if (!branchId) {
    return {
      ok: false,
      error: "We do not currently collect from that PIN code.",
      field: "addressId",
    };
  }

  const created = await tenantTransaction(async (tx) => {
    // Numbered inside the transaction so an abandoned request does not
    // consume a number.
    const number = await nextNumber(
      { document: "PICKUP" },
      tx,
    );

    return tx.pickupRequest.create({
      data: {
        orgId: session.orgId,
        number,
        branchId,
        customerId: session.customerId,
        addressId: address.id,
        contactName: address.contactName ?? customer.name,
        phone: address.phone ?? customer.phone,
        address: address.address,
        cityId: address.cityId,
        pincode: address.pincode,
        landmark: address.landmark,
        latitude: address.latitude,
        longitude: address.longitude,
        requestedDate: input.requestedDate,
        slot: input.slot,
        expectedPackages: input.expectedPackages ?? null,
        expectedWeight: input.expectedWeight ?? null,
        goodsDescription: input.goodsDescription ?? null,
        notes: input.notes ?? null,
      },
      select: { id: true, number: true },
    });
  });

  return { ok: true, ...created };
}

export type PortalPickupRow = {
  id: string;
  number: string;
  status: PickupStatus;
  requestedDate: Date;
  slot: PickupSlot;
  address: string;
  cityName: string;
  pincode: string;
  expectedPackages: number | null;
  goodsDescription: string | null;
  createdAt: Date;
};

export async function listPortalPickups(
  session: CustomerSession,
): Promise<PortalPickupRow[]> {
  const rows = await prisma.pickupRequest.findMany({
    where: customerOwnedFilter(session),
    orderBy: [{ requestedDate: "desc" }, { createdAt: "desc" }],
    take: 50,
    select: {
      id: true,
      number: true,
      status: true,
      requestedDate: true,
      slot: true,
      address: true,
      pincode: true,
      expectedPackages: true,
      goodsDescription: true,
      createdAt: true,
      city: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    requestedDate: row.requestedDate,
    slot: row.slot,
    address: row.address,
    cityName: row.city.name,
    pincode: row.pincode,
    expectedPackages: row.expectedPackages,
    goodsDescription: row.goodsDescription,
    createdAt: row.createdAt,
  }));
}

export type PortalCancelPickupResult =
  | {
      ok: true;
      number: string;
      /** Executives the stop was taken away from. */
      unassigned: string[];
      /**
       * What the consignment was told. `NONE` when there is no consignment
       * — a portal pickup is usually blind and has nothing to move.
       */
      shipmentEvent: "RECORDED" | "REFUSED" | "NONE";
    }
  | { ok: false; error: string };

/**
 * Cancels a request the customer raised, if it has not been collected.
 *
 * The same three things the branch's own cancellation does — see
 * `src/lib/pickup/cancel.ts`, whose docblock carries the reasoning in full
 * and is not repeated here. This used to do only the first of them:
 *
 *  1. the request closes, with the reason in its own `cancelReason`
 *     column rather than written over the branch's `notes`;
 *
 *  2. the live assignment is superseded. Without this the day list hid
 *     the stop while the assignment stayed open, so the executive was
 *     still charged for it on the pickup desk's load counters, and
 *     `loadAssignment` in `execute.ts` still let a phone replaying an
 *     offline queue post a collection against a pickup the customer had
 *     called off hours earlier;
 *
 *  3. the consignment behind it, if there is one, is told — as
 *     `BOOKING_AMENDED`, because no `PICKUP_CANCELLED` rule exists and
 *     inventing one is a change to the spine. The consignment stays at
 *     `PICKUP_ASSIGNED` and its log now says why nobody is coming.
 *
 * Two things differ from the ops path, and both follow from who is asking:
 *
 *  · **Scope is the account, not the branch.** `customerOwnedFilter` is in
 *    the same query that finds the row, so another customer's pickup id
 *    resolves to nothing — and the refusal for "not yours" is worded
 *    identically to the refusal for "does not exist", because a message
 *    that distinguishes them confirms the record is real.
 *
 *  · **No reason is asked for.** The cancel control is a single button on
 *    a table row; there is no field for one and a validator that refused
 *    without it would refuse every press. The reason is generated, and it
 *    still says the true thing: which portal login called it off.
 */
export async function cancelPortalPickup(
  session: CustomerSession,
  id: string,
): Promise<PortalCancelPickupResult> {
  const request = await prisma.pickupRequest.findFirst({
    where: { id, ...customerOwnedFilter(session) },
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

  // Deliberately the same sentence a made-up id gets.
  if (!request) return { ok: false, error: "That request could not be found." };

  if (request.status === "COMPLETED") {
    return { ok: false, error: "That collection has already been made." };
  }
  if (request.status === "CANCELLED") {
    return { ok: false, error: "That request is already cancelled." };
  }
  if (request.status !== "REQUESTED" && request.status !== "ASSIGNED") {
    // IN_PROGRESS means somebody is at the door, and FAILED is closed.
    // Neither is ours to reverse from a browser.
    return {
      ok: false,
      error:
        "That collection is already under way. Please call your branch to stop it.",
    };
  }

  const cancelledAt = new Date();
  const reason = `Cancelled by ${session.name} through the customer portal`;
  const unassigned = request.assignments.map((a) => a.assignedToId);

  await tenantTransaction(async (tx) => {
    await tx.pickupRequest.update({
      where: { id: request.id },
      data: {
        status: "CANCELLED",
        cancelledAt,
        cancelReason: reason,
        // `cancelledById` points at `app_user` and a portal login is not
        // one. The person is named in the reason and on the event below.
        cancelledById: null,
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
    const actor = await amendmentActorFor(session);

    const event = await appendShipmentEvent(
      {
        shipmentId: request.shipmentId,
        eventType: "BOOKING_AMENDED",
        branchId: request.branchId,
        occurredAt: cancelledAt,
        remarks: `Pickup ${request.number} cancelled — ${reason}`,
        // The service principal authorises the write; this names who
        // actually did it, exactly as a portal booking does.
        customerUserId: session.id,
        payload: {
          pickupNumber: request.number,
          pickupCancelled: true,
          reason,
          unassigned,
        },
      },
      actor,
    );

    // A consignment already past pre-dispatch refuses the rule. The
    // collection is still cancelled — the goods moved without it.
    if (!event.ok && event.code !== "INVALID_TRANSITION") {
      console.error("[portal pickup cancel]", event.error);
    }
    shipmentEvent = event.ok ? "RECORDED" : "REFUSED";
  }

  return { ok: true, number: request.number, unassigned, shipmentEvent };
}
