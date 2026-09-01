import Decimal from "decimal.js";
import { businessDay } from "@/lib/time/business-day";
import {
  chargeableWeight,
  roundUpToStep,
  type Dimensions,
} from "@/lib/shipment/weight";
import type {
  ChargeBasis,
  ChargeNature,
  RateBasis,
  ShipmentMode,
  PaymentType,
} from "@/generated/prisma/client";

/**
 * The freight engine.
 *
 * A pure function with no database access of its own. It receives a
 * shipment snapshot and one or more resolved rate-card versions, and
 * returns priced lines, taxes, a total, and a trace.
 *
 * The trace is the point of this module. "Why is this ₹4,280?" has to be
 * answerable in one click, months later, without re-running anything — so
 * every rule considered is recorded, matched or skipped, with the reason.
 * `src/lib/pricing/resolve.ts` does the loading; this file does the
 * arithmetic, which is what makes it exhaustively testable.
 */

// ────────────────────────────────────────────────────────────
// Money
// ────────────────────────────────────────────────────────────

export type MoneyIn = Decimal | number | string | null | undefined;

/** Never floats. A null reads as zero, which is the only safe default. */
export function dec(value: MoneyIn): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  return value instanceof Decimal ? value : new Decimal(value);
}

/** Rupees and paise, half-up — the convention every Indian invoice uses. */
export function money(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Weights carry three places, matching Decimal(10,3) in the schema. */
export function kg(value: Decimal): Decimal {
  return value.toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}

// ────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────

export type PricingShipment = {
  /** Present once booked; absent on a quotation. */
  id?: string | null;
  lrNumber?: string | null;
  mode: ShipmentMode;
  serviceTypeId: string;
  paymentType: PaymentType;

  /** Null for a walk-in — such a shipment can only reach a published tariff. */
  customerId?: string | null;

  originCityId?: string | null;
  destinationCityId?: string | null;
  /**
   * A PIN may sit in several zone sets, so these are lists. A slab's
   * single zone matches when it appears anywhere in the list.
   */
  originZoneIds?: string[];
  destinationZoneIds?: string[];

  vehicleTypeId?: string | null;

  packageCount: number;
  actualWeight: MoneyIn;
  /** Package dimensions. Omit when volumetric weight is already known. */
  packages?: Dimensions[];
  /** Pre-computed volumetric weight, when the caller has it. */
  volumetricWeight?: MoneyIn;

  declaredValue?: MoneyIn;
  codAmount?: MoneyIn;

  /** Destination PIN is out of delivery area. */
  isOda?: boolean;
  isFragile?: boolean;
  /** GTA reverse charge: the recipient pays the tax, so we do not add it. */
  isReverseCharge?: boolean;
};

export type PricingSlab = {
  id: string;
  serviceTypeId?: string | null;
  mode?: ShipmentMode | null;
  originZoneId?: string | null;
  destinationZoneId?: string | null;
  originCityId?: string | null;
  destinationCityId?: string | null;
  vehicleTypeId?: string | null;
  /** Inclusive of from, exclusive of to. Null on either side means "open". */
  weightFromKg?: MoneyIn;
  weightToKg?: MoneyIn;
  basis: RateBasis;
  rate: MoneyIn;
  /** Floor per shipment, applied after the slab calculation. */
  minimumCharge?: MoneyIn;
  /** The card's own floor on chargeable weight. */
  minimumChargeableKg?: MoneyIn;
  priority?: number;
};

/**
 * A condition on a charge rule, stored in `ChargeRule.appliesWhen`.
 *
 * Deliberately a small closed vocabulary rather than an expression
 * language: every key here can be explained in one line on the trace,
 * which an arbitrary expression cannot.
 */
export type ChargeCondition = {
  odaOnly?: boolean;
  codOnly?: boolean;
  fragileOnly?: boolean;
  requiresDeclaredValue?: boolean;
  paymentTypes?: string[];
  modes?: string[];
  serviceTypeIds?: string[];
  destinationCityIds?: string[];
  destinationZoneIds?: string[];
  minChargeableKg?: number | string;
  maxChargeableKg?: number | string;
  minDeclaredValue?: number | string;
};

export type PricingChargeRule = {
  id: string;
  chargeTypeId: string;
  basis: ChargeBasis;
  rate: MoneyIn;
  minimumAmount?: MoneyIn;
  maximumAmount?: MoneyIn;
  appliesWhen?: ChargeCondition | null;
  isAutomatic?: boolean;
  sortOrder?: number;
};

export type PricingChargeType = {
  id: string;
  code: string;
  name: string;
  nature: ChargeNature;
  isTaxable: boolean;
  isCustomerVisible?: boolean;
  taxRateId?: string | null;
  taxCode?: string | null;
  taxPercent?: MoneyIn;
};

export type CardScope = "CUSTOMER" | "PUBLISHED";

export type PricingRateCardVersion = {
  versionId: string;
  rateCardId: string;
  rateCardCode: string;
  rateCardName?: string;
  /** Customer-specific cards outrank the published tariff, always. */
  scope: CardScope;
  version?: number;
  effectiveFrom?: Date | string | null;
  effectiveTo?: Date | string | null;
  isApproved?: boolean;
  slabs: PricingSlab[];
  rules: PricingChargeRule[];
};

/** A dated fuel surcharge; a diesel revision is a data change, not a deploy. */
export type PricingFuelRule = {
  id: string;
  percent: MoneyIn;
  effectiveFrom: Date | string;
  effectiveTo?: Date | string | null;
};

export type PricingContext = {
  /** The date the shipment prices at — booking date, not today. */
  at: Date;
  /** From the service type; decides volumetric weight. */
  volumetricDivisor: number;
  /** Billing step for chargeable weight, in kg. */
  stepKg?: number;
  /** Charge heads by id. A rule whose head is missing is skipped, loudly. */
  chargeTypes: Record<string, PricingChargeType>;
  /** Org-level fuel surcharge rules; the one effective on `at` applies. */
  fuelRules?: PricingFuelRule[];
  /** The head the org fuel surcharge posts to. */
  fuelChargeTypeId?: string | null;
  /** Applied to a taxable line whose head carries no rate of its own. */
  defaultTaxPercent?: MoneyIn;
  defaultTaxRateId?: string | null;
  defaultTaxCode?: string | null;
  /** FTL: km run, for PER_KM slabs and rules. */
  distanceKm?: MoneyIn;
  /** FTL detention, and the free time before it starts counting. */
  detentionHours?: MoneyIn;
  freeDetentionHours?: MoneyIn;
};

// ────────────────────────────────────────────────────────────
// Outputs
// ────────────────────────────────────────────────────────────

export type FreightLine = {
  chargeTypeId: string;
  chargeCode: string;
  chargeName: string;
  nature: ChargeNature;
  basis: ChargeBasis | RateBasis;
  rate: Decimal;
  quantity: Decimal;
  amount: Decimal;
  /** The slab or charge-rule id this line came from. */
  ruleId: string | null;
  isTaxable: boolean;
  taxRateId: string | null;
  taxPercent: Decimal;
};

export type FreightTax = {
  /** What prints on the invoice, e.g. "GST18 @ 18%". */
  head: string;
  taxRateId: string | null;
  ratePercent: Decimal;
  taxableValue: Decimal;
  /** The computed tax. Under reverse charge this is stated, not collected. */
  amount: Decimal;
  isReverseCharge: boolean;
};

export type TraceOutcome = "MATCHED" | "APPLIED" | "SKIPPED" | "UNAVAILABLE";

export type TraceEntry = {
  kind: "SLAB" | "CHARGE_RULE" | "FUEL" | "MINIMUM" | "TAX" | "NOTE";
  ruleId: string | null;
  label: string;
  outcome: TraceOutcome;
  /** Plain English. This is what a billing clerk reads six months later. */
  reason: string;
  /** e.g. "customer city pair" — the tier that decided the contest. */
  specificity?: string;
  rank?: number;
  detail?: Record<string, string>;
};

export type FreightTrace = {
  /** Bump when the shape changes, so old stored traces still render. */
  version: 1;
  calculatedAt: string;
  pricedOn: string;
  shipment: Record<string, string>;
  candidates: Array<{
    versionId: string;
    rateCardCode: string;
    scope: CardScope;
    version: string;
    effectiveFrom: string | null;
    effectiveTo: string | null;
  }>;
  selectedVersionId: string | null;
  selectedSlabId: string | null;
  /** Mirrored into the trace so the coverage-gap report can query stored JSON. */
  unrated: boolean;
  unratedReason: string | null;
  entries: TraceEntry[];
  /** One readable line per step of the arithmetic. */
  narrative: string[];
};

export type FreightResult = {
  chargeableWeight: Decimal;
  weightBasis: "ACTUAL" | "VOLUMETRIC" | "MINIMUM";
  actualWeight: Decimal;
  volumetricWeight: Decimal;
  lines: FreightLine[];
  taxes: FreightTax[];
  /** Base freight only — the slab line. */
  freightAmount: Decimal;
  /** Every line, freight included. */
  chargesTotal: Decimal;
  /** What is actually added to the total. Zero under reverse charge. */
  taxTotal: Decimal;
  total: Decimal;
  /**
   * No slab matched. The booking still goes through — silently pricing at
   * zero is how a lane stays unpriced for a year — but the shipment is
   * flagged for the rate-card coverage-gap report.
   */
  unrated: boolean;
  unratedReason: string | null;
  selectedVersionId: string | null;
  selectedSlabId: string | null;
  trace: FreightTrace;
};

// ────────────────────────────────────────────────────────────
// Specificity
// ────────────────────────────────────────────────────────────

export type LaneSpecificity =
  | "CITY_PAIR"
  | "CITY_ONE_SIDE"
  | "ZONE_PAIR"
  | "ZONE_ONE_SIDE"
  | "ANY";

const LANE_ORDER: LaneSpecificity[] = [
  "CITY_PAIR",
  "CITY_ONE_SIDE",
  "ZONE_PAIR",
  "ZONE_ONE_SIDE",
  "ANY",
];

const LANE_LABEL: Record<LaneSpecificity, string> = {
  CITY_PAIR: "city pair",
  CITY_ONE_SIDE: "one-sided city",
  ZONE_PAIR: "zone pair",
  ZONE_ONE_SIDE: "one-sided zone",
  ANY: "default (any lane)",
};

/**
 * Resolution order: customer-specific city pair → customer zone pair →
 * customer default → published tariff for the lane → published default.
 * First match wins.
 *
 * Rank is `scope × 10 + lane`, so no published rule can ever outrank a
 * customer rule however specific it is — which is the whole point of
 * signing a contract.
 */
export function specificityRank(scope: CardScope, lane: LaneSpecificity): number {
  return (scope === "CUSTOMER" ? 0 : 1) * 10 + LANE_ORDER.indexOf(lane);
}

export function specificityLabel(scope: CardScope, lane: LaneSpecificity): string {
  return `${scope === "CUSTOMER" ? "customer" : "published"} ${LANE_LABEL[lane]}`;
}

// ────────────────────────────────────────────────────────────
// Matching
// ────────────────────────────────────────────────────────────

type SlabMatch =
  | { ok: true; lane: LaneSpecificity }
  | { ok: false; reason: string };

function laneSpecificityOf(
  slab: PricingSlab,
  shipment: PricingShipment,
): LaneSpecificity {
  const hasOriginCity = Boolean(slab.originCityId);
  const hasDestCity = Boolean(slab.destinationCityId);
  const hasOriginZone = Boolean(slab.originZoneId);
  const hasDestZone = Boolean(slab.destinationZoneId);

  if (hasOriginCity && hasDestCity) return "CITY_PAIR";
  if (hasOriginCity || hasDestCity) return "CITY_ONE_SIDE";
  if (hasOriginZone && hasDestZone) return "ZONE_PAIR";
  if (hasOriginZone || hasDestZone) return "ZONE_ONE_SIDE";
  void shipment;
  return "ANY";
}

/**
 * Does this slab apply at all? Anything the slab pins down must match; a
 * null on the slab means "any".
 */
export function matchSlab(
  slab: PricingSlab,
  shipment: PricingShipment,
  weightKg: Decimal,
): SlabMatch {
  if (slab.serviceTypeId && slab.serviceTypeId !== shipment.serviceTypeId) {
    return { ok: false, reason: "slab is for a different service type" };
  }
  if (slab.mode && slab.mode !== shipment.mode) {
    return { ok: false, reason: `slab is for ${slab.mode}, this is ${shipment.mode}` };
  }
  if (slab.vehicleTypeId && slab.vehicleTypeId !== shipment.vehicleTypeId) {
    return { ok: false, reason: "slab is for a different vehicle type" };
  }
  if (slab.originCityId && slab.originCityId !== shipment.originCityId) {
    return { ok: false, reason: "origin city does not match" };
  }
  if (slab.destinationCityId && slab.destinationCityId !== shipment.destinationCityId) {
    return { ok: false, reason: "destination city does not match" };
  }
  if (
    slab.originZoneId &&
    !(shipment.originZoneIds ?? []).includes(slab.originZoneId)
  ) {
    return { ok: false, reason: "origin is not in the slab's zone" };
  }
  if (
    slab.destinationZoneId &&
    !(shipment.destinationZoneIds ?? []).includes(slab.destinationZoneId)
  ) {
    return { ok: false, reason: "destination is not in the slab's zone" };
  }

  // Band is inclusive of `from`, exclusive of `to`. A shipment landing
  // exactly on an edge belongs to the band that starts there — otherwise
  // 50.000 kg falls in two bands or none, and both are wrong.
  if (slab.weightFromKg !== null && slab.weightFromKg !== undefined) {
    const from = dec(slab.weightFromKg);
    if (weightKg.lessThan(from)) {
      return { ok: false, reason: `${weightKg.toFixed(3)} kg is below the ${from.toFixed(3)} kg band` };
    }
  }
  if (slab.weightToKg !== null && slab.weightToKg !== undefined) {
    const to = dec(slab.weightToKg);
    if (weightKg.greaterThanOrEqualTo(to)) {
      return { ok: false, reason: `${weightKg.toFixed(3)} kg is at or above the ${to.toFixed(3)} kg band ceiling` };
    }
  }

  return { ok: true, lane: laneSpecificityOf(slab, shipment) };
}

/** Why a charge rule did not apply, or null when it does. */
export function conditionFailure(
  condition: ChargeCondition | null | undefined,
  shipment: PricingShipment,
  weightKg: Decimal,
): string | null {
  if (!condition) return null;

  if (condition.odaOnly && !shipment.isOda) {
    return "destination is not out of delivery area";
  }
  if (condition.codOnly && shipment.paymentType !== "COD") {
    return "shipment is not COD";
  }
  if (condition.fragileOnly && !shipment.isFragile) {
    return "shipment is not marked fragile";
  }
  if (condition.requiresDeclaredValue && dec(shipment.declaredValue).lessThanOrEqualTo(0)) {
    return "no declared value on the consignment";
  }
  if (condition.paymentTypes && !condition.paymentTypes.includes(shipment.paymentType)) {
    return `payment type ${shipment.paymentType} is not in the rule's list`;
  }
  if (condition.modes && !condition.modes.includes(shipment.mode)) {
    return `mode ${shipment.mode} is not in the rule's list`;
  }
  if (condition.serviceTypeIds && !condition.serviceTypeIds.includes(shipment.serviceTypeId)) {
    return "service type is not in the rule's list";
  }
  if (
    condition.destinationCityIds &&
    !(shipment.destinationCityId && condition.destinationCityIds.includes(shipment.destinationCityId))
  ) {
    return "destination city is not in the rule's list";
  }
  if (condition.destinationZoneIds) {
    const zones = shipment.destinationZoneIds ?? [];
    if (!condition.destinationZoneIds.some((z) => zones.includes(z))) {
      return "destination zone is not in the rule's list";
    }
  }
  if (condition.minChargeableKg !== undefined) {
    const min = dec(condition.minChargeableKg);
    if (weightKg.lessThan(min)) {
      return `chargeable weight is under ${min.toFixed(3)} kg`;
    }
  }
  if (condition.maxChargeableKg !== undefined) {
    const max = dec(condition.maxChargeableKg);
    if (weightKg.greaterThan(max)) {
      return `chargeable weight is over ${max.toFixed(3)} kg`;
    }
  }
  if (condition.minDeclaredValue !== undefined) {
    const min = dec(condition.minDeclaredValue);
    if (dec(shipment.declaredValue).lessThan(min)) {
      return `declared value is under ₹${min.toFixed(2)}`;
    }
  }

  return null;
}

// ────────────────────────────────────────────────────────────
// Dates
// ────────────────────────────────────────────────────────────

/**
 * The calendar day a value falls on, on the carrier's clock.
 *
 * Not `getUTC*`. `effectiveFrom` and `effectiveTo` come out of `@db.Date`
 * columns as UTC midnight, and truncating those in UTC is right — but
 * `context.at` is an *instant*, and a booking taken at 01:00 IST is
 * 19:30 UTC the day before. Truncated in UTC it priced against yesterday's
 * tariff: a card effective from the 1st did not apply to a consignment
 * booked at one in the morning on the 1st, and the trace said the version
 * "was not in force on the pricing date" while the contract said it was.
 *
 * `businessDay` maps UTC midnight to itself, so the stored `@db.Date`
 * values are unchanged and only the instant is corrected.
 */
function asDay(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return businessDay(date);
}

/** Inclusive of from, inclusive of to — the way a contract reads. */
export function isEffectiveOn(
  at: Date,
  from: Date | string | null | undefined,
  to: Date | string | null | undefined,
): boolean {
  const day = asDay(at);
  if (!day) return false;
  const start = asDay(from);
  const end = asDay(to);
  if (start && day.getTime() < start.getTime()) return false;
  if (end && day.getTime() > end.getTime()) return false;
  return true;
}

/** The fuel rule in force on the pricing date, latest effective-from first. */
export function fuelRuleOn(
  rules: PricingFuelRule[] | undefined,
  at: Date,
): PricingFuelRule | null {
  if (!rules || rules.length === 0) return null;
  const live = rules.filter((r) => isEffectiveOn(at, r.effectiveFrom, r.effectiveTo));
  if (live.length === 0) return null;

  return live.reduce((latest, rule) => {
    const a = asDay(rule.effectiveFrom)?.getTime() ?? 0;
    const b = asDay(latest.effectiveFrom)?.getTime() ?? 0;
    return a > b ? rule : latest;
  });
}

// ────────────────────────────────────────────────────────────
// The engine
// ────────────────────────────────────────────────────────────

function quantityFor(
  basis: ChargeBasis,
  shipment: PricingShipment,
  weightKg: Decimal,
  baseFreight: Decimal,
  context: PricingContext,
): { quantity: Decimal } | { unavailable: string } {
  switch (basis) {
    case "FLAT":
      return { quantity: new Decimal(1) };
    case "PER_KG":
      return { quantity: weightKg };
    case "PER_PACKAGE":
      return { quantity: new Decimal(shipment.packageCount) };
    case "PER_KM": {
      const km = dec(context.distanceKm);
      if (km.lessThanOrEqualTo(0)) return { unavailable: "no distance recorded on the trip" };
      return { quantity: km };
    }
    case "PER_HOUR": {
      const free = dec(context.freeDetentionHours);
      const held = dec(context.detentionHours);
      const chargeable = held.minus(free);
      if (chargeable.lessThanOrEqualTo(0)) {
        return { unavailable: "no detention beyond the free time" };
      }
      return { quantity: chargeable };
    }
    case "PERCENT_OF_FREIGHT":
      return { quantity: baseFreight };
    case "PERCENT_OF_DECLARED_VALUE": {
      const value = dec(shipment.declaredValue);
      if (value.lessThanOrEqualTo(0)) return { unavailable: "no declared value" };
      return { quantity: value };
    }
    case "PERCENT_OF_COD": {
      const value = dec(shipment.codAmount);
      if (value.lessThanOrEqualTo(0)) return { unavailable: "no COD amount" };
      return { quantity: value };
    }
    default:
      return { unavailable: `unknown basis ${String(basis)}` };
  }
}

function isPercentBasis(basis: ChargeBasis): boolean {
  return (
    basis === "PERCENT_OF_FREIGHT" ||
    basis === "PERCENT_OF_DECLARED_VALUE" ||
    basis === "PERCENT_OF_COD"
  );
}

function baseFreightFor(
  slab: PricingSlab,
  shipment: PricingShipment,
  weightKg: Decimal,
  context: PricingContext,
): { amount: Decimal; quantity: Decimal; describe: string } {
  const rate = dec(slab.rate);

  switch (slab.basis) {
    case "PER_KG":
      return {
        amount: rate.times(weightKg),
        quantity: weightKg,
        describe: `${weightKg.toFixed(3)} kg × ₹${rate.toFixed(4)} per kg`,
      };
    case "PER_PACKAGE": {
      const qty = new Decimal(shipment.packageCount);
      return {
        amount: rate.times(qty),
        quantity: qty,
        describe: `${qty.toFixed(0)} package(s) × ₹${rate.toFixed(4)}`,
      };
    }
    case "PER_KM": {
      const km = dec(context.distanceKm);
      return {
        amount: rate.times(km),
        quantity: km,
        describe: `${km.toFixed(2)} km × ₹${rate.toFixed(4)} per km`,
      };
    }
    case "FLAT":
    case "PER_TRIP":
    case "PER_VEHICLE":
    default:
      return {
        amount: rate,
        quantity: new Decimal(1),
        describe: `flat ₹${rate.toFixed(4)} (${slab.basis})`,
      };
  }
}

/**
 * Prices one shipment.
 *
 * `versions` may be a single resolved version or an ordered list of
 * candidates — a customer card and the published tariff, typically. Every
 * candidate's slabs compete; the most specific wins and the trace says
 * what the others lost to.
 */
export function calculateFreight(
  shipment: PricingShipment,
  versions: PricingRateCardVersion | PricingRateCardVersion[] | null | undefined,
  context: PricingContext,
): FreightResult {
  const candidates = (
    versions == null ? [] : Array.isArray(versions) ? versions : [versions]
  ).filter((v): v is PricingRateCardVersion => Boolean(v));

  const entries: TraceEntry[] = [];
  const narrative: string[] = [];

  // ── Chargeable weight ─────────────────────────────────────
  //
  // Band matching runs on the goods as they are — actual against
  // volumetric, rounded to the billing step. A card's own floor is applied
  // *after* the slab is chosen, so a 5 kg minimum cannot drag a 2 kg parcel
  // into a different band and reprice it at the heavier rate.
  const preFloor = chargeableWeight({
    actualWeight: dec(shipment.actualWeight),
    packages: shipment.packages ?? [],
    volumetricDivisor: context.volumetricDivisor,
    stepKg: context.stepKg,
  });

  const volumetric =
    shipment.volumetricWeight !== undefined && shipment.volumetricWeight !== null
      ? kg(dec(shipment.volumetricWeight))
      : preFloor.volumetric;

  // A caller that already knows volumetric weight (the hub, after a
  // reweigh) overrides the dimension-derived figure. It still rounds to the
  // billing step, or the two paths would disagree by a few grams.
  const steppedVolumetric = kg(roundUpToStep(volumetric, context.stepKg ?? 0.5));
  const matchWeight = steppedVolumetric.greaterThan(preFloor.chargeable)
    ? steppedVolumetric
    : preFloor.chargeable;

  narrative.push(
    `Chargeable weight before any card floor: ${matchWeight.toFixed(3)} kg ` +
      `(actual ${preFloor.actual.toFixed(3)} kg, volumetric ${volumetric.toFixed(3)} kg ` +
      `at divisor ${context.volumetricDivisor}).`,
  );

  // ── Slab contest ──────────────────────────────────────────
  type Contender = {
    version: PricingRateCardVersion;
    slab: PricingSlab;
    lane: LaneSpecificity;
    rank: number;
  };

  const contenders: Contender[] = [];

  for (const version of candidates) {
    if (version.isApproved === false) {
      entries.push({
        kind: "NOTE",
        ruleId: version.versionId,
        label: `${version.rateCardCode} v${version.version ?? "?"}`,
        outcome: "SKIPPED",
        reason: "the version is still a draft and has not been approved",
      });
      continue;
    }
    if (!isEffectiveOn(context.at, version.effectiveFrom, version.effectiveTo)) {
      entries.push({
        kind: "NOTE",
        ruleId: version.versionId,
        label: `${version.rateCardCode} v${version.version ?? "?"}`,
        outcome: "SKIPPED",
        reason: "the version was not in force on the pricing date",
      });
      continue;
    }

    for (const slab of version.slabs) {
      const label = `${version.rateCardCode} slab ${slab.id}`;
      const match = matchSlab(slab, shipment, matchWeight);

      if (!match.ok) {
        entries.push({
          kind: "SLAB",
          ruleId: slab.id,
          label,
          outcome: "SKIPPED",
          reason: match.reason,
        });
        continue;
      }

      contenders.push({
        version,
        slab,
        lane: match.lane,
        rank: specificityRank(version.scope, match.lane),
      });
    }
  }

  contenders.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // A hand-set priority breaks a tie inside one tier.
    const priority = (b.slab.priority ?? 0) - (a.slab.priority ?? 0);
    if (priority !== 0) return priority;
    // Last resort: the narrower weight band, then a stable id order.
    const aFrom = dec(a.slab.weightFromKg);
    const bFrom = dec(b.slab.weightFromKg);
    if (!aFrom.equals(bFrom)) return bFrom.comparedTo(aFrom);
    return a.slab.id.localeCompare(b.slab.id);
  });

  const winner = contenders[0] ?? null;

  for (const [index, contender] of contenders.entries()) {
    const label = `${contender.version.rateCardCode} slab ${contender.slab.id}`;
    const specificity = specificityLabel(contender.version.scope, contender.lane);

    if (index === 0) {
      entries.push({
        kind: "SLAB",
        ruleId: contender.slab.id,
        label,
        outcome: "MATCHED",
        reason: `most specific match — ${specificity}`,
        specificity,
        rank: contender.rank,
        detail: {
          basis: contender.slab.basis,
          rate: dec(contender.slab.rate).toFixed(4),
          rateCard: contender.version.rateCardCode,
          version: String(contender.version.version ?? ""),
        },
      });
      continue;
    }

    entries.push({
      kind: "SLAB",
      ruleId: contender.slab.id,
      label,
      outcome: "SKIPPED",
      reason:
        `also matched, but ${specificityLabel(winner!.version.scope, winner!.lane)} ` +
        `beat ${specificity}`,
      specificity,
      rank: contender.rank,
    });
  }

  // ── Lines ─────────────────────────────────────────────────
  const lines: FreightLine[] = [];
  let baseFreight = new Decimal(0);
  let billedWeight = matchWeight;
  let unrated = false;
  let unratedReason: string | null = null;

  if (!winner) {
    unrated = true;
    unratedReason =
      candidates.length === 0
        ? "No rate card resolved for this customer or lane."
        : "No slab on any applicable rate card covers this lane and weight.";

    entries.push({
      kind: "NOTE",
      ruleId: null,
      label: "Base freight",
      outcome: "UNAVAILABLE",
      reason: unratedReason,
    });
    narrative.push(
      `${unratedReason} The shipment is marked unrated rather than priced at zero, ` +
        `and appears on the rate-card coverage-gap report.`,
    );
  } else {
    const slab = winner.slab;

    // The card's own floor on chargeable weight, applied now the slab is
    // settled.
    const floor = dec(slab.minimumChargeableKg);
    if (floor.greaterThan(billedWeight)) {
      entries.push({
        kind: "MINIMUM",
        ruleId: slab.id,
        label: "Minimum chargeable weight",
        outcome: "APPLIED",
        reason: `card floor of ${floor.toFixed(3)} kg raised the billed weight from ${billedWeight.toFixed(3)} kg`,
      });
      narrative.push(
        `Card floor raised billed weight from ${billedWeight.toFixed(3)} kg to ${floor.toFixed(3)} kg.`,
      );
      billedWeight = kg(floor);
    }

    const computed = baseFreightFor(slab, shipment, billedWeight, context);
    baseFreight = money(computed.amount);
    narrative.push(`Base freight: ${computed.describe} = ₹${baseFreight.toFixed(2)}.`);

    // Minimum charge is a floor on the shipment, applied after the slab
    // calculation — never before, or the slab rate would be meaningless.
    const minimum = dec(slab.minimumCharge);
    if (minimum.greaterThan(baseFreight)) {
      entries.push({
        kind: "MINIMUM",
        ruleId: slab.id,
        label: "Minimum charge",
        outcome: "APPLIED",
        reason: `slab calculation of ₹${baseFreight.toFixed(2)} was below the ₹${minimum.toFixed(2)} minimum`,
      });
      narrative.push(
        `Minimum charge lifted base freight from ₹${baseFreight.toFixed(2)} to ₹${minimum.toFixed(2)}.`,
      );
      baseFreight = money(minimum);
    }

    const freightHead = resolveFreightHead(context, winner.version);
    lines.push({
      chargeTypeId: freightHead.id,
      chargeCode: freightHead.code,
      chargeName: freightHead.name,
      nature: freightHead.nature,
      basis: slab.basis,
      rate: dec(slab.rate),
      quantity: computed.quantity,
      amount: baseFreight,
      ruleId: slab.id,
      isTaxable: freightHead.isTaxable,
      taxRateId: freightHead.taxRateId ?? context.defaultTaxRateId ?? null,
      taxPercent: resolveTaxPercent(freightHead, context),
    });
  }

  // ── Charge rules ──────────────────────────────────────────
  const rules = winner
    ? [...winner.version.rules].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    : [];

  let fuelHandledByCard = false;

  for (const rule of rules) {
    const head = context.chargeTypes[rule.chargeTypeId];
    const label = head ? `${head.code} — ${head.name}` : `charge rule ${rule.id}`;

    if (!head) {
      entries.push({
        kind: "CHARGE_RULE",
        ruleId: rule.id,
        label,
        outcome: "SKIPPED",
        reason: "the charge head it posts to is missing or inactive",
      });
      continue;
    }

    if (rule.isAutomatic === false) {
      entries.push({
        kind: "CHARGE_RULE",
        ruleId: rule.id,
        label,
        outcome: "SKIPPED",
        reason: "the rule is manual — a clerk adds it, the engine does not",
      });
      continue;
    }

    const failure = conditionFailure(rule.appliesWhen, shipment, billedWeight);
    if (failure) {
      entries.push({
        kind: "CHARGE_RULE",
        ruleId: rule.id,
        label,
        outcome: "SKIPPED",
        reason: failure,
      });
      continue;
    }

    const quantity = quantityFor(rule.basis, shipment, billedWeight, baseFreight, context);
    if ("unavailable" in quantity) {
      entries.push({
        kind: "CHARGE_RULE",
        ruleId: rule.id,
        label,
        outcome: "SKIPPED",
        reason: quantity.unavailable,
      });
      continue;
    }

    const rate = dec(rule.rate);
    let amount = isPercentBasis(rule.basis)
      ? quantity.quantity.times(rate).dividedBy(100)
      : quantity.quantity.times(rate);
    amount = money(amount);

    const minimum = dec(rule.minimumAmount);
    const detail: Record<string, string> = {
      basis: rule.basis,
      rate: rate.toFixed(4),
      quantity: quantity.quantity.toFixed(3),
      computed: amount.toFixed(2),
    };

    if (rule.minimumAmount !== null && rule.minimumAmount !== undefined && minimum.greaterThan(amount)) {
      detail.minimumApplied = minimum.toFixed(2);
      amount = money(minimum);
    }
    if (rule.maximumAmount !== null && rule.maximumAmount !== undefined) {
      const maximum = dec(rule.maximumAmount);
      if (amount.greaterThan(maximum)) {
        detail.maximumApplied = maximum.toFixed(2);
        amount = money(maximum);
      }
    }

    if (context.fuelChargeTypeId && rule.chargeTypeId === context.fuelChargeTypeId) {
      fuelHandledByCard = true;
    }

    lines.push({
      chargeTypeId: head.id,
      chargeCode: head.code,
      chargeName: head.name,
      nature: head.nature,
      basis: rule.basis,
      rate,
      quantity: quantity.quantity,
      amount,
      ruleId: rule.id,
      isTaxable: head.isTaxable,
      taxRateId: head.taxRateId ?? context.defaultTaxRateId ?? null,
      taxPercent: resolveTaxPercent(head, context),
    });

    entries.push({
      kind: "CHARGE_RULE",
      ruleId: rule.id,
      label,
      outcome: "APPLIED",
      reason: describeChargeRule(rule.basis, rate, quantity.quantity, amount),
      detail,
    });
    narrative.push(
      `${head.name}: ${describeChargeRule(rule.basis, rate, quantity.quantity, amount)}.`,
    );
  }

  // ── Fuel surcharge from the org-level dated rule ──────────
  //
  // The rate card wins when it prices fuel itself; otherwise the dated org
  // rule applies. Either way the trace says which, because a customer who
  // negotiated a fixed FSC will ask.
  const fuelRule = fuelRuleOn(context.fuelRules, context.at);
  const fuelHead = context.fuelChargeTypeId
    ? context.chargeTypes[context.fuelChargeTypeId]
    : undefined;

  if (fuelRule && fuelHead && !unrated) {
    if (fuelHandledByCard) {
      entries.push({
        kind: "FUEL",
        ruleId: fuelRule.id,
        label: `${fuelHead.code} — org fuel surcharge`,
        outcome: "SKIPPED",
        reason: "the rate card prices fuel itself, so the org rule does not also apply",
      });
    } else {
      const percent = dec(fuelRule.percent);
      const amount = money(baseFreight.times(percent).dividedBy(100));

      lines.push({
        chargeTypeId: fuelHead.id,
        chargeCode: fuelHead.code,
        chargeName: fuelHead.name,
        nature: fuelHead.nature,
        basis: "PERCENT_OF_FREIGHT",
        rate: percent,
        quantity: baseFreight,
        amount,
        ruleId: fuelRule.id,
        isTaxable: fuelHead.isTaxable,
        taxRateId: fuelHead.taxRateId ?? context.defaultTaxRateId ?? null,
        taxPercent: resolveTaxPercent(fuelHead, context),
      });

      entries.push({
        kind: "FUEL",
        ruleId: fuelRule.id,
        label: `${fuelHead.code} — org fuel surcharge`,
        outcome: "APPLIED",
        reason:
          `${percent.toFixed(3)}% of base freight ₹${baseFreight.toFixed(2)} = ₹${amount.toFixed(2)}`,
        detail: {
          effectiveFrom: String(fuelRule.effectiveFrom),
          percent: percent.toFixed(3),
        },
      });
      narrative.push(
        `Fuel surcharge: ${percent.toFixed(3)}% of ₹${baseFreight.toFixed(2)} = ₹${amount.toFixed(2)}.`,
      );
    }
  } else if (!fuelRule && fuelHead && !unrated && !fuelHandledByCard) {
    entries.push({
      kind: "FUEL",
      ruleId: null,
      label: `${fuelHead.code} — org fuel surcharge`,
      outcome: "UNAVAILABLE",
      reason: "no fuel surcharge rule was in force on the pricing date",
    });
  }

  // ── Totals and tax ────────────────────────────────────────
  const chargesTotal = money(
    lines.reduce((sum, line) => sum.plus(line.amount), new Decimal(0)),
  );

  const isReverseCharge = Boolean(shipment.isReverseCharge);
  const taxes = groupTaxes(lines, isReverseCharge, context);

  const computedTax = money(
    taxes.reduce((sum, tax) => sum.plus(tax.amount), new Decimal(0)),
  );
  const taxTotal = isReverseCharge ? new Decimal(0) : computedTax;

  if (isReverseCharge) {
    entries.push({
      kind: "TAX",
      ruleId: null,
      label: "Reverse charge",
      outcome: "APPLIED",
      reason:
        `GTA reverse charge: ₹${computedTax.toFixed(2)} of tax is payable by the recipient ` +
        `and is not added to the invoice total`,
    });
    narrative.push(
      `Reverse charge — tax of ₹${computedTax.toFixed(2)} is payable by the recipient, ` +
        `so it is stated on the invoice but not added to the total.`,
    );
  } else {
    for (const tax of taxes) {
      entries.push({
        kind: "TAX",
        ruleId: tax.taxRateId,
        label: tax.head,
        outcome: "APPLIED",
        reason: `${tax.ratePercent.toFixed(3)}% of ₹${tax.taxableValue.toFixed(2)} = ₹${tax.amount.toFixed(2)}`,
      });
    }
  }

  const total = money(chargesTotal.plus(taxTotal));
  narrative.push(
    `Charges ₹${chargesTotal.toFixed(2)} + tax ₹${taxTotal.toFixed(2)} = ₹${total.toFixed(2)}.`,
  );

  const trace: FreightTrace = {
    version: 1,
    calculatedAt: new Date().toISOString(),
    pricedOn: context.at.toISOString(),
    shipment: {
      lrNumber: shipment.lrNumber ?? "",
      mode: shipment.mode,
      serviceTypeId: shipment.serviceTypeId,
      paymentType: shipment.paymentType,
      customerId: shipment.customerId ?? "",
      originCityId: shipment.originCityId ?? "",
      destinationCityId: shipment.destinationCityId ?? "",
      originZoneIds: (shipment.originZoneIds ?? []).join(","),
      destinationZoneIds: (shipment.destinationZoneIds ?? []).join(","),
      packageCount: String(shipment.packageCount),
      actualWeight: dec(shipment.actualWeight).toFixed(3),
      volumetricWeight: volumetric.toFixed(3),
      chargeableWeight: billedWeight.toFixed(3),
      declaredValue: dec(shipment.declaredValue).toFixed(2),
      codAmount: dec(shipment.codAmount).toFixed(2),
      isOda: String(Boolean(shipment.isOda)),
      isReverseCharge: String(isReverseCharge),
    },
    candidates: candidates.map((v) => ({
      versionId: v.versionId,
      rateCardCode: v.rateCardCode,
      scope: v.scope,
      version: String(v.version ?? ""),
      effectiveFrom: v.effectiveFrom ? String(v.effectiveFrom) : null,
      effectiveTo: v.effectiveTo ? String(v.effectiveTo) : null,
    })),
    selectedVersionId: winner?.version.versionId ?? null,
    selectedSlabId: winner?.slab.id ?? null,
    unrated,
    unratedReason,
    entries,
    narrative,
  };

  return {
    chargeableWeight: kg(billedWeight),
    weightBasis: floorApplied(billedWeight, matchWeight) ? "MINIMUM" : preFloor.basis,
    actualWeight: preFloor.actual,
    volumetricWeight: kg(volumetric),
    lines,
    taxes,
    freightAmount: baseFreight,
    chargesTotal,
    taxTotal,
    total,
    unrated,
    unratedReason,
    selectedVersionId: winner?.version.versionId ?? null,
    selectedSlabId: winner?.slab.id ?? null,
    trace,
  };
}

