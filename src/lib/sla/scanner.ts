import { prisma } from "@/lib/prisma";
import { onOutbox, enqueueOutbox } from "@/server/services/outbox";
import { raiseException } from "@/lib/exceptions/service";
import { KIND_DEFS, LIVE_STATUSES } from "@/lib/exceptions/kinds";
import { runDetectorScan, type DetectorResult } from "./detector-scan";
import type {
  ExceptionKind,
  ShipmentStatus,
  SlaState,
} from "@/generated/prisma/client";
import {
  evaluateSlaState,
  formatDuration,
  planSla,
  varianceMinutes,
  type LaneKey,
  type PolicyCandidate,
  type SlaPlan,
  type WorkingCalendar,
} from "./policy";

/**
 * The SLA scanner.
 *
 * Runs every few minutes over every shipment that has not yet settled:
 * resolves the policy, computes the promise on the branch's working
 * calendar, writes `ShipmentSla`, opens exceptions when a shipment goes
 * at risk or breaches, and walks the escalation ladder for anything
 * nobody has touched.
 *
 * The whole thing is built to be run again. `ShipmentSla` is keyed on the
 * shipment and upserted; `Exception.dedupeKey` is unique and derived from
 * the problem rather than the moment. Running the scan twice in a row
 * therefore changes nothing the second time — which matters, because it
 * runs about five hundred times a day and any drift compounds.
 */

// ────────────────────────────────────────────────────────────
// Population
// ────────────────────────────────────────────────────────────

/** Never measured: no goods moved, so there is no promise to keep. */
const OUT_OF_SCOPE: ShipmentStatus[] = ["CANCELLED", "LOST"];

const DEFAULT_BATCH = 500;
const DEFAULT_MAX_SHIPMENTS = 5_000;
const ESCALATION_BATCH = 200;

/**
 * Hours a consignment may sit at a hub before the dwell is what is wrong
 * with it. Only used to phrase a breach reason, not to raise the dwell
 * exception itself.
 */
const DWELL_HOURS = 24;

export type ScanOptions = {
  /** Override the clock. Tests and replays supply it. */
  now?: Date;
  /** Rows per query. The scan pages; it never loads the network at once. */
  batchSize?: number;
  /** Ceiling for one pass, so a backlog cannot monopolise the process. */
  maxShipments?: number;
  /** Restrict to one shipment — used by the event-driven recompute. */
  shipmentId?: string;
};

export type ScanResult = {
  scanned: number;
  scheduled: number;
  notApplicable: number;
  settled: number;
  atRisk: number;
  breached: number;
  exceptionsOpened: number;
  escalated: number;
  /**
   * Hub dwell, pending POD and COD shortfall, which ride the same sweep.
   * Counted separately so a summary line can say which monitor is noisy.
   */
  detectors: DetectorResult;
  durationMs: number;
};

const NO_DETECTIONS: DetectorResult = {
  hubDwell: 0,
  pendingPod: 0,
  codShortfall: 0,
};

// ────────────────────────────────────────────────────────────
// Reference data, loaded once per pass
// ────────────────────────────────────────────────────────────

type CalendarCache = Map<string, WorkingCalendar>;

async function loadPolicies(orgIds: string[]): Promise<Map<string, PolicyCandidate[]>> {
  const rows = await prisma.slaPolicy.findMany({
    where: { orgId: { in: orgIds }, isActive: true },
  });

  const byOrg = new Map<string, PolicyCandidate[]>();
  for (const row of rows) {
    const list = byOrg.get(row.orgId) ?? [];
    list.push({
      id: row.id,
      code: row.code,
      name: row.name,
      serviceTypeId: row.serviceTypeId,
      originCityId: row.originCityId,
      destinationCityId: row.destinationCityId,
      originZoneId: row.originZoneId,
      destinationZoneId: row.destinationZoneId,
      transitHours: row.transitHours,
      useWorkingHours: row.useWorkingHours,
      respectCutoff: row.respectCutoff,
      atRiskPercent: row.atRiskPercent,
      priority: row.priority,
      isActive: row.isActive,
    });
    byOrg.set(row.orgId, list);
  }
  return byOrg;
}

