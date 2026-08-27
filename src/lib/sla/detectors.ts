import Decimal from "decimal.js";
import type {
  ExceptionKind,
  ExceptionPriority,
} from "@/generated/prisma/client";
import { formatDuration } from "./policy";

/**
 * The three detectors §A.11 names that the SLA scanner did not yet run:
 * hub dwell, pending POD, and COD shortfall at day end.
 *
 * Everything here is pure. A detector takes facts already gathered and
 * answers one question — should an exception be raised, of what kind, at
 * what priority, and under which dedupe key — with no database, no
 * `new Date()`, and no session. `detector-scan.ts` does the querying.
 *
 * The split is not tidiness. The interesting part of a detector is its
 * boundary conditions (exactly at the threshold, a POD that arrived one
 * minute late, a deposit that is a rupee short), and those are only cheap
 * to pin down when the rule can be called with a literal.
 *
 * Two rules govern every dedupe key below:
 *
 *  · **It names the problem, never the moment.** `dwell:<shipment>:<branch>`
 *    is the same key on the first pass and the hundredth, so the unique
 *    index on `Exception.dedupeKey` turns a re-scan into a no-op and the
 *    row keeps the timestamp of the first detection — which is the one
 *    the ageing column should show.
 *
 *  · **It names the problem precisely enough to separate two of them.** A
 *    consignment idle at Delhi and then idle at Jaipur is two failures by
 *    two hubs, so the branch is in the key. An agent short on Monday and
 *    short again on Tuesday is two shortfalls, so the date is in the key —
 *    a date is not "the moment", it is which day went wrong.
 */

export type DetectorDecision = {
  kind: ExceptionKind;
  priority: ExceptionPriority;
  dedupeKey: string;
  title: string;
  detail: string;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MINUTE_MS;
}

// ────────────────────────────────────────────────────────────
// Hub dwell — "shipment idle at hub > N h"
// ────────────────────────────────────────────────────────────

/**
 * Hours a consignment may sit at a branch before the dwell is itself the
 * problem. The BRD calls this "configurable"; `SystemConfig` holds it.
 */
export const DEFAULT_HUB_DWELL_HOURS = 24;

/**
 * The dwell threshold, network-wide and per branch.
 *
 * A per-branch override is the difference between a rule ops will keep
 * and one they will switch off: a sorting hub that turns freight around
 * in four hours and a rural branch that waits for a weekly line-haul
 * cannot share a number, and forcing them to means the alert is either
 * noise at one or silent at the other.
 */
export type DwellThresholds = {
  defaultHours: number;
  /** Branch code → hours. Overrides the default for that branch only. */
  byBranchCode: Readonly<Record<string, number>>;
};

export const DEFAULT_DWELL_THRESHOLDS: DwellThresholds = {
  defaultHours: DEFAULT_HUB_DWELL_HOURS,
  byBranchCode: {},
};

/**
 * Reads the `sla.hubDwellHours` config value.
 *
 * Accepts a bare number for the common case and an object when somebody
 * needs per-branch numbers. Anything unparseable falls back rather than
 * throwing: a typo in a settings row must not stop the dwell monitor for
 * the whole network, it must only fail to change it.
 */
export function parseDwellThresholds(value: unknown): DwellThresholds {
  const positive = (raw: unknown): number | null => {
    const parsed = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  const bare = positive(value);
  if (bare !== null) {
    return { defaultHours: bare, byBranchCode: {} };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_DWELL_THRESHOLDS;
  }

  const record = value as Record<string, unknown>;
  const defaultHours =
    positive(record.defaultHours) ??
    positive(record.default) ??
    positive(record.hours) ??
    DEFAULT_HUB_DWELL_HOURS;

  const source = record.byBranchCode ?? record.byBranch ?? record.branches;
  const byBranchCode: Record<string, number> = {};

  if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    for (const [code, raw] of Object.entries(source)) {
      const hours = positive(raw);
      if (hours !== null) byBranchCode[code.toUpperCase()] = hours;
    }
  }

  return { defaultHours, byBranchCode };
}

