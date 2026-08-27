import type {
  ComplaintCategory,
  ComplaintPriority,
  ComplaintStatus,
} from "@/generated/prisma/client";

/**
 * Complaint SLA.
 *
 * Two clocks, not one. The response clock is how long a customer waits
 * before a human acknowledges them; the resolution clock is how long they
 * wait for an answer. Conflating them is how a complaint gets replied to
 * in ten minutes, then sits untouched for a fortnight and still shows
 * green.
 *
 * Pure and wall-clock. Transit SLAs run on a working calendar with branch
 * cut-offs (§A.11); complaints deliberately do not — a consignment lost on
 * Friday evening is not less lost on Saturday, and a support desk that
 * stops its own clock at 6pm is measuring its convenience rather than the
 * customer's wait.
 */

export type SlaTarget = {
  /** Minutes from being raised to the first human response. */
  responseMinutes: number;
  /** Minutes from being raised to a resolution being recorded. */
  resolutionMinutes: number;
};

const HOUR = 60;

/**
 * Base targets by category, before priority is applied.
 *
 * The ordering here is an operational judgement, not a formula: a missing
 * consignment and a pickup that never arrived both have someone standing
 * next to an empty space right now, which a billing dispute does not.
 */
const BASE: Record<ComplaintCategory, SlaTarget> = {
  MISSING: { responseMinutes: 2 * HOUR, resolutionMinutes: 72 * HOUR },
  PICKUP_ISSUE: { responseMinutes: 2 * HOUR, resolutionMinutes: 24 * HOUR },
  WRONG_DELIVERY: { responseMinutes: 2 * HOUR, resolutionMinutes: 48 * HOUR },
  DAMAGE: { responseMinutes: 4 * HOUR, resolutionMinutes: 72 * HOUR },
  DELAY: { responseMinutes: 4 * HOUR, resolutionMinutes: 48 * HOUR },
  BEHAVIOUR: { responseMinutes: 4 * HOUR, resolutionMinutes: 72 * HOUR },
  POD_ISSUE: { responseMinutes: 8 * HOUR, resolutionMinutes: 48 * HOUR },
  BILLING: { responseMinutes: 8 * HOUR, resolutionMinutes: 120 * HOUR },
  OTHER: { responseMinutes: 8 * HOUR, resolutionMinutes: 72 * HOUR },
};

/**
 * Priority compresses or relaxes the category target.
 *
 * A multiplier rather than a second table: it keeps the relative ordering
 * of the categories intact when someone retunes one of them, and there is
 * only one number to argue about per priority.
 */
const MULTIPLIER: Record<ComplaintPriority, number> = {
  CRITICAL: 0.25,
  HIGH: 0.5,
  NORMAL: 1,
  LOW: 2,
};

/** Fraction of the window elapsed before a complaint counts as at risk. */
export const AT_RISK_THRESHOLD = 0.8;

/** The response and resolution windows for one complaint. */
export function slaFor(
  category: ComplaintCategory,
  priority: ComplaintPriority,
): SlaTarget {
  const base = BASE[category];
  const factor = MULTIPLIER[priority];

  return {
    // Never below fifteen minutes: a target nobody can physically hit is
    // not a target, it is a permanently red dashboard.
    responseMinutes: Math.max(15, Math.round(base.responseMinutes * factor)),
    resolutionMinutes: Math.max(60, Math.round(base.resolutionMinutes * factor)),
  };
}

export type Deadlines = { respondBy: Date; resolveBy: Date };

/** Stamped once, when the complaint is created. */
export function deadlinesFrom(
  raisedAt: Date,
  category: ComplaintCategory,
  priority: ComplaintPriority,
): Deadlines {
  const target = slaFor(category, priority);
  return {
    respondBy: addMinutes(raisedAt, target.responseMinutes),
    resolveBy: addMinutes(raisedAt, target.resolutionMinutes),
  };
}

function addMinutes(from: Date, minutes: number): Date {
  return new Date(from.getTime() + minutes * 60_000);
}

// ────────────────────────────────────────────────────────────
// State
// ────────────────────────────────────────────────────────────

export type SlaState =
  /** Answered or resolved inside the window. */
  | "MET"
  /** Still open, inside the window. */
  | "ON_TRACK"
  /** Still open, past 80% of the window. */
  | "AT_RISK"
  /** Past the deadline, answered late or not at all. */
  | "BREACHED"
  /** No deadline recorded — nothing to measure against. */
  | "UNTRACKED";

export type ComplaintClock = {
  createdAt: Date;
  respondBy: Date | null;
  resolveBy: Date | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  status: ComplaintStatus;
};

/**
 * Where one clock stands.
 *
 * The comparison is `now > deadline`, so a complaint answered at exactly
 * its deadline has been met. Anything else means the second the deadline
 * lands, before any work could possibly happen in it, counts as late.
 */
function stateOf(
  deadline: Date | null,
  completedAt: Date | null,
  startedAt: Date,
  now: Date,
): SlaState {
  if (!deadline) return "UNTRACKED";

  if (completedAt) {
    return completedAt.getTime() > deadline.getTime() ? "BREACHED" : "MET";
  }

  if (now.getTime() > deadline.getTime()) return "BREACHED";

  const window = deadline.getTime() - startedAt.getTime();
  if (window <= 0) return "AT_RISK";

  const elapsed = now.getTime() - startedAt.getTime();
  return elapsed / window >= AT_RISK_THRESHOLD ? "AT_RISK" : "ON_TRACK";
}

export type BreachState = {
  response: SlaState;
  resolution: SlaState;
  /** The worse of the two, which is what the list sorts and colours by. */
  worst: SlaState;
};

const SEVERITY: Record<SlaState, number> = {
  UNTRACKED: 0,
  MET: 1,
  ON_TRACK: 2,
  AT_RISK: 3,
  BREACHED: 4,
};

export function breachState(
  complaint: ComplaintClock,
  now: Date = new Date(),
): BreachState {
  const response = stateOf(
    complaint.respondBy,
    complaint.firstResponseAt,
    complaint.createdAt,
    now,
  );

  // A closed complaint with no resolution timestamp is a data problem, not
  // an SLA one — `closedAt` without `resolvedAt` cannot happen through the
  // workflow, so there is nothing to measure and nothing to blame.
  const resolution = stateOf(
    complaint.resolveBy,
    complaint.resolvedAt,
    complaint.createdAt,
    now,
  );

  const worst =
    SEVERITY[response] >= SEVERITY[resolution] ? response : resolution;

  return { response, resolution, worst };
}

/** True when either clock has run out. */
export function isBreached(
  complaint: ComplaintClock,
  now: Date = new Date(),
): boolean {
  const state = breachState(complaint, now);
  return state.response === "BREACHED" || state.resolution === "BREACHED";
}

/**
 * How long this has been open, in minutes.
 *
 * Stops at resolution rather than at closure: the clock the customer feels
 * ends when they get an answer, not when somebody remembers to tick the
 * complaint shut a week later.
 */
export function ageMinutes(
  complaint: Pick<ComplaintClock, "createdAt" | "resolvedAt">,
  now: Date = new Date(),
): number {
  const end = complaint.resolvedAt ?? now;
  return Math.max(0, Math.floor((end.getTime() - complaint.createdAt.getTime()) / 60_000));
}

/** "3 h 20 m" — the ageing column on the list. */
export function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes} m`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;

  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

/** Minutes left before a deadline; negative once it has passed. */
export function minutesRemaining(
  deadline: Date | null,
  now: Date = new Date(),
): number | null {
  if (!deadline) return null;
  return Math.round((deadline.getTime() - now.getTime()) / 60_000);
}