/**
 * Branch calendars, including holidays.
 *
 * Holidays are fetched from a year ago rather than from today: a shipment
 * whose clock started last month must be measured against the calendar
 * that applied then, and dropping past holidays would silently shorten
 * its transit window on re-scan.
 */
async function loadCalendars(
  branchIds: string[],
  now: Date,
): Promise<CalendarCache> {
  const cache: CalendarCache = new Map();
  if (branchIds.length === 0) return cache;

  const horizon = new Date(now.getTime() - 365 * 86_400_000);

  const [branches, holidays] = await Promise.all([
    prisma.branch.findMany({
      where: { id: { in: branchIds } },
      select: {
        id: true,
        openingTime: true,
        closingTime: true,
        bookingCutoff: true,
        weeklyOffDays: true,
      },
    }),
    prisma.branchHoliday.findMany({
      where: { branchId: { in: branchIds }, date: { gte: horizon } },
      select: { branchId: true, date: true },
    }),
  ]);

  const holidaysByBranch = new Map<string, string[]>();
  for (const row of holidays) {
    const list = holidaysByBranch.get(row.branchId) ?? [];
    // `@db.Date` comes back as midnight UTC, so the UTC components are the
    // calendar date as stored. Reading it in local time would move the
    // holiday by a day for anyone west of Greenwich.
    list.push(row.date.toISOString().slice(0, 10));
    holidaysByBranch.set(row.branchId, list);
  }

  for (const branch of branches) {
    cache.set(branch.id, {
      openingTime: branch.openingTime,
      closingTime: branch.closingTime,
      bookingCutoff: branch.bookingCutoff,
      weeklyOffDays: branch.weeklyOffDays,
      holidays: holidaysByBranch.get(branch.id) ?? [],
    });
  }

  return cache;
}

/** Pincode → the zones it belongs to. A pincode may sit in several. */
async function loadZones(codes: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (codes.length === 0) return map;

  const rows = await prisma.zonePincode.findMany({
    where: { pincode: { code: { in: codes } } },
    select: { zoneId: true, pincode: { select: { code: true } } },
  });

  for (const row of rows) {
    const list = map.get(row.pincode.code) ?? [];
    list.push(row.zoneId);
    map.set(row.pincode.code, list);
  }
  return map;
}

// ────────────────────────────────────────────────────────────
// The pass
// ────────────────────────────────────────────────────────────

type ScanRow = {
  id: string;
  orgId: string;
  lrNumber: string;
  serviceTypeId: string;
  currentStatus: ShipmentStatus;
  originBranchId: string;
  destinationBranchId: string;
  currentBranchId: string | null;
  consignorCityId: string;
  consigneeCityId: string;
  consignorPincode: string;
  consigneePincode: string;
  bookedAt: Date;
  pickedUpAt: Date | null;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  statusUpdatedAt: Date;
  attemptCount: number;
  sla: {
    state: SlaState;
    policyId: string | null;
    breachReason: string | null;
    escalationLevel: number;
  } | null;
};

const SELECT = {
  id: true,
  orgId: true,
  lrNumber: true,
  serviceTypeId: true,
  currentStatus: true,
  originBranchId: true,
  destinationBranchId: true,
  currentBranchId: true,
  consignorCityId: true,
  consigneeCityId: true,
  consignorPincode: true,
  consigneePincode: true,
  bookedAt: true,
  pickedUpAt: true,
  dispatchedAt: true,
  deliveredAt: true,
  statusUpdatedAt: true,
  attemptCount: true,
  sla: {
    select: {
      state: true,
      policyId: true,
      breachReason: true,
      escalationLevel: true,
    },
  },
} as const;

/**
 * One scanning pass.
 *
 * Pages by primary key rather than by offset: the population shifts under
 * the scan as shipments settle, and an offset walk would skip rows.
 */
