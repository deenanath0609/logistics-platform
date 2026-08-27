import { describe, expect, it } from "vitest";
import { pointAlongPolyline, polylineLengthMetres, type LatLng } from "./geo";
import {
  computeEta,
  delayMinutes,
  rollingAverageSpeedKmph,
  scheduleEta,
  type EtaSample,
} from "./eta";

/** Delhi → Jaipur, a shade over 235 km great-circle. */
const ROUTE: LatLng[] = [
  { lat: 28.6139, lng: 77.209 },
  { lat: 27.8869, lng: 76.2836 },
  { lat: 26.9124, lng: 75.7873 },
];

const ROUTE_METRES = polylineLengthMetres(ROUTE);
const START = new Date("2026-08-27T06:00:00.000Z");

/** A vehicle that has covered `km` of the lane, with a believable history. */
function fixture(km: number, options: { speedKmph?: number; samples?: number } = {}) {
  const speedKmph = options.speedKmph ?? 45;
  const samples = options.samples ?? 6;
  const now = new Date(START.getTime() + 60 * 60_000);

  const history: EtaSample[] = [];
  for (let i = samples - 1; i >= 0; i--) {
    // Five-minute spacing, walking backwards down the route at `speedKmph`.
    const minutesAgo = i * 5;
    const at = new Date(now.getTime() - minutesAgo * 60_000);
    const metres = Math.max(0, km * 1000 - (speedKmph * 1000 * minutesAgo) / 60);
    history.push({ at, point: pointAlongPolyline(ROUTE, metres)! });
  }

  return {
    now,
    position: history[history.length - 1].point,
    route: ROUTE,
    history,
  };
}

describe("rollingAverageSpeedKmph", () => {
  it("averages distance over time rather than trusting an instantaneous reading", () => {
    const samples: EtaSample[] = [
      { at: new Date(START.getTime()), point: pointAlongPolyline(ROUTE, 0)! },
      { at: new Date(START.getTime() + 30 * 60_000), point: pointAlongPolyline(ROUTE, 25_000)! },
    ];
    // 25 km in half an hour.
    expect(rollingAverageSpeedKmph(samples)).toBeCloseTo(50, 0);
  });

  it("returns null for a single fix — a position is not a speed", () => {
    expect(
      rollingAverageSpeedKmph([{ at: START, point: ROUTE[0] }]),
    ).toBeNull();
    expect(rollingAverageSpeedKmph([])).toBeNull();
  });

  it("returns null when every fix carries the same timestamp", () => {
    expect(
      rollingAverageSpeedKmph([
        { at: START, point: ROUTE[0] },
        { at: START, point: ROUTE[1] },
      ]),
    ).toBeNull();
  });

  it("accepts samples in any order", () => {
    const ordered: EtaSample[] = [
      { at: new Date(START.getTime()), point: pointAlongPolyline(ROUTE, 0)! },
      { at: new Date(START.getTime() + 60 * 60_000), point: pointAlongPolyline(ROUTE, 40_000)! },
    ];
    expect(rollingAverageSpeedKmph([...ordered].reverse())).toBeCloseTo(
      rollingAverageSpeedKmph(ordered)!,
      6,
    );
  });

  it("ignores fixes older than the window", () => {
    const now = new Date(START.getTime() + 120 * 60_000);
    const samples: EtaSample[] = [
      // Two hours ago, a long way back down the lane.
      { at: START, point: pointAlongPolyline(ROUTE, 0)! },
      { at: new Date(now.getTime() - 20 * 60_000), point: pointAlongPolyline(ROUTE, 100_000)! },
      { at: now, point: pointAlongPolyline(ROUTE, 110_000)! },
    ];

    // Only the last twenty minutes count: 10 km in 20 min is 30 km/h.
    expect(rollingAverageSpeedKmph(samples, { now, windowMinutes: 30 })).toBeCloseTo(30, 0);
  });

  it("falls back to the last two fixes when the window is empty", () => {
    // A device that went quiet for an hour still tells us something.
    const now = new Date(START.getTime() + 180 * 60_000);
    const samples: EtaSample[] = [
      { at: START, point: pointAlongPolyline(ROUTE, 0)! },
      { at: new Date(START.getTime() + 60 * 60_000), point: pointAlongPolyline(ROUTE, 45_000)! },
    ];
    expect(rollingAverageSpeedKmph(samples, { now, windowMinutes: 30 })).toBeCloseTo(45, 0);
  });

  it("reads a parked vehicle as zero, not as a small positive number", () => {
    const parked = pointAlongPolyline(ROUTE, 60_000)!;
    const samples: EtaSample[] = [
      { at: START, point: parked },
      { at: new Date(START.getTime() + 10 * 60_000), point: parked },
      { at: new Date(START.getTime() + 20 * 60_000), point: parked },
    ];
    expect(rollingAverageSpeedKmph(samples)).toBe(0);
  });
});

