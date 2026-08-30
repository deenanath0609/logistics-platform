import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { PaymentType } from "@/generated/prisma/client";
import type { CustomerSession } from "@/lib/auth/customer-session";
import { createBooking, type BookingResult } from "@/lib/shipment/booking";
import { bookingActorFor, resolveBookingBranches } from "./service-actor";
import type { ShipmentMode } from "@/generated/prisma/client";

/**
 * Booking from the portal.
 *
 * A thin, deliberately boring wrapper around `createBooking` — the same
 * numbering, the same transaction, the same opening `BOOKING_CREATED`
 * event. What this file adds is the two things a customer must not be
 * allowed to choose:
 *
 *  · the consignor, which is welded to their own account and their own
 *    saved address, so a portal login cannot book as somebody else; and
 *  · the branches, which follow the account and the PIN codes rather than
 *    anything posted from a browser.
 */

export type PortalBookingInput = {
  /** One of the account's own `CustomerAddress` rows. */
  pickupAddressId: string;
  serviceTypeId: string;
  mode: ShipmentMode;

  consigneeName: string;
  consigneeCompany?: string | null;
  consigneePhone: string;
  consigneeEmail?: string | null;
  consigneeAddress: string;
  consigneeCityId: string;
  consigneePincode: string;
  consigneeLandmark?: string | null;
  consigneeGstin?: string | null;

  packageCount: number;
  packageTypeId?: string | null;
  actualWeight: number;
  declaredValue?: number | null;
  goodsDescription: string;
  specialInstructions?: string | null;
  isFragile?: boolean;

  paymentType: PaymentType;
  codAmount?: number | null;

  customerReference?: string | null;
  invoiceNumber?: string | null;
  invoiceValue?: number | null;
  pickupRequired?: boolean;
};

export async function createPortalBooking(
  session: CustomerSession,
  input: PortalBookingInput,
): Promise<BookingResult> {
  // ── The consignor is not an input ─────────────────────────
  // Fetched with the account id in the WHERE clause, so a posted address
  // id belonging to someone else simply does not resolve.
  const address = await prisma.customerAddress.findFirst({
    where: {
      id: input.pickupAddressId,
      customerId: session.customerId,
      isActive: true,
    },
    select: {
      contactName: true,
      phone: true,
      address: true,
      cityId: true,
      pincode: true,
    },
  });

  if (!address) {
    return {
      ok: false,
      error: "Choose one of your saved pickup addresses.",
      field: "pickupAddressId",
    };
  }

  const customer = await prisma.customer.findUnique({
    where: { id: session.customerId },
    select: { name: true, phone: true, email: true, gstin: true },
  });

  if (!customer) {
    return { ok: false, error: "That account no longer exists." };
  }

  const branches = await resolveBookingBranches({
    customerId: session.customerId,
    consignorPincode: address.pincode,
    consigneePincode: input.consigneePincode,
  });

  if (!branches.ok) {
    return { ok: false, error: branches.error, field: branches.field };
  }

  if (input.paymentType === "COD" && !(input.codAmount && input.codAmount > 0)) {
    return {
      ok: false,
      error: "Enter the amount to collect on delivery.",
      field: "codAmount",
    };
  }

  const actor = await bookingActorFor(session);

  return createBooking(
    {
      mode: input.mode,
      serviceTypeId: input.serviceTypeId,
      bookingBranchId: branches.bookingBranchId,
      originBranchId: branches.originBranchId,
      destinationBranchId: branches.destinationBranchId,

      // Locked. None of these came off the form.
      consignorId: session.customerId,
      consignorName: customer.name,
      consignorCompany: customer.name,
      consignorPhone: address.phone ?? customer.phone,
      consignorEmail: customer.email,
      consignorAddress: address.address,
      consignorCityId: address.cityId,
      consignorPincode: address.pincode,
      consignorGstin: customer.gstin,

      consigneeName: input.consigneeName,
      consigneeCompany: input.consigneeCompany ?? null,
      consigneePhone: input.consigneePhone,
      consigneeEmail: input.consigneeEmail ?? null,
      consigneeAddress: input.consigneeAddress,
      consigneeCityId: input.consigneeCityId,
      consigneePincode: input.consigneePincode,
      consigneeLandmark: input.consigneeLandmark ?? null,
      consigneeGstin: input.consigneeGstin ?? null,

      packageCount: input.packageCount,
      packageTypeId: input.packageTypeId ?? null,
      actualWeight: input.actualWeight,
      declaredValue: input.declaredValue ?? null,
      goodsDescription: input.goodsDescription,
      specialInstructions: input.specialInstructions ?? null,
      isFragile: input.isFragile ?? false,

      paymentType: input.paymentType,
      codAmount: input.codAmount ?? null,
      // Rating is Phase 6. A portal booking carries no charge lines, and
      // certainly none the customer typed.
      charges: [],

      customerReference: input.customerReference ?? null,
      invoiceNumber: input.invoiceNumber ?? null,
      invoiceValue: input.invoiceValue ?? null,
      pickupRequired: input.pickupRequired ?? true,

      idempotencyKey: randomUUID(),
      source: "WEB",
      // The service principal authorises the write; this names who
      // actually did it. `bookedById` is left null so the chain of
      // custody carries a real person, not a system account.
      bookedByCustomerUserId: session.id,
    },
    actor,
  );
}

/**
 * Records which portal login actually placed a booking.
 *
 * The shipment itself is attributed to the portal service principal
 * because `bookedById` is a foreign key into staff — see service-actor.ts
 * — so the real author is written here, immediately afterwards, as an
 * audit row. Losing that would make "who booked this?" unanswerable.
 */
export async function recordPortalBookingAuthor(
  session: CustomerSession,
  shipmentId: string,
  lrNumber: string,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        orgId: session.orgId,
        action: "CREATE",
        entity: "Shipment",
        entityId: shipmentId,
        entityRef: lrNumber,
        after: {
          bookedVia: "CUSTOMER_PORTAL",
          customerUserId: session.id,
          customerUserEmail: session.email,
          customerId: session.customerId,
        },
      },
    });
  } catch (error) {
    // Auditing must never be the reason a valid booking fails.
    console.error("[portal booking audit]", error);
  }
}