export async function runSlaScan(options: ScanOptions = {}): Promise<ScanResult> {
  const startedAtMs = Date.now();
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const maxShipments = options.maxShipments ?? DEFAULT_MAX_SHIPMENTS;

  const result: ScanResult = {
    scanned: 0,
    scheduled: 0,
    notApplicable: 0,
    settled: 0,
    atRisk: 0,
    breached: 0,
    exceptionsOpened: 0,
    escalated: 0,
    detectors: { ...NO_DETECTIONS },
    durationMs: 0,
  };

  let cursor: string | undefined;

  for (;;) {
    const rows: ScanRow[] = await prisma.shipment.findMany({
      where: options.shipmentId
        ? { id: options.shipmentId }
        : {
            deletedAt: null,
            currentStatus: { notIn: OUT_OF_SCOPE },
            // Once settled there is nothing left to measure, so the pass
            // stops looking at it. This is what keeps the scan's cost
            // proportional to open work rather than to history.
            OR: [{ sla: { is: null } }, { sla: { settledAt: null } }],
          },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: SELECT,
    });

    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    await processBatch(rows, now, result);

    if (options.shipmentId) break;
    if (result.scanned >= maxShipments) break;
    if (rows.length < batchSize) break;
  }

  if (!options.shipmentId) {
    // The other three §A.11 detectors ride this sweep rather than a timer
    // of their own: one schedule to reason about, one place to look when
    // the tower goes quiet, and no chance of half the monitors surviving
    // a restart that killed the other half.
    //
    // A detector that throws must not cost us the escalation ladder, and
    // vice versa — they are independent jobs that happen to share a tick.
    try {
      result.detectors = await runDetectorScan({ now });
    } catch (error) {
      console.error("[sla] detectors failed", error);
    }

    result.escalated = await runEscalation(now);
  }

  result.durationMs = Date.now() - startedAtMs;
  return result;
}

async function processBatch(
  rows: ScanRow[],
  now: Date,
  result: ScanResult,
): Promise<void> {
  const [policiesByOrg, calendars, zones] = await Promise.all([
    loadPolicies([...new Set(rows.map((r) => r.orgId))]),
    loadCalendars([...new Set(rows.map((r) => r.originBranchId))], now),
    loadZones([
      ...new Set(rows.flatMap((r) => [r.consignorPincode, r.consigneePincode])),
    ]),
  ]);

  for (const row of rows) {
    result.scanned++;

    const lane: LaneKey = {
      serviceTypeId: row.serviceTypeId,
      originCityId: row.consignorCityId,
      destinationCityId: row.consigneeCityId,
      originZoneIds: zones.get(row.consignorPincode) ?? [],
      destinationZoneIds: zones.get(row.consigneePincode) ?? [],
    };

    // Pickup, or booking when there was none. The clock re-bases when the
    // pickup lands, because §A.17 defines transit as pickup → delivery;
    // a collection that never happened is a pickup failure, and pinning
    // it on the transit promise would blame the wrong branch.
    const clockStart = row.pickedUpAt ?? row.bookedAt;

    const plan = planSla({
      startedAt: clockStart,
      lane,
      policies: policiesByOrg.get(row.orgId) ?? [],
      calendar: calendars.get(row.originBranchId),
    });

    if (plan.state === "NOT_APPLICABLE") {
      result.notApplicable++;
      await writeNotApplicable(row, clockStart, plan);
      continue;
    }

    result.scheduled++;
    await applyPlan(row, plan, now, result);
  }
}

/**
 * Records a shipment nobody promised anything about.
 *
 * Written rather than skipped: "we never had an SLA for this lane" is an
 * answer, and it is the answer that gets the missing policy created. A
 * blank row just looks like the scanner is broken.
 */
