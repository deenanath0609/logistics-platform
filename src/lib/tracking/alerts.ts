import { haversineMetres, type LatLng } from "./geo";

/**
 * Alert detection.
 *
 * PURE. Each detector takes a window of recent fixes and returns either a
 * finding or null. Nothing here writes a row, raises an exception, or
 * notifies anybody — that is `monitor.ts`'s job, and keeping the judgement
 * separate from the writing is what makes "why did this fire?" a test
 * rather than an archaeology exercise against production data.
 *
 * All three detectors are built around *sustained* conditions. A single
 * fix beyond a threshold means nothing: GPS drifts, a driver takes a
 * service road round a jam, a device reports one wild fix on a cold start.
 * Alerting on any of those trains the transport desk to ignore alerts,
 * which is worse than having none.
 */

export type AlertThresholds = {
  /** Metres off the planned polyline before a fix counts as deviating. */
  deviationMetres: number;
  /** Consecutive deviating fixes before the alert is raised. */
  deviationPings: number;
  /** A vehicle within this radius of where it was has not moved. */
  stoppageRadiusMetres: number;
  /** Minutes stationary outside a known fence before it is a stoppage. */
  stoppageMinutes: number;
  /** Minutes of silence before the absence of data is itself the signal. */
  signalLossMinutes: number;
};

/**
 * Defaults tuned for Indian highway freight.
 *
 * 500 m clears the widest service road and every legitimate diversion
 * around a toll plaza, while catching a truck that has genuinely left the
 * lane. 45 minutes of stopping is a tea stop; the alert wants the one that
 * is not. 20 minutes of silence is four missed thirty-second polls with
 * room for a tunnel.
 */
export const DEFAULT_THRESHOLDS: AlertThresholds = {
  deviationMetres: 500,
  deviationPings: 4,
  stoppageRadiusMetres: 150,
  stoppageMinutes: 45,
  signalLossMinutes: 20,
};

export type PositionSample = {
  at: Date;
  point: LatLng;
  /** As reported by the device, where it reports one. */
  speedKmph?: number | null;
  /** Fences the vehicle was inside at the time, if known. */
  insideFence?: boolean;
};

// ────────────────────────────────────────────────────────────
// Route deviation
// ────────────────────────────────────────────────────────────

export type DeviationFinding = {
  /** The worst distance seen in the sustained run, in metres. */
  worstMetres: number;
  /** How many consecutive fixes were beyond the threshold. */
  consecutive: number;
};

/**
 * A sustained departure from the planned lane.
 *
 * `distances` are the perpendicular distances of the most recent fixes to
 * the planned polyline, oldest first. A null entry — no planned route for
 * that fix — breaks the run rather than counting towards it: not knowing
 * where a vehicle should be is not evidence that it is somewhere else.
 */
export function detectDeviation(
  distances: ReadonlyArray<number | null>,
  thresholds: Pick<AlertThresholds, "deviationMetres" | "deviationPings"> = DEFAULT_THRESHOLDS,
): DeviationFinding | null {
  const required = Math.max(1, thresholds.deviationPings);
  if (distances.length < required) return null;

  // Only a run ending at the latest fix counts. A diversion the driver has
  // already corrected is history, not a live alert.
  const tail = distances.slice(-required);
  if (tail.some((d) => d === null || d <= thresholds.deviationMetres)) return null;

  let consecutive = 0;
  let worst = 0;
  for (let i = distances.length - 1; i >= 0; i--) {
    const distance = distances[i];
    if (distance === null || distance <= thresholds.deviationMetres) break;
    consecutive++;
    if (distance > worst) worst = distance;
  }

  return { worstMetres: Math.round(worst), consecutive };
}

// ────────────────────────────────────────────────────────────
// Stoppage
// ────────────────────────────────────────────────────────────

export type StoppageFinding = {
  minutes: number;
  /** Where it stopped — the first fix of the stationary run. */
  at: LatLng;
  since: Date;
};

