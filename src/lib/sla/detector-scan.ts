import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import { currentOrgId } from "@/lib/tenant/context";
import { raiseException } from "@/lib/exceptions/service";
import type { ShipmentEventType, ShipmentStatus } from "@/generated/prisma/client";
import {
  DEFAULT_COD_TOLERANCE,
  DEFAULT_DWELL_THRESHOLDS,
  DEFAULT_POD_PENDING_HOURS,
  codShortfallDecision,
  dwellThresholdHours,
  hubDwellDecision,
  parseDwellThresholds,
  pendingPodDecision,
  type DetectorDecision,
  type DwellThresholds,
} from "./detectors";
import { IST_OFFSET_MINUTES, toLocal, fromLocal } from "./policy";

/**
 * The database half of the three detectors.
 *
 * Every decision in here is made by a pure function in `detectors.ts`;
 * this file only gathers facts and writes the result. Keeping the split
 * strict is what lets the boundary conditions be tested with literals
 * instead of a seeded database, and it is why the queries below can be
 * read for what they cost rather than for what they decide.
 *
 * Runs from the SLA scanner's existing sweep — see `runSlaScan`. A second
 * timer would double the failure modes and halve the chance anybody
 * notices when one of them stops.
 */

const HOUR_MS = 3_600_000;

/** Ceiling per detector per pass, so a backlog cannot monopolise a tick. */
const DETECTOR_BATCH = 300;

// ────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────

const CONFIG_KEYS = {
  dwell: "sla.hubDwellHours",
  pod: "sla.podPendingHours",
  codTolerance: "sla.codShortfallTolerance",
  codDayEnd: "sla.codDayEndHour",
} as const;

/**
 * Hour of the branch-local evening after which a delivery agent's cash is
 * expected to be in. Before it, a gap between collected and deposited is
 * just cash in a bag on a bike.
 */
export const DEFAULT_COD_DAY_END_HOUR = 22;

export type DetectorConfig = {
  dwell: DwellThresholds;
  podPendingHours: number;
  codTolerance: Decimal;
  codDayEndHour: number;
};

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  dwell: DEFAULT_DWELL_THRESHOLDS,
  podPendingHours: DEFAULT_POD_PENDING_HOURS,
  codTolerance: new Decimal(DEFAULT_COD_TOLERANCE),
  codDayEndHour: DEFAULT_COD_DAY_END_HOUR,
};

/**
 * Reads the four detector settings in one query.
 *
 * Anything missing or unparseable falls back to the documented default.
 * A settings row somebody fat-fingered must fail to change the monitor,
 * never stop it — a silent detector is indistinguishable from a network
 * with nothing wrong in it, and that is the worst failure this file has.
 */
export async function loadDetectorConfig(
  orgId: string,
): Promise<DetectorConfig> {
  const rows = await prisma.systemConfig.findMany({
    where: { orgId, key: { in: Object.values(CONFIG_KEYS) } },
    select: { key: true, value: true },
  });

  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  const positive = (raw: unknown, fallback: number): number => {
    const parsed = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const toleranceRaw = byKey.get(CONFIG_KEYS.codTolerance);
  let codTolerance = new Decimal(DEFAULT_COD_TOLERANCE);
  if (toleranceRaw !== undefined && toleranceRaw !== null) {
    try {
      const parsed = new Decimal(String(toleranceRaw));
      if (parsed.greaterThanOrEqualTo(0)) codTolerance = parsed;
    } catch {
      // Keep the default; see the note above.
    }
  }

  const dayEnd = positive(
    byKey.get(CONFIG_KEYS.codDayEnd),
    DEFAULT_COD_DAY_END_HOUR,
  );

  return {
    dwell: parseDwellThresholds(byKey.get(CONFIG_KEYS.dwell)),
    podPendingHours: positive(
      byKey.get(CONFIG_KEYS.pod),
      DEFAULT_POD_PENDING_HOURS,
    ),
    codTolerance,
    codDayEndHour: Math.min(23, Math.floor(dayEnd)),
  };
}

// ────────────────────────────────────────────────────────────
// The pass
// ────────────────────────────────────────────────────────────

export type DetectorResult = {
  hubDwell: number;
  pendingPod: number;
  codShortfall: number;
};

export type DetectorScanOptions = {
  now?: Date;
  /**
   * The organisation to sweep. Defaults to the tenant this is running as,
   * which is what the caller normally wants — the scan used to enumerate
   * organisations itself, and that loop now lives one level up in
   * `forEachTenant` so every job in the system enumerates tenants the same
   * way and each pass is genuinely confined to one.
   */
  orgId?: string;
  batchSize?: number;
};

/**
 * One pass of all three detectors, for one organisation.
 *
 * Idempotent by construction: each detector's dedupe key names the
 * problem rather than the moment, so a second pass finds every key taken
 * and opens nothing. See `detectors.test.ts`.
 */
export async function runDetectorScan(
  options: DetectorScanOptions = {},
): Promise<DetectorResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DETECTOR_BATCH;
  const orgId = options.orgId ?? currentOrgId();

  const config = await loadDetectorConfig(orgId);

  return {
    hubDwell: await detectHubDwell(orgId, config, now, batchSize),
    pendingPod: await detectPendingPod(orgId, config, now, batchSize),
    codShortfall: await detectCodShortfall(orgId, config, now),
  };
}