async function writeNotApplicable(
  row: ScanRow,
  clockStart: Date,
  plan: Extract<SlaPlan, { state: "NOT_APPLICABLE" }>,
): Promise<void> {
  // A shipment that already breached does not become unmeasured because
  // somebody deactivated the policy afterwards. History stands.
  if (row.sla?.state === "BREACHED") return;

  await prisma.shipmentSla.upsert({
    where: { shipmentId: row.id },
    create: {
      shipmentId: row.id,
      state: "NOT_APPLICABLE",
      startedAt: clockStart,
      dueAt: clockStart,
      breachReason: plan.reason,
    },
    update: {
      state: "NOT_APPLICABLE",
      policyId: null,
      startedAt: clockStart,
      dueAt: clockStart,
      atRiskAt: null,
      breachReason: plan.reason,
    },
  });
}

async function applyPlan(
  row: ScanRow,
  plan: Extract<SlaPlan, { state: "SCHEDULED" }>,
  now: Date,
  result: ScanResult,
): Promise<void> {
  const settledAt = settlementFor(row);
  const state = evaluateSlaState(
    { dueAt: plan.dueAt, atRiskAt: plan.atRiskAt, settledAt },
    now,
  );

  const variance = varianceMinutes(plan.dueAt, settledAt ?? now);

  // Only worked out when the state is bad and nothing has been recorded
  // yet — inference reads the event log, and doing that for every open
  // shipment on every pass would be the scan's whole cost.
  const needsReason = state === "BREACHED" && !row.sla?.breachReason;
  const breachReason = needsReason
    ? await inferBreachReason(row, plan.dueAt, now)
    : (row.sla?.breachReason ?? null);

  await prisma.shipmentSla.upsert({
    where: { shipmentId: row.id },
    create: {
      shipmentId: row.id,
      policyId: plan.policyId,
      state,
      startedAt: plan.startedAt,
      dueAt: plan.dueAt,
      atRiskAt: plan.atRiskAt,
      settledAt,
      varianceMinutes: variance,
      breachReason,
    },
    update: {
      policyId: plan.policyId,
      state,
      startedAt: plan.startedAt,
      dueAt: plan.dueAt,
      atRiskAt: plan.atRiskAt,
      settledAt,
      varianceMinutes: variance,
      breachReason,
    },
  });

  if (settledAt) result.settled++;

  if (state === "AT_RISK") {
    result.atRisk++;
    if (await openSlaException(row, "SLA_AT_RISK", plan.dueAt, null, now)) {
      result.exceptionsOpened++;
    }
  }

  if (state === "BREACHED") {
    result.breached++;
    if (
      await openSlaException(row, "SLA_BREACHED", plan.dueAt, breachReason, now)
    ) {
      result.exceptionsOpened++;
    }
  }
}

/** When the promise stopped running. Null while the shipment is still owed. */
function settlementFor(row: ScanRow): Date | null {
  if (row.deliveredAt) return row.deliveredAt;

  // A consignment returned to origin was never delivered. Settling it at
  // the moment the return completed is what stops it breaching forever,
  // and the comparison against the original promise still says — quite
  // correctly — that the promise was not kept.
  if (row.currentStatus === "RTO_DELIVERED") return row.statusUpdatedAt;

  return null;
}

// ────────────────────────────────────────────────────────────
// Why it broke
// ────────────────────────────────────────────────────────────

/** What the event log says happened, reduced to what the rules need. */
export type BreachFacts = {
  /** FAILED delivery attempts, as `Shipment.attemptCount` counts them. */
  attemptCount: number;
  dispatchedAt: Date | null;
  dueAt: Date;
  now: Date;
  /** Most recent arrival at a branch, from the event log. */
  lastArrival: { at: Date; branchCode: string; isDestination: boolean } | null;
  /** First gate-out, if the consignment ever left origin. */
  firstDeparture: Date | null;
};

/**
 * The obvious cause, or nothing.
 *
 * Pure, and deliberately conservative. Where the log does not explain it
 * the reason stays blank, because a guessed cause is worse than an
 * admitted gap: somebody will act on it, and they will act at the wrong
 * branch.
 *
 * The ordering is the argument. Failed attempts win because they are the
 * cause closest to the missed date and the one the destination branch can
 * actually answer for; a hub dwell three days earlier is real, but naming
 * it would send the investigation to a hub that has long since let the
 * consignment go.
 */
