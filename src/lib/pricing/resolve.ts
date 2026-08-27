import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import {
  calculateFreight,
  type ChargeCondition,
  type FreightResult,
  type PricingChargeType,
  type PricingContext,
  type PricingRateCardVersion,
  type PricingShipment,
} from "./engine";

/**
 * Everything the freight engine needs, fetched.
 *
 * The engine itself touches no database — that is what makes it testable.
 * This module does the loading and the ordering, and hands the engine a
 * plain snapshot.
 */

export type PricingClient = Pick<
  typeof prisma,
  "chargeType" | "fuelSurchargeRule" | "rateCard" | "pincode" | "freightCalculation"
>;

export type LoadedContext = Omit<PricingContext, "at" | "volumetricDivisor">;

/**
 * Charge heads, the fuel rules, and the default tax — the parts of the
 * context that do not vary by shipment.
 */
export async function loadPricingContext(
  orgId: string,
  client: PricingClient = prisma,
): Promise<LoadedContext> {
  const [heads, fuelRules] = await Promise.all([
    client.chargeType.findMany({
      where: { isActive: true },
      include: {
        taxRate: {
          select: { id: true, code: true, ratePercent: true, isReverseCharge: true },
        },
      },
      orderBy: { sortOrder: "asc" },
    }),
    client.fuelSurchargeRule.findMany({
      where: { orgId },
      orderBy: { effectiveFrom: "desc" },
      take: 24,
    }),
  ]);

  const chargeTypes: Record<string, PricingChargeType> = {};
  for (const head of heads) {
    chargeTypes[head.id] = {
      id: head.id,
      code: head.code,
      name: head.name,
      nature: head.nature,
      isTaxable: head.isTaxable,
      isCustomerVisible: head.isCustomerVisible,
      taxRateId: head.taxRateId,
      taxCode: head.taxRate?.code ?? null,
      taxPercent: head.taxRate ? head.taxRate.ratePercent.toString() : null,
    };
  }

  // The fuel head is found by code, not configured: FSC is what every
  // charge-head seed in this system calls it, and a missing one only means
  // the org-level surcharge does not apply.
  const fuelHead = heads.find((head) => head.code === "FSC");
  const gst = heads.find((head) => head.taxRate)?.taxRate ?? null;

  return {
    chargeTypes,
    fuelChargeTypeId: fuelHead?.id ?? null,
    fuelRules: fuelRules.map((rule) => ({
      id: rule.id,
      percent: rule.percent.toString(),
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo,
    })),
    defaultTaxRateId: gst?.id ?? null,
    defaultTaxCode: gst?.code ?? null,
    defaultTaxPercent: gst ? gst.ratePercent.toString() : 0,
    stepKg: 0.5,
  };
}

/**
 * Candidate rate-card versions, most authoritative first.
 *
 * Only approved versions in force on the pricing date are returned — a
 * draft has no business pricing anything, and the engine double-checks
 * both conditions anyway so a widened query cannot quietly change a price.
 */
export async function resolveRateCards(
  options: { orgId: string; customerId?: string | null; at: Date },
  client: PricingClient = prisma,
): Promise<PricingRateCardVersion[]> {
  const cards = await client.rateCard.findMany({
    where: {
      orgId: options.orgId,
      isActive: true,
      OR: [
        ...(options.customerId ? [{ customerId: options.customerId }] : []),
        { customerId: null },
      ],
    },
    include: {
      versions: {
        where: {
          isApproved: true,
          effectiveFrom: { lte: options.at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: options.at } }],
        },
        orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
        take: 1,
        include: { slabs: true, rules: true },
      },
    },
  });

  const candidates: PricingRateCardVersion[] = [];

  for (const card of cards) {
    const version = card.versions[0];
    if (!version) continue;

    candidates.push({
      versionId: version.id,
      rateCardId: card.id,
      rateCardCode: card.code,
      rateCardName: card.name,
      scope: card.customerId ? "CUSTOMER" : "PUBLISHED",
      version: version.version,
      effectiveFrom: version.effectiveFrom,
      effectiveTo: version.effectiveTo,
      isApproved: version.isApproved,
      slabs: version.slabs.map((slab) => ({
        id: slab.id,
        serviceTypeId: slab.serviceTypeId,
        mode: slab.mode,
        originZoneId: slab.originZoneId,
        destinationZoneId: slab.destinationZoneId,
        originCityId: slab.originCityId,
        destinationCityId: slab.destinationCityId,
        vehicleTypeId: slab.vehicleTypeId,
        weightFromKg: slab.weightFromKg?.toString() ?? null,
        weightToKg: slab.weightToKg?.toString() ?? null,
        basis: slab.basis,
        rate: slab.rate.toString(),
        minimumCharge: slab.minimumCharge?.toString() ?? null,
        minimumChargeableKg: slab.minimumChargeableKg?.toString() ?? null,
        priority: slab.priority,
      })),
      rules: version.rules.map((rule) => ({
        id: rule.id,
        chargeTypeId: rule.chargeTypeId,
        basis: rule.basis,
        rate: rule.rate.toString(),
        minimumAmount: rule.minimumAmount?.toString() ?? null,
        maximumAmount: rule.maximumAmount?.toString() ?? null,
        appliesWhen: (rule.appliesWhen ?? null) as ChargeCondition | null,
        isAutomatic: rule.isAutomatic,
        sortOrder: rule.sortOrder,
      })),
    });
  }

  // Customer cards ahead of the published tariff. The engine ranks on
  // scope regardless, but a stable order keeps the trace readable.
  return candidates.sort((a, b) =>
    a.scope === b.scope ? 0 : a.scope === "CUSTOMER" ? -1 : 1,
  );
}

