import { isInsideCircle, isInsidePolygon, type LatLng } from "./geo";

/**
 * Fence evaluation and debounce.
 *
 * PURE. No database, no clock, no environment. Given a position, the fences
 * that exist, and what the vehicle's state was on the previous ping, this
 * decides whether an enter or an exit has actually happened.
 *
 * The debounce is the whole reason this is a module rather than three lines
 * in the ingest loop. A truck parked half on the line of a hub fence
 * produces a ping inside, a ping outside, a ping inside — GPS noise alone
 * moves a stationary vehicle five to ten metres. Fired naively, that is
 * forty arrival events, forty status changes on every consignment aboard,
 * and forty customer SMS messages. Requiring N consecutive agreeing pings
 * before believing a change costs one poll interval of latency and removes
 * the entire failure mode (docs/BRD.html §B.6).
 */

export type FenceDefinition = {
  id: string;
  name: string;
  type: "CIRCLE" | "POLYGON";
  /** Set when the fence wraps one of our own nodes; drives arrival events. */
  branchId: string | null;
  centre: LatLng | null;
  radiusMetres: number | null;
  ring: LatLng[] | null;
  /** Consecutive agreeing pings before a change is believed. */
  debouncePings: number;
};

export type FenceState = {
  /** Fences the vehicle is currently considered to be inside. */
  insideGeofenceIds: string[];
  /** The one change being counted towards its debounce threshold. */
  pendingFenceId: string | null;
  pendingCount: number;
};

export type FenceTransition = {
  geofenceId: string;
  direction: "ENTER" | "EXIT";
  /** Convenience for the caller, which needs the branch to raise arrivals. */
  branchId: string | null;
  name: string;
};

export type FenceEvaluation = {
  /** Confirmed changes. At most one per ping — see the note below. */
  transitions: FenceTransition[];
  /** State to persist against the vehicle, ready for the next ping. */
  state: FenceState;
  /** Every fence the point is geometrically inside, before debounce. */
  containing: string[];
};

/** Is this point inside this fence, geometrically, right now? */
export function isInsideFence(point: LatLng, fence: FenceDefinition): boolean {
  if (fence.type === "POLYGON") {
    return fence.ring ? isInsidePolygon(point, fence.ring) : false;
  }
  if (!fence.centre || fence.radiusMetres == null) return false;
  return isInsideCircle(point, fence.centre, fence.radiusMetres);
}

/**
 * Every fence containing the point.
 *
 * This is the function that becomes a single PostGIS query when the
 * extension is installed — `ST_DWithin` for circles, `ST_Contains` for
 * polygons — and the signature is chosen so that swap changes nothing for
 * any caller. Until then it is a linear scan, which is the right shape for
 * the few hundred fences a regional network has.
 */
export function fencesContaining(
  point: LatLng,
  fences: readonly FenceDefinition[],
): string[] {
  return fences.filter((fence) => isInsideFence(point, fence)).map((fence) => fence.id);
}

export const EMPTY_FENCE_STATE: FenceState = {
  insideGeofenceIds: [],
  pendingFenceId: null,
  pendingCount: 0,
};

/**
 * One ping against one vehicle's fence state.
 *
 * At most one transition is confirmed per ping, because the schema carries
 * a single `pendingFenceId`/`pendingCount` pair per vehicle and a single
 * slot is the right trade: fences overlap rarely, adjacent fences resolve
 * one poll interval apart, and the alternative is a pending row per fence
 * per vehicle to serve a case that barely occurs.
 *
 * When several changes are candidates, an EXIT is preferred over an ENTER —
 * physically you leave somewhere before you arrive somewhere else, and a
 * timeline that reads "arrived Jaipur, left Delhi" is one nobody trusts
 * again. Ties beyond that are broken by fence id, so the behaviour is
 * deterministic and testable rather than dependent on query order.
 */
export function evaluateFences(input: {
  point: LatLng;
  fences: readonly FenceDefinition[];
  state: FenceState;
}): FenceEvaluation {
  const { point, fences, state } = input;

  const byId = new Map(fences.map((fence) => [fence.id, fence]));
  const containing = fencesContaining(point, fences);
  const containingSet = new Set(containing);
  const insideSet = new Set(state.insideGeofenceIds);

  // A fence that has been deleted or deactivated since the last ping is
  // dropped from the vehicle's set silently. It cannot produce an exit
  // event: nothing left anywhere, the rule was withdrawn.
  const stillInside = state.insideGeofenceIds.filter((id) => byId.has(id));

  const candidates: FenceTransition[] = [];
  for (const id of containingSet) {
    if (insideSet.has(id)) continue;
    const fence = byId.get(id);
    if (fence) {
      candidates.push({ geofenceId: id, direction: "ENTER", branchId: fence.branchId, name: fence.name });
    }
  }
  for (const id of stillInside) {
    if (containingSet.has(id)) continue;
    const fence = byId.get(id);
    if (fence) {
      candidates.push({ geofenceId: id, direction: "EXIT", branchId: fence.branchId, name: fence.name });
    }
  }

  if (candidates.length === 0) {
    // The vehicle agrees with its recorded state. Any half-counted change
    // is abandoned — this is the idling truck stepping back over the line,
    // and the count must not survive to be completed an hour later.
    return {
      transitions: [],
      containing,
      state: {
        insideGeofenceIds: stillInside,
        pendingFenceId: null,
        pendingCount: 0,
      },
    };
  }

  candidates.sort((a, b) => {
    if (a.direction !== b.direction) return a.direction === "EXIT" ? -1 : 1;
    return a.geofenceId < b.geofenceId ? -1 : 1;
  });

  // Keep counting the change already in progress if it is still on the
  // table; otherwise start counting the strongest candidate.
  const chosen =
    candidates.find((candidate) => candidate.geofenceId === state.pendingFenceId) ??
    candidates[0];

  const continuing = chosen.geofenceId === state.pendingFenceId;
  const count = continuing ? state.pendingCount + 1 : 1;

  const fence = byId.get(chosen.geofenceId);
  // A fence configured with a nonsensical threshold still has to behave:
  // zero or one means "believe the first ping".
  const required = Math.max(1, fence?.debouncePings ?? 1);

  if (count < required) {
    return {
      transitions: [],
      containing,
      state: {
        insideGeofenceIds: stillInside,
        pendingFenceId: chosen.geofenceId,
        pendingCount: count,
      },
    };
  }

  const nextInside =
    chosen.direction === "ENTER"
      ? [...stillInside, chosen.geofenceId]
      : stillInside.filter((id) => id !== chosen.geofenceId);

  return {
    transitions: [chosen],
    containing,
    state: {
      insideGeofenceIds: nextInside,
      pendingFenceId: null,
      pendingCount: 0,
    },
  };
}

/**
 * Replays a run of pings through the debounce.
 *
 * Used by the tests to demonstrate that a truck loitering on a fence line
 * produces one arrival and not forty, and available to support when a
 * customer asks why an arrival landed when it did.
 */
export function replayFences(
  points: readonly LatLng[],
  fences: readonly FenceDefinition[],
  initial: FenceState = EMPTY_FENCE_STATE,
): { transitions: FenceTransition[]; state: FenceState } {
  let state = initial;
  const transitions: FenceTransition[] = [];

  for (const point of points) {
    const result = evaluateFences({ point, fences, state });
    transitions.push(...result.transitions);
    state = result.state;
  }

  return { transitions, state };
}