function floorApplied(billed: Decimal, matched: Decimal): boolean {
  return billed.greaterThan(matched);
}

function describeChargeRule(
  basis: ChargeBasis,
  rate: Decimal,
  quantity: Decimal,
  amount: Decimal,
): string {
  if (isPercentBasis(basis)) {
    return `${rate.toFixed(3)}% of ₹${quantity.toFixed(2)} = ₹${amount.toFixed(2)}`;
  }
  return `${quantity.toFixed(3)} × ₹${rate.toFixed(4)} (${basis}) = ₹${amount.toFixed(2)}`;
}

function resolveTaxPercent(
  head: PricingChargeType,
  context: PricingContext,
): Decimal {
  if (!head.isTaxable) return new Decimal(0);
  if (head.taxPercent !== null && head.taxPercent !== undefined) {
    return dec(head.taxPercent);
  }
  return dec(context.defaultTaxPercent);
}

/**
 * The head base freight posts to.
 *
 * A rate card does not name one, so the org's FREIGHT head is used when it
 * is loaded, and a synthetic head otherwise — a missing master must not
 * stop a shipment being priced.
 */
function resolveFreightHead(
  context: PricingContext,
  version: PricingRateCardVersion,
): PricingChargeType {
  const found = Object.values(context.chargeTypes).find(
    (head) => head.nature === "FREIGHT",
  );
  if (found) return found;

  return {
    id: `synthetic:freight:${version.rateCardId}`,
    code: "FREIGHT",
    name: "Base freight",
    nature: "FREIGHT",
    isTaxable: true,
    taxRateId: context.defaultTaxRateId ?? null,
    taxPercent: context.defaultTaxPercent ?? 0,
  };
}

/** One tax line per rate, so the invoice reads the way GSTR-1 expects. */
function groupTaxes(
  lines: FreightLine[],
  isReverseCharge: boolean,
  context: PricingContext,
): FreightTax[] {
  const buckets = new Map<
    string,
    { taxRateId: string | null; percent: Decimal; taxable: Decimal }
  >();

  for (const line of lines) {
    if (!line.isTaxable) continue;
    const percent = line.taxPercent;
    if (percent.lessThanOrEqualTo(0)) continue;

    const key = `${line.taxRateId ?? "none"}:${percent.toFixed(3)}`;
    const bucket = buckets.get(key) ?? {
      taxRateId: line.taxRateId,
      percent,
      taxable: new Decimal(0),
    };
    bucket.taxable = bucket.taxable.plus(line.amount);
    buckets.set(key, bucket);
  }

  return [...buckets.values()].map((bucket) => ({
    head: `${context.defaultTaxCode ?? "GST"} @ ${bucket.percent.toFixed(2)}%`,
    taxRateId: bucket.taxRateId,
    ratePercent: bucket.percent,
    taxableValue: money(bucket.taxable),
    amount: money(bucket.taxable.times(bucket.percent).dividedBy(100)),
    isReverseCharge,
  }));
}
