import {
  haversineMetres,
  polylineLengthMetres,
  projectOntoPolyline,
  type LatLng,
} from "./geo";

/**
 * Arrival estimation.
 *
 * PURE. Give it a position, a planned route and a handful of recent fixes,
 * and it answers "how far is left, how fast is this thing going, and when
 * will it get there" — or it declines to answer.
 *
 * Declining is the important part. Every honest failure here has a named
 * reason, and none of them is a number. A stationary vehicle divided into a
 * remaining distance is Infinity; rendered, that becomes "arriving in
 * 19:14 on 31 December", which a customer sees, a branch manager explains,
 * and nobody trusts the ETA again. A missing route is not a zero-kilometre
 * journey. The absence of an estimate is a fact worth displaying, and it is
 * why `EtaResult` is a discriminated union rather than a nullable number.
 */

export type EtaSample = {
  at: Date;
  point: LatLng;
};

/** Below this, a vehicle is loitering rather than travelling. */
export const STATIONARY_THRESHOLD_KMPH = 3;

/** Within this of the end of the route, the vehicle has arrived. */
export const ARRIVAL_TOLERANCE_METRES = 300;

/** How far back the rolling average looks, in minutes. */
export const DEFAULT_WINDOW_MINUTES = 30;

/** Nothing sensible is predicted further out than this. */
export const MAX_HORIZON_HOURS = 72;

export type EtaUnavailableReason =
  | "no-route"
  | "no-history"
  | "stationary"
  | "arrived"
  | "beyond-horizon";

export type EtaResult =
  | {
      ok: true;
      /** Distance travelled along the planned route so far, in km. */
      coveredKm: number;
      remainingKm: number;
      averageSpeedKmph: number;
      minutesRemaining: number;
      estimatedArrivalAt: Date;
      /** How far the vehicle sits from its planned route, in metres. */
      offRouteMetres: number;
      confidence: "high" | "medium" | "low";
      method: "gps";
    }
  | { ok: false; reason: EtaUnavailableReason; coveredKm?: number; remainingKm?: number };

/**
 * Average speed over the recent past, from positions rather than from the
 * device's reported speed.
 *
 * A reported speed is instantaneous: sampled at a red light it says zero,
 * sampled on a flyover it says seventy, and neither predicts anything. What
 * an ETA needs is the average the vehicle has actually sustained, traffic
 * and tea stops included, which is exactly total distance over total time.
 *
 * Returns null when there is nothing to average — one fix is a position,
 * not a speed.
 */
export function rollingAverageSpeedKmph(
  samples: readonly EtaSample[],
  options: { windowMinutes?: number; now?: Date } = {},
): number | null {
  if (!Array.isArray(samples) || samples.length < 2) return null;

  const ordered = [...samples].sort((a, b) => a.at.getTime() - b.at.getTime());
  const now = options.now ?? ordered[ordered.length - 1].at;
  const windowMs = (options.windowMinutes ?? DEFAULT_WINDOW_MINUTES) * 60_000;

  let windowed = ordered.filter((s) => now.getTime() - s.at.getTime() <= windowMs);
  // A vehicle that has been silent longer than the window would otherwise
  // average over nothing. Fall back to the last two fixes we do have rather
  // than reporting no speed for a truck that is plainly moving.
  if (windowed.length < 2) windowed = ordered.slice(-2);

  let metres = 0;
  for (let i = 1; i < windowed.length; i++) {
    metres += haversineMetres(windowed[i - 1].point, windowed[i].point);
  }

  const elapsedMs =
    windowed[windowed.length - 1].at.getTime() - windowed[0].at.getTime();
  if (elapsedMs <= 0) return null;

  return (metres / 1000) / (elapsedMs / 3_600_000);
}

export type EtaInput = {
  now: Date;
  /** Latest known position. */
  position: LatLng;
  /** Planned path, origin first and destination last. May be empty. */
  route: readonly LatLng[];
  /** Recent fixes in any order; only the last window is used. */
  history: readonly EtaSample[];
  windowMinutes?: number;
  stationaryThresholdKmph?: number;
  arrivalToleranceMetres?: number;
};

/**
 * Remaining distance along the route, rolling-average speed, and the
 * arrival that follows from them.
 */