export function breachReasonFrom(facts: BreachFacts): string | null {
  if (facts.attemptCount > 0) {
    return facts.attemptCount === 1
      ? "Delivery attempted once and failed"
      : `Delivery attempted ${facts.attemptCount} times and failed`;
  }

  if (!facts.dispatchedAt) return "Never dispatched from origin";

  if (facts.dispatchedAt.getTime() > facts.dueAt.getTime()) {
    return "Late dispatch — left origin after the promised delivery time";
  }

  if (facts.lastArrival) {
    const dwellMinutes =
      (facts.now.getTime() - facts.lastArrival.at.getTime()) / 60_000;

    if (dwellMinutes >= DWELL_HOURS * 60) {
      const where = facts.lastArrival.isDestination
        ? "destination branch"
        : `hub ${facts.lastArrival.branchCode}`;
      return `Held at ${where} for ${formatDuration(dwellMinutes)}`;
    }
  }

  // Left origin inside the last hour before it was due: the run itself
  // never had time to finish, whatever happened afterwards.
  if (
    facts.firstDeparture &&
    facts.firstDeparture.getTime() > facts.dueAt.getTime() - 3_600_000
  ) {
    return "Late dispatch from origin";
  }

  return null;
}

/**
 * Gathers the facts from the event log and applies the rules above.
 *
 * Only called for a shipment that has just gone breached and has no
 * reason recorded — reading the log for every open shipment on every pass
 * would be the whole cost of the scan.
 */
