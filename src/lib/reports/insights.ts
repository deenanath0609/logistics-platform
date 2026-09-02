import { Decimal } from "decimal.js";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import type { Prisma } from "@/generated/prisma/client";
import { LIVE_STATUSES, kindLabel } from "@/lib/exceptions/kinds";
import {
  averageHubDwell,
  averageTransit,
  codAgeing,
  firstAttemptDelivery,
  firstDepartureAfter,
  onTimeDelivery,
  ratio,
  truckUtilisation,
  HUB_ARRIVAL_EVENTS,
  HUB_DEPARTURE_EVENTS,
  type DeliveryFact,
  type Ratio,
} from "./kpi";
import { trendBuckets } from "./filters";
import { anyBranchScope } from "@/server/repositories/scope";
import { andWhere } from "./scope";
import type { ReportFilters } from "./types";

/**
 * Gathering the management dashboard.
 *
 * The awkward constraint here is that §A.17's KPIs are per-shipment
 * measures over a window that could hold a hundred thousand shipments,
 * and the pure functions in `kpi.ts` take facts rather than counts. The
 * resolution is one narrow projection — six columns, not sixty — capped
 * at `MAX_FACTS`, from which almost every headline, every trend point and
 * every cut is computed in memory.
 *
 * When the cap bites, the dashboard says so. A KPI silently computed from
 * the first twenty thousand of eighty thousand shipments is a KPI that
 * will be quoted in a board pack, and there is no way to tell from the
 * number that it was a sample.
 */

/** Ceiling on the per-shipment projection behind the headline KPIs. */
export const MAX_FACTS = 20_000;

/** Ceilings on the supporting samples. */
const MAX_TRIPS = 2_000;
const MAX_DWELL_LEGS = 2_000;
const MAX_COD = 5_000;

/**
 * What "damage and loss" can actually be counted from today.
 *
 * `SHORT_RECEIVED` is raised by the hub receipt when a manifest arrives
 * light. `DAMAGED` is in the catalogue with a seeded escalation ladder and
 * is raised by nothing: the only producer would be a damaged-package flag
 * at inbound scan, and `HubScan.isDamaged` has no writer, which also
 * leaves `InboundReceipt.damagedPackages` permanently zero. Counting a
 * kind nothing writes is free, and dropping it would silently change the
 * figure on the day capture lands — but the card must not claim to measure
 * damage while it cannot, so the caveat below travels with the number.
 */
export const DAMAGE_LOSS_KINDS = ["DAMAGED", "SHORT_RECEIVED"] as const;

/** Said on the card, because the label is wider than the measurement. */
export const DAMAGE_CAPTURE_CAVEAT =
  "Shortages only — nothing in the product records damage yet, so no DAMAGED exception can be raised.";


type Fact = DeliveryFact & {
  lane: string;
  branch: string;
  customer: string;
  service: string;
};

export type Cut = {
  label: string;
  /** On-time percentage for this slice. */
  value: number | null;
  /** How many deliveries it rests on — a 100% built on two is not a 100%. */
  volume: number;
};

export type TrendPoint = {
  label: string;
  onTime: number | null;
  breached: number;
  delivered: number;
};

export type Insights = {
  onTime: ReturnType<typeof onTimeDelivery>;
  /** On-time percentage for the window immediately before this one. */
  onTimePrevious: number | null;
  firstAttempt: Ratio;
  slaBreach: Ratio;
  transit: ReturnType<typeof averageTransit>;
  dwell: ReturnType<typeof averageHubDwell>;
  utilisation: ReturnType<typeof truckUtilisation>;
  damageLoss: Ratio;
  cod: { total: Decimal; count: number; oldestBucket: string | null; aged: Array<{ label: string; count: number; amount: number }> };
  openExceptions: number;
  exceptionMix: Array<{ label: string; count: number }>;
  trend: TrendPoint[];
  byLane: Cut[];
  byBranch: Cut[];
  byCustomer: Cut[];
  byService: Cut[];
  /** True when the projection hit its cap and the figures are a sample. */
  sampled: boolean;
  sampleSize: number;
  /**
   * The supporting samples that hit their own ceiling.
   *
   * Only the delivery projection used to say so. A COD ageing table built
   * from the first five thousand of eight thousand collections looks
   * exactly like a complete one, and it is the sort of figure that gets
   * read out in a cash meeting.
   */
  truncated: { cod: boolean; trips: boolean; dwell: boolean };
};