/** The threshold that applies at one branch. */
export function dwellThresholdHours(
  thresholds: DwellThresholds,
  branchCode: string | null | undefined,
): number {
  if (!branchCode) return thresholds.defaultHours;
  return thresholds.byBranchCode[branchCode.toUpperCase()] ?? thresholds.defaultHours;
}

export type HubDwellFacts = {
  shipmentId: string;
  lrNumber: string;
  /** The branch the consignment is sitting at. */
  branchId: string;
  branchCode: string;
  /** Most recent arrival scan at that branch. */
  arrivedAt: Date;
  /**
   * Any outbound movement recorded after `arrivedAt` — a gate-out, a load,
   * a manifest, or an assignment to a delivery run. The consignment is
   * only idle if nothing has happened to it.
   */
  hasOutboundSince: boolean;
  thresholdHours: number;
  now: Date;
};

/** `dwell:<shipment>:<branch>` — this consignment, idle at this branch. */
export function hubDwellDedupeKey(
  shipmentId: string,
  branchId: string,
): string {
  return `dwell:${shipmentId}:${branchId}`;
}

/**
 * Is this consignment idle at a hub?
 *
 * `>=` at the threshold, not `>`: the threshold is the point at which
 * somebody wanted to be told, so it fires there. Anything that has moved
 * since arriving is not idle whatever the clock says — the outbound scan
 * is the whole signal, and dwell without it is just a consignment
 * mid-journey being blamed for the journey.
 */
export function hubDwellDecision(
  facts: HubDwellFacts,
): DetectorDecision | null {
  if (facts.hasOutboundSince) return null;
  if (facts.thresholdHours <= 0) return null;

  const dwellMs = facts.now.getTime() - facts.arrivedAt.getTime();
  const thresholdMs = facts.thresholdHours * HOUR_MS;
  if (dwellMs < thresholdMs) return null;

  const dwell = formatDuration(dwellMs / MINUTE_MS);

  // Twice the tolerated dwell is a different conversation from just over
  // it: the first is a hub running late, the second is freight nobody has
  // looked at, and a duty manager sorting by priority needs them apart.
  const priority: ExceptionPriority = dwellMs >= thresholdMs * 2 ? "HIGH" : "NORMAL";

  return {
    kind: "HUB_DWELL",
    priority,
    dedupeKey: hubDwellDedupeKey(facts.shipmentId, facts.branchId),
    title: `${facts.lrNumber} has sat at ${facts.branchCode} for ${dwell}`,
    detail:
      `Arrived ${facts.arrivedAt.toISOString()} and has had no outbound scan since. ` +
      `${facts.branchCode} tolerates ${formatDuration(facts.thresholdHours * 60)}.`,
  };
}

// ────────────────────────────────────────────────────────────
// Pending POD — "pending POD > 24 h"
// ────────────────────────────────────────────────────────────

/** §A.11's figure. A delivery with no proof after this is unprovable. */
export const DEFAULT_POD_PENDING_HOURS = 24;

export type PendingPodFacts = {
  shipmentId: string;
  lrNumber: string;
  /** Null while undelivered; the detector has nothing to say about those. */
  deliveredAt: Date | null;
  /** A `Pod` row exists for this shipment. */
  hasPod: boolean;
  thresholdHours: number;
  now: Date;
  /** Destination branch code, for the title. */
  branchCode: string | null;
};

/** `pod:<shipment>` — this consignment has no proof of delivery. */
export function pendingPodDedupeKey(shipmentId: string): string {
  return `pod:${shipmentId}`;
}

/**
 * Delivered, but nobody can prove it.
 *
 * Low priority by design and by §A.11: the goods reached the consignee,
 * so nothing is on fire — but the invoice is disputable until the POD
 * lands, which is why it escalates at 48 h rather than being ignored.
 */