export async function inferBreachReason(
  row: Pick<
    ScanRow,
    | "id"
    | "attemptCount"
    | "dispatchedAt"
    | "currentBranchId"
    | "destinationBranchId"
    | "currentStatus"
  >,
  dueAt: Date,
  now: Date,
): Promise<string | null> {
  // The two cheap rules need no query at all, so they are checked before
  // the log is touched.
  const withoutLog = breachReasonFrom({
    attemptCount: row.attemptCount,
    dispatchedAt: row.dispatchedAt,
    dueAt,
    now,
    lastArrival: null,
    firstDeparture: null,
  });
  if (withoutLog) return withoutLog;

  const [lastArrival, departure] = await Promise.all([
    prisma.shipmentEvent.findFirst({
      where: {
        shipmentId: row.id,
        eventType: { in: ["INBOUND_SCAN", "GATE_IN", "UNLOADED"] },
      },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true, branch: { select: { id: true, code: true } } },
    }),
    prisma.shipmentEvent.findFirst({
      where: { shipmentId: row.id, eventType: "GATE_OUT" },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
  ]);

  return breachReasonFrom({
    attemptCount: row.attemptCount,
    dispatchedAt: row.dispatchedAt,
    dueAt,
    now,
    lastArrival: lastArrival?.branch
      ? {
          at: lastArrival.occurredAt,
          branchCode: lastArrival.branch.code,
          isDestination: lastArrival.branch.id === row.destinationBranchId,
        }
      : null,
    firstDeparture: departure?.occurredAt ?? null,
  });
}

/**
 * The key that makes the scanner idempotent.
 *
 * Names the problem — this shipment, this kind — not the moment it was
 * noticed. The unique index on the column does the rest: the hundredth
 * pass over a breached shipment finds the key taken and does nothing, and
 * the exception keeps the timestamp of the first detection, which is the
 * one the ageing column should show.
 */
export function slaDedupeKey(
  kind: Extract<ExceptionKind, "SLA_AT_RISK" | "SLA_BREACHED">,
  shipmentId: string,
): string {
  return `sla:${kind}:${shipmentId}`;
}

// ────────────────────────────────────────────────────────────
// Exceptions
// ────────────────────────────────────────────────────────────

/**
 * Opens the SLA exception for a shipment, once and once only.
 *
 * The dedupe key names the problem — this shipment, this kind — not the
 * moment it was noticed. That is the whole idempotency guarantee: the
 * hundredth pass over a breached shipment finds the key taken and does
 * nothing, and the row keeps the timestamp of the first detection, which
 * is the one the ageing column should show.
 */
async function openSlaException(
  row: ScanRow,
  kind: Extract<ExceptionKind, "SLA_AT_RISK" | "SLA_BREACHED">,
  dueAt: Date,
  breachReason: string | null,
  now: Date,
): Promise<boolean> {
  const late = kind === "SLA_BREACHED";

  const overdue = late
    ? formatDuration(Math.abs(varianceMinutes(dueAt, now)))
    : formatDuration(Math.abs(varianceMinutes(now, dueAt)));

  const { created } = await raiseException({
    orgId: row.orgId,
    kind,
    dedupeKey: slaDedupeKey(kind, row.id),
    title: late
      ? `${row.lrNumber} breached its SLA by ${overdue}`
      : `${row.lrNumber} is at risk — ${overdue} left`,
    detail: breachReason ?? undefined,
    shipmentId: row.id,
    branchId: row.currentBranchId ?? row.originBranchId,
    // At risk is the origin branch's to chase; a breach has already
    // happened and belongs to whoever is holding the goods.
    ownerBranchId: late
      ? (row.currentBranchId ?? row.destinationBranchId)
      : row.originBranchId,
    priority: KIND_DEFS[kind].priority,
    detectedAt: now,
    source: "sla-scanner",
  });

  return created;
}

// ────────────────────────────────────────────────────────────
// The escalation ladder
// ────────────────────────────────────────────────────────────

/**
 * Moves untouched exceptions up the ladder.
 *
 * A level fires `afterMinutes` from *detection*, not from the previous
 * level, so the ladder describes total tolerance rather than a chain of
 * relative delays — which is how §A.11 states it ("2 h → regional") and
 * how anyone reading the rule expects it to behave.
 */
export async function runEscalation(now: Date): Promise<number> {
  const due = await prisma.exception.findMany({
    where: {
      status: { in: LIVE_STATUSES },
      escalateAt: { not: null, lte: now },
    },
    orderBy: { escalateAt: "asc" },
    take: ESCALATION_BATCH,
    select: {
      id: true,
      orgId: true,
      number: true,
      kind: true,
      shipmentId: true,
      escalationLevel: true,
      detectedAt: true,
      ownerBranchId: true,
      title: true,
    },
  });

  if (due.length === 0) return 0;

  const rules = await prisma.escalationRule.findMany({
    where: {
      orgId: { in: [...new Set(due.map((e) => e.orgId))] },
      kind: { in: [...new Set(due.map((e) => e.kind))] },
      isActive: true,
    },
    orderBy: { level: "asc" },
  });

  let escalated = 0;

  for (const exception of due) {
    const ladder = rules.filter(
      (rule) => rule.orgId === exception.orgId && rule.kind === exception.kind,
    );

    const nextLevel = exception.escalationLevel + 1;
    const rule = ladder.find((r) => r.level === nextLevel);

    if (!rule) {
      // Top of the ladder, or no ladder configured. Clearing `escalateAt`
      // stops this row being re-read every three minutes forever; it stays
      // open and visible, it just has nowhere further to go.
      await prisma.exception.update({
        where: { id: exception.id },
        data: { escalateAt: null },
      });
      continue;
    }

    const following = ladder.find((r) => r.level === nextLevel + 1);

    await prisma.$transaction(async (tx) => {
      await tx.exception.update({
        where: { id: exception.id },
        data: {
          escalationLevel: nextLevel,
          escalateAt: following
            ? new Date(
                exception.detectedAt.getTime() + following.afterMinutes * 60_000,
              )
            : null,
        },
      });

      await tx.exceptionAction.create({
        data: {
          exceptionId: exception.id,
          action: "ESCALATED",
          note: `Escalated to level ${nextLevel}${rule.notifyRoleCode ? ` — ${rule.notifyRoleCode}` : ""}. Nobody had acted after ${formatDuration(rule.afterMinutes)}.`,
        },
      });

      if (exception.shipmentId) {
        await tx.shipmentSla.updateMany({
          where: { shipmentId: exception.shipmentId },
          data: { escalatedAt: now, escalationLevel: nextLevel },
        });
      }

      await enqueueOutbox(
        {
          eventType: "exception.escalated",
          aggregate: "Exception",
          aggregateId: exception.id,
          payload: {
            number: exception.number,
            kind: exception.kind,
            level: nextLevel,
            title: exception.title,
            notifyRoleCode: rule.notifyRoleCode,
            notifyUserId: rule.notifyUserId,
            ownerBranchId: exception.ownerBranchId,
          },
        },
        tx,
      );
    });

    escalated++;
  }

  return escalated;
}

// ────────────────────────────────────────────────────────────
// Wiring
// ────────────────────────────────────────────────────────────

const globalForScanner = globalThis as unknown as {
  slaScannerTimer: NodeJS.Timeout | undefined;
  slaScannerRegistered: boolean | undefined;
  slaScanInFlight: boolean | undefined;
};

/** Events after which a shipment's promise materially changes. */
const RECOMPUTE_ON = new Set([
  "shipment.booking_created",
  "shipment.booking_amended",
  "shipment.pickup_completed",
  "shipment.delivered",
  "shipment.delivery_attempted",
  "shipment.rto_initiated",
  "shipment.cancelled",
  "shipment.status_corrected",
]);

/**
 * Subscribes the scanner to the outbox.
 *
 * The sweep alone would do, eventually. Reacting to the event as well is
 * what makes a shipment show a due date on the timeline the moment it is
 * booked, rather than up to three minutes later — and "the SLA column is
 * blank on new bookings" is a bug report nobody should have to file.
 */
export function registerSlaScanner(): void {
  if (globalForScanner.slaScannerRegistered) return;
  globalForScanner.slaScannerRegistered = true;

  onOutbox("shipment.*", async (event) => {
    if (!RECOMPUTE_ON.has(event.eventType)) return;

    try {
      await runSlaScan({ shipmentId: event.aggregateId });
    } catch (error) {
      // An SLA recompute must never fail the outbox row that carried a
      // delivery notification. The sweep will pick it up.
      console.error("[sla] recompute failed", {
        shipmentId: event.aggregateId,
        error: error instanceof Error ? error.message : error,
      });
    }
  });
}

const SCAN_INTERVAL_MS = 180_000;

/**
 * Starts the in-process sweep. Safe to call repeatedly.
 *
 * Like the outbox drain this becomes a BullMQ job once Redis exists on
 * the server: same `runSlaScan`, different trigger.
 */
export function startSlaScanner(): void {
  registerSlaScanner();
  if (globalForScanner.slaScannerTimer) return;

  const tick = async () => {
    // A slow pass must not overlap the next one: two scans racing on the
    // same shipment is safe, but it doubles the load exactly when the
    // network is busiest, which is the worst possible moment for it.
    if (globalForScanner.slaScanInFlight) return;
    globalForScanner.slaScanInFlight = true;

    try {
      const result = await runSlaScan();
      const detected =
        result.detectors.hubDwell +
        result.detectors.pendingPod +
        result.detectors.codShortfall;

      if (result.exceptionsOpened > 0 || result.escalated > 0 || detected > 0) {
        console.info(
          `[sla] ${result.scanned} scanned · ${result.exceptionsOpened} SLA exception(s) · ` +
            `${detected} detector exception(s) · ${result.escalated} escalated`,
        );
      }
    } catch (error) {
      console.error("[sla] scan failed", error);
    } finally {
      globalForScanner.slaScanInFlight = false;
    }
  };

  globalForScanner.slaScannerTimer = setInterval(tick, SCAN_INTERVAL_MS);
  globalForScanner.slaScannerTimer.unref?.();
}

export function stopSlaScanner(): void {
  if (!globalForScanner.slaScannerTimer) return;
  clearInterval(globalForScanner.slaScannerTimer);
  globalForScanner.slaScannerTimer = undefined;
}