/** Opens the exception a decision describes. Null decisions cost nothing. */
async function open(
  orgId: string,
  decision: DetectorDecision | null,
  context: {
    shipmentId?: string | null;
    branchId?: string | null;
    ownerBranchId?: string | null;
    detectedAt: Date;
    source: string;
  },
): Promise<boolean> {
  if (!decision) return false;

  const { created } = await raiseException({
    orgId,
    kind: decision.kind,
    priority: decision.priority,
    dedupeKey: decision.dedupeKey,
    title: decision.title,
    detail: decision.detail,
    shipmentId: context.shipmentId ?? null,
    branchId: context.branchId ?? null,
    ownerBranchId: context.ownerBranchId ?? context.branchId ?? null,
    detectedAt: context.detectedAt,
    source: context.source,
  });

  return created;
}

// ────────────────────────────────────────────────────────────
// Hub dwell
// ────────────────────────────────────────────────────────────

/**
 * Statuses in which a consignment is genuinely sitting still.
 *
 * Deliberately excludes MANIFESTED, DISPATCHED and everything after: a
 * consignment on a manifest has been acted on, and dwell is about freight
 * nobody has touched. Including them would blame a hub for the line-haul
 * it is waiting for.
 */
const IDLE_AT_BRANCH: ShipmentStatus[] = [
  "RECEIVED_AT_ORIGIN",
  "PROCESSED",
  "ARRIVED_AT_HUB",
  "RECEIVED_AT_HUB",
];

/** Scans that mean "it got here". The dwell clock starts at the latest one. */
const ARRIVAL_EVENTS: ShipmentEventType[] = ["INBOUND_SCAN", "GATE_IN", "UNLOADED"];

/** Anything that means somebody has since moved it on. */
const OUTBOUND_EVENTS: ShipmentEventType[] = [
  "MANIFEST_ADDED",
  "LOADED",
  "GATE_OUT",
  "DELIVERY_ASSIGNED",
  "RUN_STARTED",
  "DELIVERED",
];

