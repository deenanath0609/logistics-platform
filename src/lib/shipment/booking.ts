import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma, PaymentType, ShipmentMode } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { nextNumber } from "@/lib/numbering/number-series";
import { chargeableWeight } from "./weight";
import { appendShipmentEvent } from "./events";
import {
  SHIPMENT_PRICING_SELECT,
  snapshotShipment,
  priceShipment,
  storeFreightCalculation,
} from "@/lib/pricing/resolve";
import type { FreightResult } from "@/lib/pricing/engine";

/**
 * Prices a freshly-created shipment inside the booking transaction.
 *
 * Returns null when the rate card cannot be consulted at all. A pricing
 * failure must not lose a booking: the consignment is real, the customer
 * is standing at the counter, and an unpriced shipment is recoverable
 * from the coverage-gap report. An unbooked one is not.
 */
async function priceShipmentForBooking(
  shipmentId: string,
  orgId: string,
  tx: Prisma.TransactionClient,
): Promise<FreightResult | null> {
  try {
    const stored = await tx.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: SHIPMENT_PRICING_SELECT,
    });

    const snapshot = await snapshotShipment(stored, tx);
    const result = await priceShipment(
      snapshot,
      {
        orgId,
        volumetricDivisor: stored.serviceType.volumetricDivisor,
      },
      tx,
    );

    // Stored whether or not a slab matched — "nothing matched, and here
    // is what was considered" is exactly what the coverage-gap report
    // needs to be actionable.
    await storeFreightCalculation(
      { shipmentId, result, stage: "BOOKING" },
      tx,
    );

    return result;
  } catch (error) {
    console.error("[booking] pricing failed; booking continues unpriced", {
      shipmentId,
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}

/**
 * Booking.
 *
 * Numbering, package rows, barcodes, charges and the opening event all
 * happen in one transaction. If any part fails, no LR number is burned
 * and no half-booked consignment is left behind.
 *
 * Freight is entered manually in this phase; the rate-card engine
 * replaces the `charges` input in Phase 6 without changing this shape.
 */

export type BookingPackageInput = {
  packageTypeId?: string | null;
  weight?: number | null;
  lengthCm?: number | null;
  breadthCm?: number | null;
  heightCm?: number | null;
  contents?: string | null;
};

export type BookingChargeInput = {
  chargeTypeId: string;
  basis: Prisma.ShipmentChargeCreateManyShipmentInput["basis"];
  rate: number;
  quantity: number;
  amount: number;
  taxRateId?: string | null;
  taxPercent?: number | null;
  isManual?: boolean;
  remarks?: string | null;
};

export type BookingInput = {
  mode: ShipmentMode;
  serviceTypeId: string;
  bookingBranchId: string;
  originBranchId: string;
  destinationBranchId: string;

  consignorId?: string | null;
  consignorName: string;
  consignorCompany?: string | null;
  consignorPhone: string;
  consignorEmail?: string | null;
  consignorAddress: string;
  consignorCityId: string;
  consignorPincode: string;
  consignorGstin?: string | null;

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
  packages?: BookingPackageInput[];

  paymentType: PaymentType;
  codAmount?: number | null;
  isReverseCharge?: boolean;
  charges?: BookingChargeInput[];

  customerReference?: string | null;
  ewayBillNumber?: string | null;
  invoiceNumber?: string | null;
  invoiceValue?: number | null;
  pickupRequired?: boolean;

  /** Set by the bulk importer so a retry cannot double-book a row. */
  idempotencyKey?: string;
  source?: "WEB" | "API" | "IMPORT";
  /**
   * The portal customer who booked this, when it came from the customer
   * side. The permission check still runs against `actor`, but the
   * *attribution* written to the shipment and its opening event is this
   * person — a service principal on the chain of custody is a wrong
   * record, and it cannot be corrected after the fact.
   */
  bookedByCustomerUserId?: string | null;
};

export type BookingResult =
  | { ok: true; shipmentId: string; lrNumber: string; barcodes: string[] }
  | { ok: false; error: string; field?: string };

export async function createBooking(
  input: BookingInput,
  actor: SessionUser,
): Promise<BookingResult> {
  if (!can(actor, "shipment.create")) {
    return { ok: false, error: "You do not have permission to book shipments." };
  }

  // ── Pre-flight checks, outside the transaction ────────────
  const serviceType = await prisma.serviceType.findUnique({
    where: { id: input.serviceTypeId },
    select: {
      id: true,
      code: true,
      mode: true,
      isActive: true,
      volumetricDivisor: true,
      allowsCod: true,
      allowsToPay: true,
      defaultTransitHours: true,
    },
  });

  if (!serviceType || !serviceType.isActive) {
    return { ok: false, error: "That service type is not available.", field: "serviceTypeId" };
  }
  if (serviceType.mode !== input.mode) {
    return {
      ok: false,
      error: `${serviceType.code} is a ${serviceType.mode} service, not ${input.mode}.`,
      field: "serviceTypeId",
    };
  }
  if (input.paymentType === "COD" && !serviceType.allowsCod) {
    return { ok: false, error: `COD is not offered on ${serviceType.code}.`, field: "paymentType" };
  }
  if (input.paymentType === "TO_PAY" && !serviceType.allowsToPay) {
    return { ok: false, error: `To-Pay is not offered on ${serviceType.code}.`, field: "paymentType" };
  }
  if (input.paymentType === "COD" && !(input.codAmount && input.codAmount > 0)) {
    return { ok: false, error: "Enter the amount to collect on delivery.", field: "codAmount" };
  }

  // Serviceability. Blocked destinations need an explicit override, which
  // is a separate permission precisely so it shows up in the audit trail.
  const destination = await prisma.pincode.findUnique({
    where: { code: input.consigneePincode },
    select: { isServiceable: true, isOda: true },
  });

  if (!destination) {
    return {
      ok: false,
      error: "That destination PIN code is not in the network.",
      field: "consigneePincode",
    };
  }
  if (!destination.isServiceable && !can(actor, "shipment.override_serviceability")) {
    return {
      ok: false,
      error: "That PIN code is not serviceable. An override permission is needed to book it.",
      field: "consigneePincode",
    };
  }

  if (input.packageCount < 1) {
    return { ok: false, error: "A shipment needs at least one package.", field: "packageCount" };
  }
  if (input.actualWeight <= 0) {
    return { ok: false, error: "Enter the weight.", field: "actualWeight" };
  }

  // ── Weight ────────────────────────────────────────────────
  const packages: BookingPackageInput[] =
    input.packages && input.packages.length > 0
      ? input.packages
      : Array.from({ length: input.packageCount }, () => ({}));

  const weights = chargeableWeight({
    actualWeight: input.actualWeight,
    packages,
    volumetricDivisor: serviceType.volumetricDivisor,
  });

  // ── Money ─────────────────────────────────────────────────
  const charges = input.charges ?? [];
  const freight = charges
    .filter((c) => c.basis !== undefined)
    .reduce((sum, c) => sum.plus(c.amount), new Decimal(0));
  const tax = charges.reduce(
    (sum, c) => sum.plus(new Decimal(c.amount).times(c.taxPercent ?? 0).dividedBy(100)),
    new Decimal(0),
  );

  const expectedDeliveryAt = serviceType.defaultTransitHours
    ? new Date(Date.now() + serviceType.defaultTransitHours * 3_600_000)
    : null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // The number is issued inside the transaction, so an abandoned
      // booking does not consume an LR number.
      const lrNumber = await nextNumber(
        { document: "LR" },
        tx as unknown as Parameters<typeof nextNumber>[1],
      );

      const shipment = await tx.shipment.create({
        data: {
          orgId: actor.orgId,
          lrNumber,
          mode: input.mode,
          serviceTypeId: input.serviceTypeId,
          bookingBranchId: input.bookingBranchId,
          originBranchId: input.originBranchId,
          destinationBranchId: input.destinationBranchId,

          consignorId: input.consignorId ?? undefined,
          consignorName: input.consignorName,
          consignorCompany: input.consignorCompany ?? undefined,
          consignorPhone: input.consignorPhone,
          consignorEmail: input.consignorEmail ?? undefined,
          consignorAddress: input.consignorAddress,
          consignorCityId: input.consignorCityId,
          consignorPincode: input.consignorPincode,
          consignorGstin: input.consignorGstin ?? undefined,

          consigneeName: input.consigneeName,
          consigneeCompany: input.consigneeCompany ?? undefined,
          consigneePhone: input.consigneePhone,
          consigneeEmail: input.consigneeEmail ?? undefined,
          consigneeAddress: input.consigneeAddress,
          consigneeCityId: input.consigneeCityId,
          consigneePincode: input.consigneePincode,
          consigneeLandmark: input.consigneeLandmark ?? undefined,
          consigneeGstin: input.consigneeGstin ?? undefined,

          packageCount: input.packageCount,
          packageTypeId: input.packageTypeId ?? undefined,
          actualWeight: weights.actual.toString(),
          volumetricWeight: weights.volumetric.toString(),
          chargeableWeight: weights.chargeable.toString(),
          declaredValue: input.declaredValue ?? undefined,
          goodsDescription: input.goodsDescription,
          specialInstructions: input.specialInstructions ?? undefined,
          isFragile: input.isFragile ?? false,

          paymentType: input.paymentType,
          codAmount: input.codAmount ?? undefined,
          freightAmount: freight.toFixed(2),
          chargesTotal: freight.toFixed(2),
          taxAmount: tax.toFixed(2),
          grandTotal: freight.plus(tax).toFixed(2),
          isReverseCharge: input.isReverseCharge ?? false,

          customerReference: input.customerReference ?? undefined,
          ewayBillNumber: input.ewayBillNumber ?? undefined,
          invoiceNumber: input.invoiceNumber ?? undefined,
          invoiceValue: input.invoiceValue ?? undefined,

          // Exactly one of these is set: a portal booking names the
          // customer, a counter booking names the clerk.
          bookedById: input.bookedByCustomerUserId ? null : actor.id,
          bookedByCustomerUserId: input.bookedByCustomerUserId ?? undefined,
          pickupRequired: input.pickupRequired ?? true,
          expectedDeliveryAt: expectedDeliveryAt ?? undefined,
        },
        select: { id: true, lrNumber: true },
      });

      // ── Packages, each with its own barcode ────────────────
      // Package-level rows are what make shortage detection possible: a
      // manifest of 17 that scans 15 can only name the missing two here.
      const barcodes = packages.map(
        (_, index) => `${shipment.lrNumber}-${String(index + 1).padStart(2, "0")}`,
      );

      await tx.shipmentPackage.createMany({
        data: packages.map((pkg, index) => ({
          shipmentId: shipment.id,
          sequence: index + 1,
          barcode: barcodes[index],
          packageTypeId: pkg.packageTypeId ?? input.packageTypeId ?? undefined,
          weight: pkg.weight ?? undefined,
          lengthCm: pkg.lengthCm ?? undefined,
          breadthCm: pkg.breadthCm ?? undefined,
          heightCm: pkg.heightCm ?? undefined,
          contents: pkg.contents ?? undefined,
        })),
      });

      if (charges.length > 0) {
        await tx.shipmentCharge.createMany({
          data: charges.map((charge, index) => ({
            shipmentId: shipment.id,
            chargeTypeId: charge.chargeTypeId,
            basis: charge.basis,
            rate: charge.rate,
            quantity: charge.quantity,
            amount: charge.amount,
            taxRateId: charge.taxRateId ?? undefined,
            taxPercent: charge.taxPercent ?? undefined,
            taxAmount: new Decimal(charge.amount)
              .times(charge.taxPercent ?? 0)
              .dividedBy(100)
              .toFixed(2),
            isManual: charge.isManual ?? true,
            remarks: charge.remarks ?? undefined,
            sortOrder: index * 10,
          })),
        });
      }

      // ── Rating ────────────────────────────────────────────
      // Charges supplied by the caller win: the bulk importer and the
      // partner API carry agreed prices, and a rate card must not
      // silently overwrite them. Everything else is priced here.
      if (charges.length === 0) {
        const priced = await priceShipmentForBooking(
          shipment.id,
          actor.orgId,
          tx,
        );

        if (priced) {
          if (priced.lines.length > 0) {
            await tx.shipmentCharge.createMany({
              data: priced.lines.map((line, index) => ({
                shipmentId: shipment.id,
                chargeTypeId: line.chargeTypeId,
                basis: line.basis as BookingChargeInput["basis"],
                rate: line.rate.toFixed(4),
                quantity: line.quantity.toFixed(3),
                amount: line.amount.toFixed(2),
                taxRateId: line.taxRateId ?? undefined,
                taxPercent: line.taxPercent.toFixed(3),
                taxAmount: line.amount
                  .times(line.taxPercent)
                  .dividedBy(100)
                  .toFixed(2),
                // Priced by the engine, not typed by a clerk.
                isManual: false,
                sortOrder: index * 10,
              })),
            });
          }

          await tx.shipment.update({
            where: { id: shipment.id },
            data: {
              freightAmount: priced.freightAmount.toFixed(2),
              chargesTotal: priced.chargesTotal.toFixed(2),
              taxAmount: priced.taxTotal.toFixed(2),
              grandTotal: priced.total.toFixed(2),
            },
          });
        }
      }

      const event = await appendShipmentEvent(
        {
          shipmentId: shipment.id,
          eventType: "BOOKING_CREATED",
          branchId: input.bookingBranchId,
          source: input.source ?? "WEB",
          customerUserId: input.bookedByCustomerUserId ?? null,
          idempotencyKey: input.idempotencyKey ?? randomUUID(),
          payload: {
            lrNumber: shipment.lrNumber,
            mode: input.mode,
            packageCount: input.packageCount,
            chargeableWeight: weights.chargeable.toString(),
            weightBasis: weights.basis,
            paymentType: input.paymentType,
            grandTotal: freight.plus(tax).toFixed(2),
            isOda: destination.isOda,
          },
        },
        actor,
        tx,
      );

      if (!event.ok) {
        // Rolls the whole booking back — no orphaned shipment without an
        // opening event, which would break the timeline permanently.
        throw new Error(event.error);
      }

      return { shipmentId: shipment.id, lrNumber: shipment.lrNumber, barcodes };
    });

    return { ok: true, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("Unique constraint")) {
      return {
        ok: false,
        error: "That booking appears to have been saved already. Refresh and check before retrying.",
      };
    }

    console.error("[booking] failed", error);
    return { ok: false, error: message || "Booking failed. Nothing was saved." };
  }
}