/** The zone sets a PIN belongs to. A PIN may sit in several. */
export async function zonesForPincode(
  code: string | null | undefined,
  client: PricingClient = prisma,
): Promise<string[]> {
  if (!code) return [];
  const pincode = await client.pincode.findUnique({
    where: { code },
    select: { zones: { select: { zoneId: true } } },
  });
  return pincode?.zones.map((z) => z.zoneId) ?? [];
}

export type PriceShipmentOptions = {
  orgId: string;
  at?: Date;
  volumetricDivisor: number;
  distanceKm?: number | null;
  detentionHours?: number | null;
  freeDetentionHours?: number | null;
  /** Reuse a context already loaded for a bill run. */
  context?: LoadedContext;
  /** Reuse candidates already resolved for this customer. */
  candidates?: PricingRateCardVersion[];
};

/**
 * Prices one shipment against live masters.
 *
 * A bill run should pass `context` and `candidates` so it loads the rate
 * card once rather than once per consignment; a single booking can leave
 * them out.
 */
export async function priceShipment(
  shipment: PricingShipment,
  options: PriceShipmentOptions,
  client: PricingClient = prisma,
): Promise<FreightResult> {
  const at = options.at ?? new Date();

  const [context, candidates] = await Promise.all([
    options.context ?? loadPricingContext(options.orgId, client),
    options.candidates ??
      resolveRateCards(
        { orgId: options.orgId, customerId: shipment.customerId, at },
        client,
      ),
  ]);

  return calculateFreight(shipment, candidates, {
    ...context,
    at,
    volumetricDivisor: options.volumetricDivisor,
    distanceKm: options.distanceKm ?? null,
    detentionHours: options.detentionHours ?? null,
    freeDetentionHours: options.freeDetentionHours ?? null,
  });
}

/** The shape `priceShipment` wants, read off a booked shipment. */
export const SHIPMENT_PRICING_SELECT = {
  id: true,
  lrNumber: true,
  mode: true,
  serviceTypeId: true,
  paymentType: true,
  consignorId: true,
  consignorCityId: true,
  consigneeCityId: true,
  consignorPincode: true,
  consigneePincode: true,
  packageCount: true,
  actualWeight: true,
  volumetricWeight: true,
  chargeableWeight: true,
  declaredValue: true,
  codAmount: true,
  isFragile: true,
  isReverseCharge: true,
  serviceType: { select: { volumetricDivisor: true } },
} satisfies Prisma.ShipmentSelect;

export type ShipmentForPricing = Prisma.ShipmentGetPayload<{
  select: typeof SHIPMENT_PRICING_SELECT;
}>;

/** Turns a stored shipment into the engine's snapshot shape. */
export async function snapshotShipment(
  shipment: ShipmentForPricing,
  client: PricingClient = prisma,
): Promise<PricingShipment> {
  const [originZoneIds, destinationZoneIds, destination] = await Promise.all([
    zonesForPincode(shipment.consignorPincode, client),
    zonesForPincode(shipment.consigneePincode, client),
    client.pincode.findUnique({
      where: { code: shipment.consigneePincode },
      select: { isOda: true },
    }),
  ]);

  return {
    id: shipment.id,
    lrNumber: shipment.lrNumber,
    mode: shipment.mode,
    serviceTypeId: shipment.serviceTypeId,
    paymentType: shipment.paymentType,
    customerId: shipment.consignorId,
    originCityId: shipment.consignorCityId,
    destinationCityId: shipment.consigneeCityId,
    originZoneIds,
    destinationZoneIds,
    packageCount: shipment.packageCount,
    actualWeight: shipment.actualWeight.toString(),
    volumetricWeight: shipment.volumetricWeight?.toString() ?? null,
    declaredValue: shipment.declaredValue?.toString() ?? null,
    codAmount: shipment.codAmount?.toString() ?? null,
    isOda: destination?.isOda ?? false,
    isFragile: shipment.isFragile,
    isReverseCharge: shipment.isReverseCharge,
  };
}

export type FreightStage = "BOOKING" | "INVOICE";

/**
 * Stores the calculation against the shipment.
 *
 * Written at booking and again at invoicing — never updated. Two rows with
 * different totals is the record of a reweigh, and overwriting the first
 * would destroy the only evidence of what the customer was originally
 * quoted.
 */
export async function storeFreightCalculation(
  input: {
    shipmentId: string;
    result: FreightResult;
    stage: FreightStage;
    userId?: string | null;
  },
  client: Pick<typeof prisma, "freightCalculation"> = prisma,
): Promise<string> {
  const { result } = input;

  const row = await client.freightCalculation.create({
    data: {
      shipmentId: input.shipmentId,
      versionId: result.selectedVersionId,
      trace: result.trace as unknown as Prisma.InputJsonValue,
      chargeableWeight: result.chargeableWeight.toFixed(3),
      freightAmount: result.freightAmount.toFixed(2),
      chargesTotal: result.chargesTotal.toFixed(2),
      taxAmount: result.taxTotal.toFixed(2),
      grandTotal: result.total.toFixed(2),
      stage: input.stage,
      createdById: input.userId ?? null,
    },
    select: { id: true },
  });

  return row.id;
}

/** Money out of Prisma, without ever going through a float. */
export function fromPrisma(value: Prisma.Decimal | null | undefined): Decimal {
  return value ? new Decimal(value.toString()) : new Decimal(0);
}
