import { Decimal } from "decimal.js";
import type { SlaState } from "@/generated/prisma/client";

/**
 * Management KPIs, exactly as docs/BRD.html §A.17 defines them.
 *
 * Pure. Every function takes the facts it needs and returns a number, so
 * each one can be checked against a fixture small enough to work out on
 * paper — which is the point. A KPI nobody can check by hand is a KPI
 * nobody will trust, and an on-time percentage a branch manager does not
 * trust is worse than no dashboard at all, because now there is an
 * argument about the number instead of about the late shipments.
 *
 * Two conventions run through the file:
 *
 *  · **An empty denominator is `null`, never zero.** "No deliveries yet"
 *    and "every delivery was late" are different facts and must not
 *    render as the same 0%.
 *  · **Money is decimal.js.** Weights and durations are ordinary numbers;
 *    rupees never are.
 */

// ────────────────────────────────────────────────────────────
// Ratios
// ────────────────────────────────────────────────────────────

export type Ratio = {
  numerator: number;
  denominator: number;
  /** 0–100, or null when there is nothing to divide by. */
  percent: number | null;
};

export function ratio(numerator: number, denominator: number): Ratio {
  return {
    numerator,
    denominator,
    percent:
      denominator > 0
        ? round2((numerator / denominator) * 100)
        : null,
  };
}

/** Two decimal places — enough to see movement, not enough to imply precision. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ────────────────────────────────────────────────────────────
// Delivery performance
// ────────────────────────────────────────────────────────────

export type DeliveryFact = {
  deliveredAt: Date | null;
  /** From `ShipmentSla`. Null when the scanner has not reached it. */
  slaState: SlaState | null;
  /**
   * FAILED delivery attempts, as `Shipment.attemptCount` counts them: the
   * state machine increments on DELIVERY_ATTEMPTED and not on DELIVERED,
   * so a consignment delivered first time carries zero. Reading this as
   * "attempts made" is the off-by-one that quietly ruins the KPI.
   */
  attemptCount: number;
  pickedUpAt: Date | null;
};

export type MeasuredRatio = Ratio & {
  /** Delivered, but with no SLA to judge them against. */
  unmeasured: number;
};

/**
 * On-time delivery %: delivered within SLA ÷ delivered.
 *
 * Only shipments the SLA engine actually measured count in the
 * denominator. A lane with no policy is excluded and reported separately
 * rather than counted as on time — inflating the headline with shipments
 * nobody promised anything about is how a 94% becomes meaningless.
 */
export function onTimeDelivery(
  facts: readonly DeliveryFact[],
): MeasuredRatio {
  let onTime = 0;
  let measured = 0;
  let unmeasured = 0;

  for (const fact of facts) {
    if (!fact.deliveredAt) continue;

    if (fact.slaState === "MET") {
      onTime++;
      measured++;
    } else if (fact.slaState === "BREACHED") {
      measured++;
    } else {
      unmeasured++;
    }
  }

  return { ...ratio(onTime, measured), unmeasured };
}

/**
 * First-attempt delivery %: delivered on attempt 1 ÷ delivered.
 *
 * The denominator is every delivery, measured or not — this one does not
 * depend on an SLA policy existing, so excluding unmeasured lanes would
 * throw away good data.
 */
export function firstAttemptDelivery(facts: readonly DeliveryFact[]): Ratio {
  let delivered = 0;
  let first = 0;

  for (const fact of facts) {
    if (!fact.deliveredAt) continue;
    delivered++;
    if (fact.attemptCount === 0) first++;
  }

  return ratio(first, delivered);
}

/**
 * SLA breach %: breached ÷ eligible.
 *
 * Eligible means "had a commitment": anything NOT_APPLICABLE, or not yet
 * scanned, is outside the measurement. Open shipments already past their
 * due time count as breached, because they are.
 */
export function slaBreachRate(
  facts: readonly Pick<DeliveryFact, "slaState">[],
): Ratio {
  let eligible = 0;
  let breached = 0;

  for (const fact of facts) {
    if (!fact.slaState || fact.slaState === "NOT_APPLICABLE") continue;
    eligible++;
    if (fact.slaState === "BREACHED") breached++;
  }

  return ratio(breached, eligible);
}

// ────────────────────────────────────────────────────────────
// Time in the network
// ────────────────────────────────────────────────────────────

/** Wall-clock minutes. The default measure for transit time. */
export function elapsedMinutes(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 60_000);
}

export type Average = {
  /** Minutes, or null when nothing could be measured. */
  averageMinutes: number | null;
  /** The middle value — far more honest than the mean on transit data. */
  medianMinutes: number | null;
  samples: number;
};