export function pendingPodDecision(
  facts: PendingPodFacts,
): DetectorDecision | null {
  if (!facts.deliveredAt) return null;
  if (facts.hasPod) return null;
  if (facts.thresholdHours <= 0) return null;

  const pendingMinutes = minutesBetween(facts.deliveredAt, facts.now);
  if (pendingMinutes < facts.thresholdHours * 60) return null;

  const waited = formatDuration(pendingMinutes);

  // Past twice the window the POD is not late, it is missing — and a
  // signature nobody captured on the day is a signature nobody will get.
  const priority: ExceptionPriority =
    pendingMinutes >= facts.thresholdHours * 120 ? "NORMAL" : "LOW";

  return {
    kind: "POD_PENDING",
    priority,
    dedupeKey: pendingPodDedupeKey(facts.shipmentId),
    title: `${facts.lrNumber} was delivered ${waited} ago with no POD`,
    detail:
      `Delivered ${facts.deliveredAt.toISOString()}` +
      `${facts.branchCode ? ` by ${facts.branchCode}` : ""}, and no proof of delivery has been recorded. ` +
      "The delivery is unbillable and undisputable until it is.",
  };
}

// ────────────────────────────────────────────────────────────
// COD shortfall — "COD shortfall at day end"
// ────────────────────────────────────────────────────────────

/**
 * How far short an agent may be before it is an exception.
 *
 * Zero by default. Cash either adds up or it does not, and a tolerance
 * quietly set to "a few hundred rupees" is how a slow leak becomes a
 * policy.
 */
export const DEFAULT_COD_TOLERANCE = 0;

export type CodShortfallFacts = {
  agentId: string;
  agentName: string;
  branchId: string;
  branchCode: string;
  /** The day being settled, "YYYY-MM-DD" in branch-local time. */
  date: string;
  /** Total collected from consignees that day. */
  collected: Decimal;
  /** Total handed over to the branch against that day. */
  deposited: Decimal;
  /** Rupees of difference tolerated before an exception is opened. */
  tolerance: Decimal;
  /**
   * The day is over and the deposit window has passed. False means the
   * agent is still out working and the gap is simply cash in a bag.
   */
  dayEndPassed: boolean;
};

/** `cod:<agent>:<date>` — this agent, this day's takings. */
export function codShortfallDedupeKey(agentId: string, date: string): string {
  return `cod:${agentId}:${date}`;
}

/**
 * Has an agent collected more than they have handed over?
 *
 * `dayEndPassed` is the load-bearing input. Collected-minus-deposited is
 * non-zero for every agent for most of every day, and a detector that
 * ignored that would open an exception against every delivery agent in
 * the network by mid-morning — which is the fastest way to teach a branch
 * accountant to stop reading the tower.
 *
 * Critical whatever the amount, per §A.11: the size of the gap says how
 * much money is missing, not how urgently somebody should ask about it,
 * and cash discrepancies go cold within a day.
 */
export function codShortfallDecision(
  facts: CodShortfallFacts,
): DetectorDecision | null {
  if (!facts.dayEndPassed) return null;

  const shortfall = facts.collected.minus(facts.deposited);
  if (shortfall.lessThanOrEqualTo(facts.tolerance)) return null;
  if (shortfall.lessThanOrEqualTo(0)) return null;

  const money = (value: Decimal) => `₹${value.toFixed(2)}`;

  return {
    kind: "COD_SHORTFALL",
    priority: "CRITICAL",
    dedupeKey: codShortfallDedupeKey(facts.agentId, facts.date),
    title: `${facts.agentName} is ${money(shortfall)} short on ${facts.date}`,
    detail:
      `Collected ${money(facts.collected)} against ${money(facts.deposited)} deposited at ${facts.branchCode}. ` +
      `Shortfall ${money(shortfall)}.`,
  };
}
