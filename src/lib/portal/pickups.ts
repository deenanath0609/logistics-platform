import { prisma, tenantTransaction } from "@/lib/prisma";
import type { PickupSlot, PickupStatus } from "@/generated/prisma/client";
import type { CustomerSession } from "@/lib/auth/customer-session";
import { nextNumber } from "@/lib/numbering/number-series";
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

/**
 * Cancels a request the customer raised, if it has not been collected.
 *
 * Scoped by account in the same statement that updates, so there is no
 * window between "is it mine?" and "change it".
 */
export async function cancelPortalPickup(
  session: CustomerSession,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await prisma.pickupRequest.updateMany({
    where: {
      id,
      ...customerOwnedFilter(session),
      status: { in: ["REQUESTED", "ASSIGNED"] },
    },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });

  if (result.count === 0) {
    return {
      ok: false,
      error: "That request cannot be cancelled — it may already be under way.",
    };
  }
  return { ok: true };
}