/**
 * Average transit time: pickup → delivery.
 *
 * §A.17 measures this in working hours. `measure` is an argument rather
 * than a hard-coded subtraction so the caller can pass
 * `workingTimeBetween` from the SLA calendar and get the working-hours
 * figure, and so this function stays testable without a branch calendar.
 *
 * The median comes back alongside the mean because transit data is
 * skewed: one consignment stuck for a fortnight drags a 400-shipment mean
 * somewhere no actual shipment has ever been.
 */
export function averageTransit(
  facts: readonly DeliveryFact[],
  measure: (from: Date, to: Date) => number = elapsedMinutes,
): Average {
  const samples: number[] = [];

  for (const fact of facts) {
    if (!fact.pickedUpAt || !fact.deliveredAt) continue;
    if (fact.deliveredAt.getTime() < fact.pickedUpAt.getTime()) continue;
    samples.push(measure(fact.pickedUpAt, fact.deliveredAt));
  }

  return summarise(samples);
}

export type DwellLeg = {
  /** Inbound scan at the hub. */
  arrivedAt: Date;
  /** Outbound load. Null while the consignment is still sitting there. */
  departedAt: Date | null;
};

/**
 * Hub dwell time: inbound scan → outbound load.
 *
 * Open legs are excluded by default. Including them requires a `now`,
 * and it changes what the number means — "how long things took to leave"
 * versus "how long things have been here" — so the caller has to ask.
 */
export function averageHubDwell(
  legs: readonly DwellLeg[],
  options: { includeOpen?: Date } = {},
): Average {
  const samples: number[] = [];

  for (const leg of legs) {
    const departedAt = leg.departedAt ?? options.includeOpen ?? null;
    if (!departedAt) continue;
    if (departedAt.getTime() < leg.arrivedAt.getTime()) continue;
    samples.push(elapsedMinutes(leg.arrivedAt, departedAt));
  }

  return summarise(samples);
}

function summarise(samples: number[]): Average {
  if (samples.length === 0) {
    return { averageMinutes: null, medianMinutes: null, samples: 0 };
  }

  const total = samples.reduce((sum, value) => sum + value, 0);
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return {
    averageMinutes: round2(total / samples.length),
    medianMinutes: round2(
      sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    ),
    samples: samples.length,
  };
}

// ────────────────────────────────────────────────────────────
// Vehicles
// ────────────────────────────────────────────────────────────

export type LoadFact = {
  loadedWeightKg: number;
  capacityKg: number;
  loadedVolumeCft?: number | null;
  capacityCft?: number | null;
};

export type Utilisation = {
  /** 0–100, or null when no capacity was known. */
  weightPercent: number | null;
  volumePercent: number | null;
  trips: number;
  /** Trips whose vehicle type carries no volume figure. */
  volumeUnknown: number;
};

/**
 * Truck load utilisation: loaded ÷ capacity, by weight and by volume.
 *
 * Weighted across the fleet rather than averaged per trip: two trips, one
 * full 20-tonner and one half-empty tempo, is not "75% utilised". Totals
 * divided by totals is what a transport manager means by the phrase.
 */
export function truckUtilisation(loads: readonly LoadFact[]): Utilisation {
  let loadedWeight = 0;
  let capacityWeight = 0;
  let loadedVolume = 0;
  let capacityVolume = 0;
  let volumeUnknown = 0;

  for (const load of loads) {
    if (load.capacityKg > 0) {
      loadedWeight += load.loadedWeightKg;
      capacityWeight += load.capacityKg;
    }

    if (load.capacityCft && load.capacityCft > 0) {
      loadedVolume += load.loadedVolumeCft ?? 0;
      capacityVolume += load.capacityCft;
    } else {
      volumeUnknown++;
    }
  }

  return {
    weightPercent:
      capacityWeight > 0
        ? round2((loadedWeight / capacityWeight) * 100)
        : null,
    volumePercent:
      capacityVolume > 0
        ? round2((loadedVolume / capacityVolume) * 100)
        : null,
    trips: loads.length,
    volumeUnknown,
  };
}

// ────────────────────────────────────────────────────────────
// Damage and loss
// ────────────────────────────────────────────────────────────

export type HandledFact = {
  /** Damage recorded, shortage raised, or the consignment written off. */
  hadDamageOrLoss: boolean;
};

/** Damage & loss rate: exception shipments ÷ handled. */
export function damageLossRate(facts: readonly HandledFact[]): Ratio {
  const affected = facts.filter((fact) => fact.hadDamageOrLoss).length;
  return ratio(affected, facts.length);
}

// ────────────────────────────────────────────────────────────
// Ageing
// ────────────────────────────────────────────────────────────

export type AgeingEntry = {
  /** Rupees. Anything decimal.js accepts. */
  amount: Decimal.Value;
  /** When the clock started — collection for COD, invoice date for AR. */
  since: Date;
  /** When it stopped. Null means it is still outstanding. */
  until?: Date | null;
};