async function detectHubDwell(
  orgId: string,
  config: DetectorConfig,
  now: Date,
  batchSize: number,
): Promise<number> {
  // The shortest configured threshold decides who is even a candidate.
  // Filtering on the network default would miss every shipment at a
  // branch that tolerates less than it.
  const shortestHours = Math.min(
    config.dwell.defaultHours,
    ...Object.values(config.dwell.byBranchCode),
  );
  if (!Number.isFinite(shortestHours) || shortestHours <= 0) return 0;

  const candidates = await prisma.shipment.findMany({
    where: {
      orgId,
      deletedAt: null,
      currentStatus: { in: IDLE_AT_BRANCH },
      currentBranchId: { not: null },
      statusUpdatedAt: { lte: new Date(now.getTime() - shortestHours * HOUR_MS) },
    },
    orderBy: { statusUpdatedAt: "asc" },
    take: batchSize,
    select: {
      id: true,
      lrNumber: true,
      currentBranchId: true,
      statusUpdatedAt: true,
      currentBranch: { select: { id: true, code: true } },
    },
  });

  if (candidates.length === 0) return 0;

  // One query for the whole batch rather than two per shipment: the
  // event log is the expensive table on this screen, and a per-row walk
  // over three hundred candidates is what turns a three-minute sweep
  // into a four-minute one.
  const events = await prisma.shipmentEvent.findMany({
    where: {
      shipmentId: { in: candidates.map((row) => row.id) },
      eventType: { in: [...ARRIVAL_EVENTS, ...OUTBOUND_EVENTS] },
    },
    orderBy: { occurredAt: "asc" },
    select: {
      shipmentId: true,
      eventType: true,
      occurredAt: true,
      branchId: true,
    },
  });

  const byShipment = new Map<string, typeof events>();
  for (const event of events) {
    const list = byShipment.get(event.shipmentId) ?? [];
    list.push(event);
    byShipment.set(event.shipmentId, list);
  }

  const arrivalSet = new Set<ShipmentEventType>(ARRIVAL_EVENTS);
  let opened = 0;

  for (const row of candidates) {
    const branch = row.currentBranch;
    if (!branch) continue;

    const log = byShipment.get(row.id) ?? [];

    // The latest arrival *at the branch it is sitting at*. An arrival
    // recorded at a hub it has since left says nothing about this dwell.
    let arrivedAt: Date | null = null;
    for (const event of log) {
      if (arrivalSet.has(event.eventType) && event.branchId === branch.id) {
        arrivedAt = event.occurredAt;
      }
    }

    // Seeded and back-filled shipments have no scan. The moment the
    // status last changed is the honest fallback, and it is what a
    // branch manager would point at anyway.
    const arrival = arrivedAt ?? row.statusUpdatedAt;

    const hasOutboundSince = log.some(
      (event) =>
        !arrivalSet.has(event.eventType) &&
        event.occurredAt.getTime() > arrival.getTime(),
    );

    const decision = hubDwellDecision({
      shipmentId: row.id,
      lrNumber: row.lrNumber,
      branchId: branch.id,
      branchCode: branch.code,
      arrivedAt: arrival,
      hasOutboundSince,
      thresholdHours: dwellThresholdHours(config.dwell, branch.code),
      now,
    });

    if (
      await open(orgId, decision, {
        shipmentId: row.id,
        branchId: branch.id,
        ownerBranchId: branch.id,
        detectedAt: now,
        source: "dwell-monitor",
      })
    ) {
      opened++;
    }
  }

  return opened;
}

// ────────────────────────────────────────────────────────────
// Pending POD
// ────────────────────────────────────────────────────────────

async function detectPendingPod(
  orgId: string,
  config: DetectorConfig,
  now: Date,
  batchSize: number,
): Promise<number> {
  const cutoff = new Date(now.getTime() - config.podPendingHours * HOUR_MS);

  const candidates = await prisma.shipment.findMany({
    where: {
      orgId,
      deletedAt: null,
      deliveredAt: { not: null, lte: cutoff },
      // The relation is the truth. Filtering on status alone would miss a
      // delivery whose POD row exists but whose status never advanced.
      pod: { is: null },
      currentStatus: { notIn: ["CANCELLED", "LOST"] },
    },
    orderBy: { deliveredAt: "asc" },
    take: batchSize,
    select: {
      id: true,
      lrNumber: true,
      deliveredAt: true,
      destinationBranchId: true,
      destinationBranch: { select: { id: true, code: true } },
    },
  });

  let opened = 0;

  for (const row of candidates) {
    const decision = pendingPodDecision({
      shipmentId: row.id,
      lrNumber: row.lrNumber,
      deliveredAt: row.deliveredAt,
      hasPod: false,
      thresholdHours: config.podPendingHours,
      now,
      branchCode: row.destinationBranch?.code ?? null,
    });

    if (
      await open(orgId, decision, {
        shipmentId: row.id,
        branchId: row.destinationBranchId,
        ownerBranchId: row.destinationBranchId,
        detectedAt: now,
        source: "pod-monitor",
      })
    ) {
      opened++;
    }
  }

  return opened;
}

// ────────────────────────────────────────────────────────────
// COD shortfall
// ────────────────────────────────────────────────────────────

