import type { PickupSlot, PickupStatus } from "@/generated/prisma/client";

/**
 * Pickup sequencing and workload.
 *
 * Pure and separately tested: assignment is where a branch either spreads
 * work sensibly or quietly overloads one executive, and that decision
 * should not be buried inside a page component.
 */

export type PickupCandidate = {
  id: string;
  slot: PickupSlot;
  priority: number;
  expectedPackages: number | null;
  pincode: string;
  requestedDate: Date;
};

export type ExecutiveLoad = {
  userId: string;
  name: string;
  /** Pickups already assigned to them for the day. */
  assigned: number;
  /** Packages already promised, which is the better proxy for effort. */
  packages: number;
};

/** Order slots run in, so a morning pickup is not sequenced after an evening one. */
const SLOT_ORDER: Record<PickupSlot, number> = {
  MORNING: 0,
  AFTERNOON: 1,
  EVENING: 2,
  ANYTIME: 3,
};

/**
 * Orders a set of pickups into a sensible run.
 *
 * Priority first (a promised or re-attempted collection outranks a new
 * one), then slot, then pincode so nearby stops cluster, then age so a
 * request does not sit forever behind newer ones.
 *
 * This is not route optimisation — that arrives in Phase 8 with real
 * distances. It is a defensible default a dispatcher can override.
 */
export function sequencePickups(pickups: PickupCandidate[]): PickupCandidate[] {
  return [...pickups].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;

    const slotDelta = SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot];
    if (slotDelta !== 0) return slotDelta;

    const pincodeDelta = a.pincode.localeCompare(b.pincode);
    if (pincodeDelta !== 0) return pincodeDelta;

    return a.requestedDate.getTime() - b.requestedDate.getTime();
  });
}

/**
 * Suggests who should take the next pickup: the lightest load, measured
 * in packages rather than stop count, because ten single-carton
 * collections are not the same job as one 40-package load.
 *
 * Ties break on stop count, then name, so the suggestion is stable across
 * renders instead of jumping around.
 */
export function suggestExecutive(
  loads: ExecutiveLoad[],
): ExecutiveLoad | null {
  if (loads.length === 0) return null;

  return [...loads].sort((a, b) => {
    if (a.packages !== b.packages) return a.packages - b.packages;
    if (a.assigned !== b.assigned) return a.assigned - b.assigned;
    return a.name.localeCompare(b.name);
  })[0];
}

/** Statuses a pickup can still be worked on from. */
const OPEN_STATUSES: PickupStatus[] = ["REQUESTED", "ASSIGNED", "IN_PROGRESS"];

export function isOpen(status: PickupStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export type ReassignCheck = { ok: boolean; reason?: string };

/**
 * Whether a pickup may be moved to a different executive.
 *
 * A completed collection is history. A failed one is reworked by raising
 * a fresh attempt, not by editing who was blamed for the last.
 */
export function canReassign(status: PickupStatus): ReassignCheck {
  if (status === "COMPLETED") {
    return { ok: false, reason: "This pickup has already been collected." };
  }
  if (status === "CANCELLED") {
    return { ok: false, reason: "This pickup was cancelled." };
  }
  if (status === "FAILED") {
    return {
      ok: false,
      reason:
        "This attempt failed. Schedule a re-pickup rather than reassigning the failed visit — the history of who attempted it has to survive.",
    };
  }
  return { ok: true };
}

/**
 * When the next attempt should be scheduled after a failure.
 *
 * Next working day at the same slot, which is what a consignor expects.
 * Branch holidays are applied by the caller, which knows the calendar.
 */
export function nextAttemptDate(failedOn: Date, addDays = 1): Date {
  const next = new Date(failedOn);
  next.setDate(next.getDate() + addDays);
  next.setHours(0, 0, 0, 0);
  return next;
}