export type AgeingBucket = {
  label: string;
  /** Inclusive lower bound in days. */
  fromDays: number;
  /** Inclusive upper bound, or null for the open-ended last bucket. */
  toDays: number | null;
  count: number;
  amount: Decimal;
};

/** COD is remitted in days, not months, so the buckets are days. */
export const COD_AGEING_EDGES = [1, 3, 7] as const;

/** §A.12's receivables buckets: 0–30 / 31–60 / 61–90 / 90+. */
export const RECEIVABLE_AGEING_EDGES = [30, 60, 90] as const;

/**
 * Buckets outstanding amounts by age.
 *
 * Only entries still outstanding are counted — an `until` means the money
 * arrived and has nothing left to age. Whole days elapsed, so something
 * collected this morning lands in the first bucket rather than creating a
 * phantom "-0 days".
 */
export function ageingBuckets(
  entries: readonly AgeingEntry[],
  now: Date,
  edges: readonly number[] = COD_AGEING_EDGES,
): AgeingBucket[] {
  const bounds = [...edges].sort((a, b) => a - b);

  const buckets: AgeingBucket[] = bounds.map((edge, index) => {
    const fromDays = index === 0 ? 0 : bounds[index - 1] + 1;
    return {
      label: fromDays === edge ? `${edge} d` : `${fromDays}–${edge} d`,
      fromDays,
      toDays: edge,
      count: 0,
      amount: new Decimal(0),
    };
  });

  const lastEdge = bounds[bounds.length - 1] ?? 0;
  buckets.push({
    label: `${lastEdge}+ d`,
    fromDays: lastEdge + 1,
    toDays: null,
    count: 0,
    amount: new Decimal(0),
  });

  for (const entry of entries) {
    if (entry.until) continue;

    const days = Math.max(
      0,
      Math.floor((now.getTime() - entry.since.getTime()) / 86_400_000),
    );

    const bucket =
      buckets.find(
        (candidate) =>
          days >= candidate.fromDays &&
          (candidate.toDays === null || days <= candidate.toDays),
      ) ?? buckets[buckets.length - 1];

    bucket.count++;
    bucket.amount = bucket.amount.plus(new Decimal(entry.amount));
  }

  return buckets;
}

/** COD ageing: collected but not remitted, by days. */
export function codAgeing(
  entries: readonly AgeingEntry[],
  now: Date,
): { buckets: AgeingBucket[]; total: Decimal; count: number } {
  const buckets = ageingBuckets(entries, now, COD_AGEING_EDGES);

  return {
    buckets,
    total: buckets.reduce((sum, bucket) => sum.plus(bucket.amount), new Decimal(0)),
    count: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
  };
}

// ────────────────────────────────────────────────────────────
// Reading a KPI at a glance
// ────────────────────────────────────────────────────────────

export type Grade = "good" | "watch" | "bad" | "unknown";

export type Thresholds = {
  /** At or better than this is good. */
  good: number;
  /** Worse than this is bad; between the two is worth watching. */
  watch: number;
  /** Which direction is better. On-time % is higher; breach % is lower. */
  better: "higher" | "lower";
};

/**
 * Grades a KPI so state is encoded in form as well as in the number.
 *
 * A dashboard of thirteen decimal numbers all in the same grey is a
 * dashboard nobody reads twice; the grade is what carries the meaning
 * across the room.
 */
export function gradeKpi(
  value: number | null,
  thresholds: Thresholds,
): Grade {
  if (value === null || Number.isNaN(value)) return "unknown";

  if (thresholds.better === "higher") {
    if (value >= thresholds.good) return "good";
    return value >= thresholds.watch ? "watch" : "bad";
  }

  if (value <= thresholds.good) return "good";
  return value <= thresholds.watch ? "watch" : "bad";
}

export const GRADE_TONE: Record<Grade, string> = {
  good: "bg-ok-muted text-ok",
  watch: "bg-warn-muted text-warn",
  bad: "bg-bad-muted text-bad",
  unknown: "bg-muted text-muted-foreground",
};

/** Targets used by the management dashboard. Operations owns these numbers. */
export const KPI_THRESHOLDS = {
  onTimeDelivery: { good: 95, watch: 90, better: "higher" } satisfies Thresholds,
  firstAttempt: { good: 90, watch: 80, better: "higher" } satisfies Thresholds,
  slaBreach: { good: 5, watch: 10, better: "lower" } satisfies Thresholds,
  damageLoss: { good: 0.5, watch: 2, better: "lower" } satisfies Thresholds,
  utilisation: { good: 80, watch: 65, better: "higher" } satisfies Thresholds,
} as const;

/** "18 h 20 m" for a KPI expressed in minutes. */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";

  const value = Math.round(minutes);
  if (value < 60) return `${value} m`;

  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (hours < 48) return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;

  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** "94.2%" or an em dash. Never "0%" for "nothing to measure". */
export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}