export function computeEta(input: EtaInput): EtaResult {
  const route = input.route ?? [];
  const routeLength = polylineLengthMetres(route);

  // No planned route means no remaining distance to measure. An origin and
  // a destination with nothing between them is still a route — two points
  // and a straight line is a poor estimate but an honest one.
  if (route.length < 2 || routeLength <= 0) {
    return { ok: false, reason: "no-route" };
  }

  const projection = projectOntoPolyline(input.position, route);
  if (!projection) return { ok: false, reason: "no-route" };

  const coveredMetres = Math.min(projection.alongMetres, routeLength);
  const remainingMetres = Math.max(0, routeLength - coveredMetres);
  const coveredKm = round2(coveredMetres / 1000);
  const remainingKm = round2(remainingMetres / 1000);

  const tolerance = input.arrivalToleranceMetres ?? ARRIVAL_TOLERANCE_METRES;

  // Past the end of the planned route, or close enough to it. Either way
  // there is nothing left to estimate — the answer is "it is there", not a
  // negative distance and a time in the past.
  if (remainingMetres <= tolerance) {
    return { ok: false, reason: "arrived", coveredKm, remainingKm: 0 };
  }

  const averageSpeedKmph = rollingAverageSpeedKmph(input.history, {
    windowMinutes: input.windowMinutes,
    now: input.now,
  });

  if (averageSpeedKmph === null) {
    return { ok: false, reason: "no-history", coveredKm, remainingKm };
  }

  const threshold = input.stationaryThresholdKmph ?? STATIONARY_THRESHOLD_KMPH;
  if (averageSpeedKmph < threshold) {
    // Deliberately no estimate. Dividing by a speed near zero produces a
    // date years away; showing that is worse than showing nothing, and
    // showing nothing is also the truth: we do not know when a stopped
    // vehicle will arrive, because we do not know when it will move.
    return { ok: false, reason: "stationary", coveredKm, remainingKm };
  }

  const hoursRemaining = remainingKm / averageSpeedKmph;
  if (hoursRemaining > MAX_HORIZON_HOURS) {
    return { ok: false, reason: "beyond-horizon", coveredKm, remainingKm };
  }

  const minutesRemaining = Math.round(hoursRemaining * 60);

  return {
    ok: true,
    coveredKm,
    remainingKm,
    averageSpeedKmph: round2(averageSpeedKmph),
    minutesRemaining,
    estimatedArrivalAt: new Date(input.now.getTime() + minutesRemaining * 60_000),
    offRouteMetres: Math.round(projection.distanceMetres),
    confidence: confidenceOf(input.history, projection.distanceMetres, input.now),
    method: "gps",
  };
}

/**
 * How much to believe the number.
 *
 * Three fixes over four minutes on a vehicle two kilometres off its planned
 * route is an estimate, not a promise, and the screen should say so. This
 * is deliberately coarse: a spurious precision here would be its own lie.
 */
function confidenceOf(
  history: readonly EtaSample[],
  offRouteMetres: number,
  now: Date,
): "high" | "medium" | "low" {
  if (history.length < 2) return "low";

  const times = history.map((s) => s.at.getTime());
  const spanMinutes = (Math.max(...times) - Math.min(...times)) / 60_000;
  const stalenessMinutes = (now.getTime() - Math.max(...times)) / 60_000;

  if (offRouteMetres > 2_000 || stalenessMinutes > 30) return "low";
  if (history.length >= 5 && spanMinutes >= 10 && offRouteMetres <= 500) return "high";
  if (spanMinutes >= 3) return "medium";
  return "low";
}

/**
 * The estimate to fall back on when there is no telematics at all.
 *
 * Half the fleet is attached or vendor-owned and will never have a working
 * device (docs/BRD.html §A.9). For those vehicles the planned arrival on
 * the trip is the best answer available, and it is recorded with
 * `method: "schedule"` so a report can tell a measured ETA from a promised
 * one — and so nobody mistakes the timetable for a live observation.
 */
export function scheduleEta(plannedArrivalAt: Date | null | undefined): {
  estimatedArrivalAt: Date;
  method: "schedule";
  confidence: "low";
} | null {
  if (!plannedArrivalAt || Number.isNaN(plannedArrivalAt.getTime())) return null;
  return { estimatedArrivalAt: plannedArrivalAt, method: "schedule", confidence: "low" };
}

/**
 * Minutes late against a promise, positive when late.
 *
 * Returns null when either side is unknown, so "we have no idea" never
 * renders as "on time".
 */
export function delayMinutes(
  estimatedArrivalAt: Date | null | undefined,
  plannedArrivalAt: Date | null | undefined,
): number | null {
  if (!estimatedArrivalAt || !plannedArrivalAt) return null;
  return Math.round(
    (estimatedArrivalAt.getTime() - plannedArrivalAt.getTime()) / 60_000,
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