describe("computeEta", () => {
  it("estimates arrival from remaining distance and rolling speed", () => {
    const result = computeEta(fixture(100, { speedKmph: 50 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.coveredKm).toBeCloseTo(100, 0);
    expect(result.remainingKm).toBeCloseTo(ROUTE_METRES / 1000 - 100, 0);
    expect(result.averageSpeedKmph).toBeCloseTo(50, 0);
    expect(result.method).toBe("gps");

    const expectedMinutes = (result.remainingKm / result.averageSpeedKmph) * 60;
    expect(result.minutesRemaining).toBeCloseTo(expectedMinutes, 0);
    expect(result.estimatedArrivalAt.getTime()).toBe(
      fixture(100).now.getTime() + result.minutesRemaining * 60_000,
    );
  });

  it("covered plus remaining always equals the length of the lane", () => {
    for (const km of [5, 50, 120, 200]) {
      const result = computeEta(fixture(km));
      if (!result.ok) continue;
      expect(result.coveredKm + result.remainingKm).toBeCloseTo(ROUTE_METRES / 1000, 0);
    }
  });

  /**
   * The case that produces "arriving 31 December 19:14" in a system that
   * does the division anyway. No estimate is the honest output, and it is
   * also the useful one — a stopped truck needs a stoppage alert, not an
   * arithmetic answer.
   */
  it("declines to estimate for a stationary vehicle rather than returning infinity", () => {
    const parked = pointAlongPolyline(ROUTE, 80_000)!;
    const now = new Date(START.getTime() + 60 * 60_000);
    const result = computeEta({
      now,
      position: parked,
      route: ROUTE,
      history: [
        { at: new Date(now.getTime() - 30 * 60_000), point: parked },
        { at: new Date(now.getTime() - 15 * 60_000), point: parked },
        { at: now, point: parked },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stationary");
    // The distances are still reported: the screen can say how far is left
    // even when it cannot say when.
    expect(result.coveredKm).toBeCloseTo(80, 0);
    expect(result.remainingKm).toBeGreaterThan(0);
  });

  it("declines below the stationary threshold, not only at a dead stop", () => {
    const result = computeEta(fixture(100, { speedKmph: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stationary");
  });

  it("reports a vehicle past its destination as arrived, never as negative distance", () => {
    const now = new Date(START.getTime() + 300 * 60_000);
    // Twenty kilometres beyond the far end of the lane.
    const beyond: LatLng = { lat: 26.7, lng: 75.6 };
    const result = computeEta({
      now,
      position: beyond,
      route: ROUTE,
      history: [
        { at: new Date(now.getTime() - 10 * 60_000), point: ROUTE[2] },
        { at: now, point: beyond },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("arrived");
    expect(result.remainingKm).toBe(0);
    expect(result.coveredKm).toBeGreaterThan(0);
  });

  it("reports a vehicle sitting on the destination as arrived", () => {
    const result = computeEta(fixture(ROUTE_METRES / 1000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("arrived");
  });

  it("declines when there is no planned polyline", () => {
    const now = new Date(START.getTime() + 60 * 60_000);
    for (const route of [[], [ROUTE[0]]]) {
      const result = computeEta({
        now,
        position: ROUTE[0],
        route,
        history: [
          { at: new Date(now.getTime() - 10 * 60_000), point: ROUTE[0] },
          { at: now, point: ROUTE[1] },
        ],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("no-route");
    }
  });

  it("declines when a route has length but no extent", () => {
    // Two identical vertices: a route on paper, nowhere on the ground.
    const result = computeEta({
      now: START,
      position: ROUTE[0],
      route: [ROUTE[0], { ...ROUTE[0] }],
      history: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-route");
  });

  it("declines when there is only one fix to go on", () => {
    const result = computeEta({
      now: START,
      position: pointAlongPolyline(ROUTE, 30_000)!,
      route: ROUTE,
      history: [{ at: START, point: pointAlongPolyline(ROUTE, 30_000)! }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-history");
    expect(result.remainingKm).toBeGreaterThan(0);
  });

  it("refuses an estimate beyond the horizon", () => {
    // A five-kilometre-an-hour crawl over two hundred kilometres is not an
    // ETA, it is a breakdown.
    const result = computeEta(fixture(10, { speedKmph: 2.9 + 0.2 }));
    if (result.ok) {
      expect(result.minutesRemaining).toBeLessThan(72 * 60);
    } else {
      expect(["beyond-horizon", "stationary"]).toContain(result.reason);
    }
  });

  it("measures how far off route the vehicle is", () => {
    const now = new Date(START.getTime() + 60 * 60_000);
    const onRoute = pointAlongPolyline(ROUTE, 100_000)!;
    const offRoute = { lat: onRoute.lat + 0.05, lng: onRoute.lng };

    const result = computeEta({
      now,
      position: offRoute,
      route: ROUTE,
      history: [
        { at: new Date(now.getTime() - 20 * 60_000), point: pointAlongPolyline(ROUTE, 85_000)! },
        { at: now, point: offRoute },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offRouteMetres).toBeGreaterThan(4_000);
  });

  it("rates a thin history as low confidence and a full one as high", () => {
    const thin = computeEta(fixture(100, { samples: 2 }));
    const full = computeEta(fixture(100, { samples: 8 }));

    expect(thin.ok && full.ok).toBe(true);
    if (!thin.ok || !full.ok) return;
    expect(full.confidence).toBe("high");
    expect(["low", "medium"]).toContain(thin.confidence);
  });

  it("drops confidence when the last fix is stale", () => {
    const base = fixture(100);
    const result = computeEta({
      ...base,
      // Nothing heard for an hour: the position is a memory, not a fact.
      now: new Date(base.now.getTime() + 60 * 60_000),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.confidence).toBe("low");
  });
});

describe("scheduleEta", () => {
  it("falls back to the planned arrival for a vehicle with no telematics", () => {
    const planned = new Date("2026-08-28T04:30:00.000Z");
    const result = scheduleEta(planned);
    expect(result).toEqual({
      estimatedArrivalAt: planned,
      method: "schedule",
      confidence: "low",
    });
  });

  it("returns null when there is not even a plan", () => {
    expect(scheduleEta(null)).toBeNull();
    expect(scheduleEta(undefined)).toBeNull();
    expect(scheduleEta(new Date("nonsense"))).toBeNull();
  });
});

describe("delayMinutes", () => {
  it("is positive when late and negative when early", () => {
    const planned = new Date("2026-08-28T04:00:00.000Z");
    expect(delayMinutes(new Date("2026-08-28T05:30:00.000Z"), planned)).toBe(90);
    expect(delayMinutes(new Date("2026-08-28T03:30:00.000Z"), planned)).toBe(-30);
    expect(delayMinutes(planned, planned)).toBe(0);
  });

  it("returns null rather than claiming on time when either side is unknown", () => {
    expect(delayMinutes(null, new Date())).toBeNull();
    expect(delayMinutes(new Date(), null)).toBeNull();
  });
});
