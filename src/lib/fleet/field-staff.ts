import type {
  DeliveryRunStatus,
  PickupStatus,
} from "@/generated/prisma/client";

/**
 * Field staff — the delivery boys and pickup boys — as a subject in their
 * own right.
 *
 * Pure on purpose, in the same spirit as `availability.ts`: "may this
 * person be stood down today?" is asked by a server action, by the screen
 * that renders the button, and by the tests, and all three have to answer
 * it identically. A rule that lives only inside the action is a rule the
 * button cannot preview, and a disabled-looking button that succeeds
 * anyway is worse than no button.
 *
 * Nothing here touches Prisma or the clock — `asOf` is always passed in.
 */

// ────────────────────────────────────────────────────────────
// What counts as open work
// ────────────────────────────────────────────────────────────

/**
 * Run statuses that still have work inside them.
 *
 * `COMPLETED` and `CANCELLED` are closed books. A `PLANNED` run has not
 * started but already owns its stops, so standing the agent down leaves
 * those parcels with nobody carrying them tomorrow morning.
 */
export const OPEN_RUN_STATUSES: readonly DeliveryRunStatus[] = [
  "PLANNED",
  "STARTED",
] as const;

/**
 * Assignment statuses a pickup executive is still on the hook for.
 *
 * `FAILED` is deliberately absent: a failed visit is history, and the
 * rework is a fresh attempt against a new assignment — see
 * `canReassign` in `src/lib/pickup/assignment.ts`.
 */
export const UNFINISHED_PICKUP_STATUSES: readonly PickupStatus[] = [
  "ASSIGNED",
  "IN_PROGRESS",
] as const;

export type OpenRun = {
  number: string;
  status: DeliveryRunStatus;
  /** Stops with no outcome yet. */
  stopsRemaining: number;
};

export type OpenPickup = {
  /** The pickup request's number, which is what the operator searches by. */
  number: string;
};

export type OpenWork = {
  runs: OpenRun[];
  pickups: OpenPickup[];
};

export function hasOpenWork(work: OpenWork): boolean {
  return work.runs.length > 0 || work.pickups.length > 0;
}

// ────────────────────────────────────────────────────────────
// The deactivation rule
// ────────────────────────────────────────────────────────────

export type DeactivationCheck = { ok: true } | { ok: false; reason: string };

/** "a, b and c" — an operator reads a sentence, not a bullet list. */
function listPhrase(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function describeRun(run: OpenRun): string {
  const stops =
    run.stopsRemaining === 1 ? "1 stop open" : `${run.stopsRemaining} stops open`;
  return `delivery run ${run.number} (${run.status.toLowerCase()}, ${stops})`;
}

/**
 * Whether a field user may be deactivated right now.
 *
 * The refusal exists because a `DeliveryRun` keeps its `agentId` whatever
 * happens to the user row. Deactivate a delivery boy mid-run and the run
 * still reads as assigned, still shows a full stop count on the branch
 * board, and the only symptom is parcels that never move — nobody is
 * notified, because nothing failed. So the check happens before the write
 * and it names the documents, because "reassign their work first" is not
 * actionable at seven in the morning and `DR-DEL-0042` is.
 *
 * Reassignment is deliberately *not* done here. Who takes over a half-run
 * of COD parcels is an operator's decision with money attached to it, and
 * it must not be a side effect of pressing a delete button.
 */
export function canDeactivateFieldUser(
  name: string,
  work: OpenWork,
): DeactivationCheck {
  if (!hasOpenWork(work)) return { ok: true };

  const parts: string[] = [];
  if (work.runs.length > 0) parts.push(listPhrase(work.runs.map(describeRun)));
  if (work.pickups.length > 0) {
    const numbers = listPhrase(work.pickups.map((pickup) => pickup.number));
    parts.push(
      work.pickups.length === 1 ? `pickup ${numbers}` : `pickups ${numbers}`,
    );
  }

  const where = [
    work.runs.length > 0 ? "Delivery → Delivery runs" : null,
    work.pickups.length > 0 ? "Pickups" : null,
  ]
    .filter((entry): entry is string => entry !== null)
    .join(" and ");

  return {
    ok: false,
    reason:
      `${name} is still carrying ${listPhrase(parts)}. ` +
      `Reassign that work under ${where} first — deactivating now leaves it ` +
      `assigned to somebody who can no longer sign in, and nothing would ` +
      `report it.`,
  };
}

// ────────────────────────────────────────────────────────────
// Whether the phone is still talking to us
// ────────────────────────────────────────────────────────────

/**
 * A field user has no "last seen" column worth trusting — `lastLoginAt`
 * only moves when the OTP is re-entered, which on a phone that stays
 * signed in can be months. What actually proves the device is alive is a
 * write coming out of it: a run started, a stop closed, a pickup
 * collected. So freshness is measured from the newest of those.
 */
export type SyncFreshness = "FRESH" | "QUIET" | "STALE" | "NEVER";

/** Inside one shift. Anything newer than this is simply working. */
export const FRESH_WITHIN_HOURS = 12;

/**
 * A day and a half. Long enough to survive a weekly off or a rest day,
 * short enough that a dead phone surfaces before the second morning.
 */
export const QUIET_WITHIN_HOURS = 36;

const MS_PER_HOUR = 3_600_000;

export function hoursSince(instant: Date, asOf: Date): number {
  return (asOf.getTime() - instant.getTime()) / MS_PER_HOUR;
}

export function syncFreshness(
  lastActivityAt: Date | null,
  asOf: Date,
): SyncFreshness {
  if (!lastActivityAt) return "NEVER";

  const hours = hoursSince(lastActivityAt, asOf);
  // A device clock running ahead lands a write in the future. That is a
  // synced phone, not a stale one, so it reads as fresh rather than
  // producing a negative age nobody can interpret.
  if (hours < FRESH_WITHIN_HOURS) return "FRESH";
  if (hours < QUIET_WITHIN_HOURS) return "QUIET";
  return "STALE";
}

/** The newest of several candidate timestamps, ignoring the missing ones. */
export function latestActivity(
  ...candidates: Array<Date | null | undefined>
): Date | null {
  let newest: Date | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!newest || candidate.getTime() > newest.getTime()) newest = candidate;
  }
  return newest;
}