/**
 * A vehicle that has not moved, outside anywhere it has business stopping.
 *
 * Samples are oldest first. The run is measured backwards from the latest
 * fix: how far back does the vehicle stay within `stoppageRadiusMetres` of
 * where it is now? That radius is what absorbs GPS jitter, which otherwise
 * makes a parked truck look like it is doing four kilometres an hour.
 *
 * A vehicle inside a known fence is exempt. Sitting in a hub for two hours
 * is unloading, not a breakdown, and alerting on it would bury the one that
 * matters (docs/BRD.html §A.9).
 */
export function detectStoppage(
  samples: readonly PositionSample[],
  thresholds: Pick<
    AlertThresholds,
    "stoppageRadiusMetres" | "stoppageMinutes"
  > = DEFAULT_THRESHOLDS,
  now?: Date,
): StoppageFinding | null {
  if (samples.length < 2) return null;

  const ordered = [...samples].sort((a, b) => a.at.getTime() - b.at.getTime());
  const latest = ordered[ordered.length - 1];
  if (latest.insideFence) return null;

  let earliest = latest;
  for (let i = ordered.length - 2; i >= 0; i--) {
    const sample = ordered[i];
    if (haversineMetres(sample.point, latest.point) > thresholds.stoppageRadiusMetres) break;
    // Leaving and returning to the same spot is not one long stop.
    if (sample.insideFence) break;
    earliest = sample;
  }

  const until = now ?? latest.at;
  const minutes = Math.floor((until.getTime() - earliest.at.getTime()) / 60_000);
  if (minutes < thresholds.stoppageMinutes) return null;

  return { minutes, at: earliest.point, since: earliest.at };
}

// ────────────────────────────────────────────────────────────
// Signal loss
// ────────────────────────────────────────────────────────────

export type SignalLossFinding = {
  minutesSilent: number;
};

/**
 * Nothing heard for too long.
 *
 * A first-class alert rather than an afterthought: a device that has stopped
 * reporting is either broken, unplugged, or on a vehicle that is no longer
 * where anybody thinks it is, and all three need somebody to pick up a
 * phone. The absence of data is itself an operational signal
 * (docs/BRD.html §A.9).
 *
 * A vehicle that has never reported at all returns null — that is an
 * unfitted vehicle, which is a fleet-master problem and not a live alert
 * repeated every polling interval for the rest of time.
 */
export function detectSignalLoss(
  lastPingAt: Date | null | undefined,
  now: Date,
  thresholds: Pick<AlertThresholds, "signalLossMinutes"> = DEFAULT_THRESHOLDS,
): SignalLossFinding | null {
  if (!lastPingAt || Number.isNaN(lastPingAt.getTime())) return null;

  const minutesSilent = Math.floor((now.getTime() - lastPingAt.getTime()) / 60_000);
  if (minutesSilent < thresholds.signalLossMinutes) return null;

  return { minutesSilent };
}

// ────────────────────────────────────────────────────────────
// Overspeed
// ────────────────────────────────────────────────────────────

/**
 * Sustained speed above a limit.
 *
 * `TrackingAlert.kind` carries OVERSPEED, and the detector is cheap enough
 * to include even though the BRD leaves the policy to a later phase: the
 * threshold is a parameter and nothing calls this until an org sets one.
 */
export function detectOverspeed(
  samples: readonly PositionSample[],
  limitKmph: number,
  requiredConsecutive = 3,
): { peakKmph: number; consecutive: number } | null {
  if (!Number.isFinite(limitKmph) || limitKmph <= 0) return null;
  if (samples.length < requiredConsecutive) return null;

  const tail = samples.slice(-requiredConsecutive);
  if (tail.some((s) => s.speedKmph == null || s.speedKmph <= limitKmph)) return null;

  const peak = Math.max(...tail.map((s) => s.speedKmph ?? 0));
  return { peakKmph: Math.round(peak * 100) / 100, consecutive: requiredConsecutive };
}
