import { describe, expect, it } from "vitest";
import { destinationPoint, type LatLng } from "./geo";
import {
  DEFAULT_THRESHOLDS,
  detectDeviation,
  detectOverspeed,
  detectSignalLoss,
  detectStoppage,
  type PositionSample,
} from "./alerts";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const SPOT: LatLng = { lat: 27.5, lng: 76.4 };

/** Fixes every five minutes ending now, at a fixed point unless nudged. */
function samples(
  count: number,
  options: {
    drift?: (index: number) => LatLng;
    insideFence?: boolean;
    speedKmph?: number;
    intervalMinutes?: number;
  } = {},
): PositionSample[] {
  const interval = options.intervalMinutes ?? 5;
  return Array.from({ length: count }, (_, i) => {
    const minutesAgo = (count - 1 - i) * interval;
    return {
      at: new Date(NOW.getTime() - minutesAgo * 60_000),
      point: options.drift ? options.drift(i) : SPOT,
      insideFence: options.insideFence,
      speedKmph: options.speedKmph,
    };
  });
}

describe("detectDeviation", () => {
  const thresholds = { deviationMetres: 500, deviationPings: 4 };

  it("ignores a single wild fix", () => {
    expect(detectDeviation([20, 30, 9_000, 25, 30], thresholds)).toBeNull();
  });

  it("ignores a short excursion that has already ended", () => {
    // Off the lane for four fixes, then back on it. Corrected, not live.
    expect(
      detectDeviation([20, 900, 950, 980, 1_000, 30, 25], thresholds),
    ).toBeNull();
  });

  it("raises once the departure is sustained to the latest fix", () => {
    const finding = detectDeviation([20, 30, 900, 1_400, 1_100, 2_600], thresholds);
    expect(finding).not.toBeNull();
    expect(finding!.consecutive).toBe(4);
    expect(finding!.worstMetres).toBe(2_600);
  });

  it("counts the whole run, not only the required minimum", () => {
    const finding = detectDeviation(
      [800, 900, 1_000, 1_100, 1_200, 1_300],
      thresholds,
    );
    expect(finding!.consecutive).toBe(6);
  });

  it("needs strictly more than the threshold", () => {
    expect(detectDeviation([500, 500, 500, 500], thresholds)).toBeNull();
    expect(detectDeviation([501, 501, 501, 501], thresholds)).not.toBeNull();
  });

  it("treats a fix with no planned route as unknown, not as evidence", () => {
    // Nulls break the run: not knowing where a truck should be is not proof
    // that it is somewhere else.
    expect(detectDeviation([900, null, 1_000, 1_100, 1_200], thresholds)).toBeNull();
    expect(detectDeviation([null, null, null, null], thresholds)).toBeNull();
  });

  it("returns null when there is not yet enough history", () => {
    expect(detectDeviation([9_000, 9_000], thresholds)).toBeNull();
    expect(detectDeviation([], thresholds)).toBeNull();
  });

  it("uses the shipped defaults when none are given", () => {
    const beyond = Array(DEFAULT_THRESHOLDS.deviationPings).fill(
      DEFAULT_THRESHOLDS.deviationMetres + 1,
    );
    expect(detectDeviation(beyond)).not.toBeNull();
  });
});