export async function gatherInsights(
  user: SessionUser,
  filters: ReportFilters,
): Promise<Insights> {
  const scope = anyBranchScope(user, [
    "originBranchId",
    "destinationBranchId",
    "currentBranchId",
  ]);

  const branchFilter = filters.branchId
    ? {
        OR: [
          { originBranchId: filters.branchId },
          { destinationBranchId: filters.branchId },
        ],
      }
    : null;

  const common = andWhere(
    { deletedAt: null },
    scope,
    branchFilter,
    filters.customerId ? { consignorId: filters.customerId } : null,
    filters.serviceTypeId ? { serviceTypeId: filters.serviceTypeId } : null,
    filters.mode ? { mode: filters.mode } : null,
  ) as Prisma.ShipmentWhereInput;

  const window = { gte: filters.from, lte: filters.to };
  const span = filters.to.getTime() - filters.from.getTime();
  const previousWindow = {
    // `lt`, not `lte`. The window is inclusive at both ends, so a `lte`
    // here put anything delivered on the boundary millisecond into both
    // periods and made the "since last period" delta wrong by that row.
    gte: new Date(filters.from.getTime() - span),
    lt: filters.from,
  };

  /**
   * The branch a reader picked, expressed against whichever model.
   *
   * Every panel on this screen sits under one filter bar, so every panel
   * has to honour it. Three of them did not — the exception mix, the
   * utilisation card and the damage numerator were scoped to the reader's
   * branches and nothing else — which put a network figure next to a
   * branch figure in the same grid, under one heading that named a branch.
   */
  const chosenBranchId = filters.branchId;

  /**
   * Open exceptions, for this reader and this branch.
   *
   * ANDed rather than spread: a chosen branch narrows the reader's scope
   * and must never replace it, or a pasted `?branchId=` for somebody
   * else's branch would answer with somebody else's exceptions.
   */
  const openExceptionWhere: Prisma.ExceptionWhereInput = {
    AND: [
      { status: { in: LIVE_STATUSES } },
      user.branchIds === null ? {} : { ownerBranchId: { in: user.branchIds } },
      chosenBranchId ? { ownerBranchId: chosenBranchId } : {},
    ],
  };

  /** The same shape for the event log, which scopes on `branchId`. */
  const eventBranchWhere: Prisma.ShipmentEventWhereInput = {
    AND: [
      { branchId: { not: null } },
      user.branchIds === null ? {} : { branchId: { in: user.branchIds } },
      chosenBranchId ? { branchId: chosenBranchId } : {},
    ],
  };

  /** And for COD, which is held at a branch. */
  const codWhere: Prisma.CodCollectionWhereInput = {
    AND: [
      { state: { not: "REMITTED" } },
      user.branchIds === null ? {} : { branchId: { in: user.branchIds } },
      chosenBranchId ? { branchId: chosenBranchId } : {},
    ],
  };

  const [
    rows,
    eligible,
    breached,
    previousMet,
    previousBreached,
    handled,
    damagedShipments,
    openExceptions,
    exceptionMix,
    trips,
    arrivals,
    codRows,
    codTotals,
  ] = await Promise.all([
    // The one projection everything else leans on. Six columns wide, so
    // twenty thousand rows is a few megabytes rather than a few hundred.
    prisma.shipment.findMany({
      where: { AND: [common, { deliveredAt: window }] },
      orderBy: { deliveredAt: "desc" },
      take: MAX_FACTS,
      select: {
        deliveredAt: true,
        pickedUpAt: true,
        attemptCount: true,
        sla: { select: { state: true } },
        originBranch: { select: { code: true } },
        destinationBranch: { select: { code: true, name: true } },
        serviceType: { select: { name: true } },
        consignor: { select: { name: true } },
        consignorName: true,
      },
    }),

    // Breach rate spans everything with a commitment, delivered or not:
    // a shipment that is late right now is a breach today, not once it
    // eventually turns up.
    prisma.shipment.count({
      where: {
        AND: [
          common,
          { bookedAt: window },
          { sla: { state: { not: "NOT_APPLICABLE" } } },
        ],
      },
    }),
    prisma.shipment.count({
      where: { AND: [common, { bookedAt: window }, { sla: { state: "BREACHED" } }] },
    }),

    prisma.shipment.count({
      where: { AND: [common, { deliveredAt: previousWindow }, { sla: { state: "MET" } }] },
    }),
    prisma.shipment.count({
      where: {
        AND: [common, { deliveredAt: previousWindow }, { sla: { state: "BREACHED" } }],
      },
    }),

    prisma.shipment.count({ where: { AND: [common, { bookedAt: window }] } }),

    // Damage and loss: consignments with a damage or shortage exception,
    // deduplicated.
    //
    // Scoped through the shipment rather than through the exception's
    // owner branch, so the numerator and the `handled` denominator below
    // count over the same population. They did not: the denominator
    // honoured the branch, customer, service and mode filters and the
    // numerator honoured none of them, so filtering to one branch divided
    // the network's shortages by that branch's bookings — a rate that can
    // and did exceed anything a rate is allowed to be.
    prisma.exception.groupBy({
      by: ["shipmentId"],
      where: {
        detectedAt: window,
        kind: { in: [...DAMAGE_LOSS_KINDS] },
        shipmentId: { not: null },
        shipment: { is: common },
      },
      _count: { _all: true },
    }),

    prisma.exception.count({ where: openExceptionWhere }),
    prisma.exception.groupBy({
      by: ["kind"],
      where: openExceptionWhere,
      _count: { _all: true },
    }),

    prisma.trip.findMany({
      where: {
        AND: [
          { createdAt: window },
          anyBranchScope(user, ["originBranchId", "destinationBranchId"]),
          chosenBranchId
            ? {
                OR: [
                  { originBranchId: chosenBranchId },
                  { destinationBranchId: chosenBranchId },
                ],
              }
            : {},
        ],
      },
      take: MAX_TRIPS,
      select: {
        manifests: { select: { totalWeight: true } },
        vehicle: {
          select: {
            vehicleType: { select: { capacityKg: true, capacityCft: true } },
          },
        },
      },
    }),

    prisma.shipmentEvent.findMany({
      where: {
        AND: [
          { occurredAt: window },
          { eventType: { in: [...HUB_ARRIVAL_EVENTS] } },
          eventBranchWhere,
        ],
      },
      orderBy: { occurredAt: "desc" },
      take: MAX_DWELL_LEGS,
      select: { shipmentId: true, occurredAt: true, branchId: true },
    }),

    prisma.codCollection.findMany({
      where: codWhere,
      orderBy: { collectedAt: "asc" },
      take: MAX_COD,
      select: { amountCollected: true, collectedAt: true },
    }),

    // The exact held total and count, whatever the ageing sample holds.
    // The card quotes a rupee figure that goes into a cash meeting; it must
    // not quietly be the first five thousand collections of eight thousand.
    prisma.codCollection.aggregate({
      where: codWhere,
      _sum: { amountCollected: true },
      _count: { _all: true },
    }),
  ]);

  const facts: Fact[] = rows.map((row) => ({
    deliveredAt: row.deliveredAt,
    pickedUpAt: row.pickedUpAt,
    attemptCount: row.attemptCount,
    slaState: row.sla?.state ?? null,
    lane: `${row.originBranch.code} → ${row.destinationBranch.code}`,
    branch: row.destinationBranch.code,
    customer: row.consignor?.name ?? row.consignorName,
    service: row.serviceType.name,
  }));

  const previousMeasured = previousMet + previousBreached;

  // Dwell: pair each arrival with the first departure after it. One extra
  // query rather than one per leg.
  const departures =
    arrivals.length === 0
      ? []
      : await prisma.shipmentEvent.findMany({
          where: {
            shipmentId: { in: [...new Set(arrivals.map((a) => a.shipmentId))] },
            eventType: { in: [...HUB_DEPARTURE_EVENTS] },
            occurredAt: { gte: filters.from },
          },
          orderBy: { occurredAt: "asc" },
          select: { shipmentId: true, occurredAt: true, branchId: true },
        });

  const legs = arrivals.map((arrival) => ({
    arrivedAt: arrival.occurredAt,
    departedAt: firstDepartureAfter(departures, arrival)?.occurredAt ?? null,
  }));

  const ageing = codAgeing(
    codRows.map((row) => ({
      amount: row.amountCollected.toString(),
      since: row.collectedAt,
    })),
    new Date(),
  );

  const oldest = [...ageing.buckets].reverse().find((bucket) => bucket.count > 0);

  return {
    onTime: onTimeDelivery(facts),
    onTimePrevious:
      previousMeasured > 0 ? ratio(previousMet, previousMeasured).percent : null,
    firstAttempt: firstAttemptDelivery(facts),
    slaBreach: ratio(breached, eligible),
    transit: averageTransit(facts),
    dwell: averageHubDwell(legs),
    utilisation: truckUtilisation(
      trips.map((trip) => ({
        loadedWeightKg: trip.manifests.reduce(
          (sum, manifest) => sum + Number(manifest.totalWeight.toString()),
          0,
        ),
        capacityKg: Number(trip.vehicle.vehicleType.capacityKg.toString()),
        capacityCft: trip.vehicle.vehicleType.capacityCft
          ? Number(trip.vehicle.vehicleType.capacityCft.toString())
          : null,
        loadedVolumeCft: null,
      })),
    ),
    damageLoss: ratio(damagedShipments.length, handled),
    cod: {
      // From the aggregate, not from the sample: the buckets below may be
      // the first `MAX_COD` collections, but the headline rupee figure is
      // every one of them.
      total: new Decimal((codTotals._sum.amountCollected ?? 0).toString()),
      count: codTotals._count._all,
      oldestBucket: oldest?.label ?? null,
      aged: ageing.buckets.map((bucket) => ({
        label: bucket.label,
        count: bucket.count,
        amount: bucket.amount.toDecimalPlaces(2).toNumber(),
      })),
    },
    openExceptions,
    exceptionMix: exceptionMix
      .map((row) => ({ label: kindLabel(row.kind), count: row._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    trend: buildTrend(facts, filters),
    byLane: cutBy(facts, (fact) => fact.lane),
    byBranch: cutBy(facts, (fact) => fact.branch),
    byCustomer: cutBy(facts, (fact) => fact.customer),
    byService: cutBy(facts, (fact) => fact.service),
    sampled: rows.length >= MAX_FACTS,
    sampleSize: rows.length,
    truncated: {
      cod: codRows.length >= MAX_COD,
      trips: trips.length >= MAX_TRIPS,
      dwell: arrivals.length >= MAX_DWELL_LEGS,
    },
  };
}

/** Deliveries and breaches per bucket across the window. */
function buildTrend(facts: Fact[], filters: ReportFilters): TrendPoint[] {
  const buckets = trendBuckets(filters);

  return buckets.map((bucket) => {
    let delivered = 0;
    let met = 0;
    let breached = 0;

    for (const fact of facts) {
      if (!fact.deliveredAt) continue;
      const at = fact.deliveredAt.getTime();
      if (at < bucket.from.getTime() || at > bucket.to.getTime()) continue;

      delivered++;
      if (fact.slaState === "MET") met++;
      else if (fact.slaState === "BREACHED") breached++;
    }

    const measured = met + breached;

    return {
      label: bucket.label,
      // Null, not zero: a day where nothing carried an SLA is a gap in
      // the line rather than a day the network scored nothing.
      onTime: measured > 0 ? ratio(met, measured).percent : null,
      breached,
      delivered,
    };
  });
}

/**
 * On-time percentage sliced by lane, branch, customer or service.
 *
 * Worst first and capped at ten: a management dashboard is for deciding
 * where to look, and eighty lanes sorted alphabetically is a decision
 * nobody makes. Slices with nothing measurable drop out entirely rather
 * than sitting at the bottom as grey noise.
 */
function cutBy(facts: Fact[], key: (fact: Fact) => string): Cut[] {
  const groups = new Map<string, { met: number; breached: number; volume: number }>();

  for (const fact of facts) {
    if (!fact.deliveredAt) continue;

    const label = key(fact) || "Unattributed";
    const group = groups.get(label) ?? { met: 0, breached: 0, volume: 0 };
    group.volume++;
    if (fact.slaState === "MET") group.met++;
    else if (fact.slaState === "BREACHED") group.breached++;
    groups.set(label, group);
  }

  return [...groups.entries()]
    .map(([label, group]) => {
      const measured = group.met + group.breached;
      return {
        label,
        value: measured > 0 ? ratio(group.met, measured).percent : null,
        volume: group.volume,
      };
    })
    .filter((cut) => cut.value !== null)
    .sort((a, b) => (a.value ?? 0) - (b.value ?? 0) || b.volume - a.volume)
    .slice(0, 10);
}