/** A branch-local calendar date, and the UTC window it spans. */
type SettlementDay = {
  ymd: string;
  from: Date;
  to: Date;
  dayEndPassed: boolean;
};

/**
 * The days worth settling on this pass.
 *
 * Yesterday always — its cash is unambiguously due. Today only once the
 * day-end hour has passed, because before that the difference between
 * collected and deposited is every agent still out working, and opening
 * an exception against all of them by mid-morning is how a branch
 * accountant learns to stop reading the tower.
 */
export function settlementDays(
  now: Date,
  dayEndHour: number,
  offsetMinutes = IST_OFFSET_MINUTES,
): SettlementDay[] {
  const local = toLocal(now, offsetMinutes);

  const dayFor = (ymd: string, dayEndPassed: boolean): SettlementDay => ({
    ymd,
    from: fromLocal(ymd, 0, offsetMinutes),
    to: fromLocal(ymd, 24 * HOUR_MS, offsetMinutes),
    dayEndPassed,
  });

  const yesterday = new Date(
    fromLocal(local.ymd, 0, offsetMinutes).getTime() - 12 * HOUR_MS,
  );
  const yesterdayYmd = toLocal(yesterday, offsetMinutes).ymd;

  const days = [dayFor(yesterdayYmd, true)];

  if (local.msOfDay >= dayEndHour * HOUR_MS) {
    days.push(dayFor(local.ymd, true));
  }

  return days;
}

async function detectCodShortfall(
  orgId: string,
  config: DetectorConfig,
  now: Date,
): Promise<number> {
  let opened = 0;

  for (const day of settlementDays(now, config.codDayEndHour)) {
    opened += await settleDay(orgId, config, day, now);
  }

  return opened;
}

async function settleDay(
  orgId: string,
  config: DetectorConfig,
  day: SettlementDay,
  now: Date,
): Promise<number> {
  const collections = await prisma.codCollection.groupBy({
    by: ["agentId", "branchId"],
    where: {
      collectedAt: { gte: day.from, lt: day.to },
      agentId: { not: null },
      branch: { orgId },
    },
    _sum: { amountCollected: true },
  });

  if (collections.length === 0) return 0;

  // `depositDate` is a plain date column, so it comes back at midnight
  // UTC and must be matched as such — reading it in local time would
  // slide every deposit onto the wrong day for anyone west of Greenwich.
  const depositDate = new Date(`${day.ymd}T00:00:00.000Z`);

  const deposits = await prisma.codDeposit.groupBy({
    by: ["agentId"],
    where: {
      depositDate,
      branch: { orgId },
      // A disputed slip is not money in the drawer. Counting it would
      // close the very exception that ought to be open.
      status: { in: ["PENDING", "VERIFIED"] },
    },
    _sum: { amountDeclared: true },
  });

  const depositedBy = new Map(
    deposits.map((row) => [
      row.agentId,
      new Decimal(row._sum.amountDeclared?.toString() ?? "0"),
    ]),
  );

  const agentIds = [
    ...new Set(
      collections
        .map((row) => row.agentId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const [agents, branches] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, name: true },
    }),
    prisma.branch.findMany({
      where: { id: { in: [...new Set(collections.map((row) => row.branchId))] } },
      select: { id: true, code: true },
    }),
  ]);

  const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));
  const branchCode = new Map(branches.map((branch) => [branch.id, branch.code]));

  let opened = 0;

  for (const row of collections) {
    const agentId = row.agentId;
    if (!agentId) continue;

    const decision = codShortfallDecision({
      agentId,
      agentName: agentName.get(agentId) ?? "An agent",
      branchId: row.branchId,
      branchCode: branchCode.get(row.branchId) ?? "—",
      date: day.ymd,
      collected: new Decimal(row._sum.amountCollected?.toString() ?? "0"),
      deposited: depositedBy.get(agentId) ?? new Decimal(0),
      tolerance: config.codTolerance,
      dayEndPassed: day.dayEndPassed,
    });

    if (
      await open(orgId, decision, {
        branchId: row.branchId,
        ownerBranchId: row.branchId,
        detectedAt: now,
        source: "settlement-check",
      })
    ) {
      opened++;
    }
  }

  return opened;
}