describe("detectStoppage", () => {
  const thresholds = { stoppageRadiusMetres: 150, stoppageMinutes: 45 };

  it("raises for a vehicle parked beyond the threshold", () => {
    // Twelve fixes five minutes apart: 55 minutes in one place.
    const finding = detectStoppage(samples(12), thresholds, NOW);
    expect(finding).not.toBeNull();
    expect(finding!.minutes).toBe(55);
    expect(finding!.since.getTime()).toBe(NOW.getTime() - 55 * 60_000);
  });

  it("stays quiet for a stop shorter than the threshold", () => {
    expect(detectStoppage(samples(6), thresholds, NOW)).toBeNull();
  });

  it("absorbs GPS jitter rather than reading it as movement", () => {
    // A parked truck whose fixes wander thirty metres is still parked.
    const jittery = samples(12, {
      drift: (i) => destinationPoint(SPOT, (i * 37) % 360, 30),
    });
    expect(detectStoppage(jittery, thresholds, NOW)).not.toBeNull();
  });

  it("does not treat a moving vehicle as stopped", () => {
    const moving = samples(12, {
      drift: (i) => destinationPoint(SPOT, 90, i * 3_000),
    });
    expect(detectStoppage(moving, thresholds, NOW)).toBeNull();
  });

  it("measures only the run ending at the latest fix", () => {
    // Parked for an hour, then drove off in the last ten minutes.
    const parkedThenGone: PositionSample[] = [
      ...samples(12).slice(0, 10),
      { at: new Date(NOW.getTime() - 5 * 60_000), point: destinationPoint(SPOT, 90, 4_000) },
      { at: NOW, point: destinationPoint(SPOT, 90, 9_000) },
    ];
    expect(detectStoppage(parkedThenGone, thresholds, NOW)).toBeNull();
  });

  it("exempts a vehicle sitting inside a known fence", () => {
    // Two hours in a hub is unloading, not a breakdown.
    expect(detectStoppage(samples(24, { insideFence: true }), thresholds, NOW)).toBeNull();
  });

  it("does not stitch a stop either side of a fence visit into one", () => {
    const withHubVisit = samples(24).map((sample, i) =>
      i > 4 && i < 10 ? { ...sample, insideFence: true } : sample,
    );
    const finding = detectStoppage(withHubVisit, thresholds, NOW);
    // Only the run since leaving the hub counts: fixes 10..23, 65 minutes.
    expect(finding!.minutes).toBe(65);
  });

  it("accepts samples in any order", () => {
    const ordered = samples(12);
    expect(detectStoppage([...ordered].reverse(), thresholds, NOW)?.minutes).toBe(
      detectStoppage(ordered, thresholds, NOW)?.minutes,
    );
  });

  it("returns null with too little to go on", () => {
    expect(detectStoppage([], thresholds, NOW)).toBeNull();
    expect(detectStoppage(samples(1), thresholds, NOW)).toBeNull();
  });

  it("counts silence since the last fix towards the stop", () => {
    // Parked for 25 minutes, then nothing for an hour. It is still there.
    const later = new Date(NOW.getTime() + 60 * 60_000);
    expect(detectStoppage(samples(6), thresholds, later)!.minutes).toBe(85);
  });
});

describe("detectSignalLoss", () => {
  const thresholds = { signalLossMinutes: 20 };

  it("stays quiet while pings are arriving", () => {
    expect(
      detectSignalLoss(new Date(NOW.getTime() - 5 * 60_000), NOW, thresholds),
    ).toBeNull();
  });

  it("raises once the silence passes the threshold", () => {
    const finding = detectSignalLoss(new Date(NOW.getTime() - 95 * 60_000), NOW, thresholds);
    expect(finding).toEqual({ minutesSilent: 95 });
  });

  it("fires exactly at the threshold, not a minute later", () => {
    expect(
      detectSignalLoss(new Date(NOW.getTime() - 20 * 60_000), NOW, thresholds),
    ).toEqual({ minutesSilent: 20 });
  });

  it("says nothing about a vehicle that has never reported", () => {
    // An unfitted truck is a fleet-master problem, not an alert every
    // thirty seconds for the rest of the year.
    expect(detectSignalLoss(null, NOW, thresholds)).toBeNull();
    expect(detectSignalLoss(undefined, NOW, thresholds)).toBeNull();
    expect(detectSignalLoss(new Date("nonsense"), NOW, thresholds)).toBeNull();
  });

  it("does not raise on a device clock running ahead of ours", () => {
    expect(
      detectSignalLoss(new Date(NOW.getTime() + 10 * 60_000), NOW, thresholds),
    ).toBeNull();
  });
});

describe("detectOverspeed", () => {
  it("raises only when the speed is sustained", () => {
    expect(detectOverspeed(samples(5, { speedKmph: 92 }), 80)).toEqual({
      peakKmph: 92,
      consecutive: 3,
    });
    expect(detectOverspeed(samples(5, { speedKmph: 60 }), 80)).toBeNull();
  });

  it("ignores a single spike", () => {
    const mostlyLegal = samples(5, { speedKmph: 60 });
    mostlyLegal[2] = { ...mostlyLegal[2], speedKmph: 130 };
    expect(detectOverspeed(mostlyLegal, 80)).toBeNull();
  });

  it("returns null when the device reports no speed", () => {
    expect(detectOverspeed(samples(5), 80)).toBeNull();
  });

  it("returns null for a nonsensical limit", () => {
    expect(detectOverspeed(samples(5, { speedKmph: 92 }), 0)).toBeNull();
    expect(detectOverspeed(samples(5, { speedKmph: 92 }), Number.NaN)).toBeNull();
  });
});
