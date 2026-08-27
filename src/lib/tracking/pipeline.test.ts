import { describe, expect, it } from "vitest";
import {
  destinationPoint,
  distanceToPolyline,
  haversineMetres,
  polylineLengthMetres,
  type LatLng,
} from "./geo";
import {
  EMPTY_FENCE_STATE,
  evaluateFences,
  type FenceDefinition,
  type FenceState,
  type FenceTransition,
} from "./geofence";
import { computeEta, type EtaSample } from "./eta";
import { DEFAULT_THRESHOLDS, detectDeviation, detectStoppage } from "./alerts";
import { signBody, verifySignature } from "./signature";
import {
  DEFAULT_ROUTE,
  createMockProvider,
  simulatePosition,
  simulateTrack,
  type NormalizedPing,
  type SimulatedJourney,
} from "./providers";

/**
 * The whole pipeline, without hardware.
 *
 * This is the test the mock provider exists for. A simulated truck drives
 * the Delhi–Jaipur lane and every stage the real thing will run — dedupe,
 * fence evaluation, debounce, ETA, deviation, stoppage — runs against it
 * here. What it cannot cover is the database writing in `ingest.ts`; what
 * it does cover is every decision that writing depends on.
 */

const DEVICE = "SIM-HR26AB1234";
const DEPARTED_AT = new Date("2026-08-27T02:30:00.000Z");

const ORIGIN = DEFAULT_ROUTE[0];
const DESTINATION = DEFAULT_ROUTE[DEFAULT_ROUTE.length - 1];
const LANE_METRES = polylineLengthMetres(DEFAULT_ROUTE);

function branchFence(id: string, centre: LatLng, radiusMetres = 400): FenceDefinition {
  return {
    id,
    name: `${id} yard`,
    type: "CIRCLE",
    branchId: `branch-${id}`,
    centre,
    radiusMetres,
    ring: null,
    debouncePings: 3,
  };
}

const FENCES = [
  branchFence("delhi", ORIGIN),
  branchFence("jaipur", DESTINATION),
];

const JOURNEY: SimulatedJourney = {
  deviceId: DEVICE,
  route: DEFAULT_ROUTE,
  startedAt: DEPARTED_AT,
  speedKmph: 45,
};

/** Runs a batch of pings through dedupe and the fence machine. */
function drive(
  pings: readonly NormalizedPing[],
  fences: readonly FenceDefinition[] = FENCES,
  initial: FenceState = {
    // The truck starts loaded, in the origin yard.
    insideGeofenceIds: ["delhi"],
    pendingFenceId: null,
    pendingCount: 0,
  },
) {
  const seen = new Set<string>();
  const accepted: NormalizedPing[] = [];
  let duplicates = 0;

  let state = initial;
  const transitions: Array<FenceTransition & { at: Date }> = [];

  for (const ping of pings) {
    const key = `${ping.deviceId}|${ping.recordedAt.toISOString()}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    accepted.push(ping);

    const result = evaluateFences({
      point: { lat: ping.lat, lng: ping.lng },
      fences,
      state,
    });
    state = result.state;
    for (const transition of result.transitions) {
      transitions.push({ ...transition, at: ping.recordedAt });
    }
  }

  return { accepted, duplicates, transitions, state };
}

describe("mock provider", () => {
  it("is deterministic — the same instant always yields the same fix", () => {
    const at = new Date(DEPARTED_AT.getTime() + 90 * 60_000);
    expect(simulatePosition(JOURNEY, at)).toEqual(simulatePosition(JOURNEY, at));
  });

  it("truncates the device clock to whole seconds so dedupe can work", () => {
    const at = new Date(DEPARTED_AT.getTime() + 90 * 60_000 + 437);
    const ping = simulatePosition(JOURNEY, at)!;
    expect(ping.recordedAt.getMilliseconds()).toBe(0);
    expect(simulatePosition(JOURNEY, new Date(at.getTime() + 100))!.recordedAt).toEqual(
      ping.recordedAt,
    );
  });

  it("has no position before the vehicle sets off", () => {
    // Inventing one at the origin would fire a departure for a truck still
    // being loaded.
    expect(simulatePosition(JOURNEY, new Date(DEPARTED_AT.getTime() - 60_000))).toBeNull();
  });

  it("moves the vehicle forward down the lane and never backwards", () => {
    const track = simulateTrack(JOURNEY, { intervalSeconds: 300, count: 60 });
    let previousCovered = -1;
    for (const ping of track) {
      const covered = haversineMetres(ORIGIN, { lat: ping.lat, lng: ping.lng });
      // Noise can nudge a fix by a few metres; progress over five minutes
      // dwarfs it.
      expect(covered).toBeGreaterThan(previousCovered - 50);
      previousCovered = covered;
    }
  });

  it("stays on the planned lane, within GPS noise", () => {
    const track = simulateTrack(JOURNEY, { intervalSeconds: 300, count: 70 });
    for (const ping of track) {
      const off = distanceToPolyline({ lat: ping.lat, lng: ping.lng }, DEFAULT_ROUTE);
      expect(off).not.toBeNull();
      expect(off!).toBeLessThan(20);
    }
  });

  it("parks at the destination rather than driving past it", () => {
    const wayLater = new Date(DEPARTED_AT.getTime() + 24 * 3_600_000);
    const ping = simulatePosition(JOURNEY, wayLater)!;
    expect(haversineMetres({ lat: ping.lat, lng: ping.lng }, DESTINATION)).toBeLessThan(50);
    expect(ping.speedKmph).toBe(0);
  });

  it("reports positions for whatever devices are asked for", async () => {
    const provider = createMockProvider({
      journeys: [JOURNEY],
      now: () => new Date(DEPARTED_AT.getTime() + 60 * 60_000),
    });

    const fixes = await provider.fetchPositions([DEVICE, "SIM-UNKNOWN-DEVICE"]);
    expect(fixes).toHaveLength(2);
    expect(fixes.map((f) => f.deviceId)).toContain(DEVICE);
    // A device nobody configured still drives somewhere, so an unfitted
    // vehicle in the fixture data cannot break a poll for the rest.
    expect(fixes.every((f) => Number.isFinite(f.lat) && Number.isFinite(f.lng))).toBe(true);
  });
});

describe("end to end: one simulated trip, Delhi to Jaipur", () => {
  // Thirty-second polling, eight hours — comfortably longer than the run.
  const track = simulateTrack(JOURNEY, { intervalSeconds: 30, count: 8 * 120 });

  it("produces a plausible number of fixes", () => {
    expect(track.length).toBe(8 * 120);
    expect(track[0].provider).toBe("mock");
  });

  it("records exactly one departure and one arrival", () => {
    const { transitions } = drive(track);

    expect(transitions.map((t) => `${t.direction} ${t.geofenceId}`)).toEqual([
      "EXIT delhi",
      "ENTER jaipur",
    ]);
  });

  it("carries the branch on the arrival, which is what raises the hub event", () => {
    const { transitions } = drive(track);
    const arrival = transitions.find((t) => t.direction === "ENTER")!;
    expect(arrival.branchId).toBe("branch-jaipur");
  });

  it("orders the departure before the arrival in time as well as in sequence", () => {
    const { transitions } = drive(track);
    expect(transitions[0].at.getTime()).toBeLessThan(transitions[1].at.getTime());
  });

  it("arrives roughly when the lane and the speed say it should", () => {
    const { transitions } = drive(track);
    const arrival = transitions[1];
    const hours = (arrival.at.getTime() - DEPARTED_AT.getTime()) / 3_600_000;
    const expected = LANE_METRES / 1000 / JOURNEY.speedKmph;
    expect(hours).toBeGreaterThan(expected * 0.9);
    expect(hours).toBeLessThan(expected * 1.1);
  });

  it("drops a replayed batch instead of arriving twice", () => {
    // The vendor resends, or two server processes poll at once. Neither may
    // produce a second arrival on every consignment aboard.
    const replayed = drive([...track, ...track]);
    const once = drive(track);

    expect(replayed.duplicates).toBe(track.length);
    expect(replayed.accepted).toHaveLength(once.accepted.length);
    expect(replayed.transitions.map((t) => `${t.direction} ${t.geofenceId}`)).toEqual([
      "EXIT delhi",
      "ENTER jaipur",
    ]);
  });

  it("raises no deviation alert for a truck driving its planned lane", () => {
    const distances = track.map((ping) =>
      distanceToPolyline({ lat: ping.lat, lng: ping.lng }, DEFAULT_ROUTE),
    );
    for (let i = DEFAULT_THRESHOLDS.deviationPings; i <= distances.length; i++) {
      expect(detectDeviation(distances.slice(0, i))).toBeNull();
    }
  });

  it("estimates an arrival mid-lane that lands near the real one", () => {
    const twoHoursIn = new Date(DEPARTED_AT.getTime() + 2 * 3_600_000);
    const window = track.filter(
      (p) =>
        p.recordedAt.getTime() <= twoHoursIn.getTime() &&
        p.recordedAt.getTime() > twoHoursIn.getTime() - 30 * 60_000,
    );

    const history: EtaSample[] = window.map((p) => ({
      at: p.recordedAt,
      point: { lat: p.lat, lng: p.lng },
    }));
    const latest = history[history.length - 1];

    const eta = computeEta({
      now: twoHoursIn,
      position: latest.point,
      route: DEFAULT_ROUTE,
      history,
    });

    expect(eta.ok).toBe(true);
    if (!eta.ok) return;

    expect(eta.confidence).toBe("high");
    expect(eta.averageSpeedKmph).toBeGreaterThan(35);
    expect(eta.averageSpeedKmph).toBeLessThan(55);
    expect(eta.coveredKm + eta.remainingKm).toBeCloseTo(LANE_METRES / 1000, 0);

    const { transitions } = drive(track);
    const actualArrival = transitions[1].at;
    const errorMinutes = Math.abs(
      (eta.estimatedArrivalAt.getTime() - actualArrival.getTime()) / 60_000,
    );
    // Within half an hour on a five-and-a-half-hour run.
    expect(errorMinutes).toBeLessThan(30);
  });
});

describe("end to end: the cases the alerts exist for", () => {
  it("catches a truck that stops for two hours in the middle of nowhere", () => {
    const breakdown: SimulatedJourney = { ...JOURNEY, haltAfterMinutes: 120 };
    const track = simulateTrack(breakdown, { intervalSeconds: 300, count: 60 });

    const stopped = track.filter(
      (p) => p.recordedAt.getTime() >= DEPARTED_AT.getTime() + 120 * 60_000,
    );

    const finding = detectStoppage(
      stopped.map((p) => ({
        at: p.recordedAt,
        point: { lat: p.lat, lng: p.lng },
        speedKmph: p.speedKmph,
        insideFence: false,
      })),
    );

    expect(finding).not.toBeNull();
    expect(finding!.minutes).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.stoppageMinutes);
  });

  it("never reaches the destination fence when the truck breaks down early", () => {
    const breakdown: SimulatedJourney = { ...JOURNEY, haltAfterMinutes: 60 };
    const track = simulateTrack(breakdown, { intervalSeconds: 60, count: 12 * 60 });
    const { transitions } = drive(track);

    expect(transitions.map((t) => t.geofenceId)).toEqual(["delhi"]);
    expect(transitions[0].direction).toBe("EXIT");
  });

  it("declines an ETA for the broken-down truck rather than inventing one", () => {
    const breakdown: SimulatedJourney = { ...JOURNEY, haltAfterMinutes: 60 };
    const track = simulateTrack(breakdown, { intervalSeconds: 300, count: 60 });
    const now = new Date(DEPARTED_AT.getTime() + 240 * 60_000);
    const window = track.filter(
      (p) =>
        p.recordedAt.getTime() <= now.getTime() &&
        p.recordedAt.getTime() > now.getTime() - 30 * 60_000,
    );

    const eta = computeEta({
      now,
      position: { lat: window.at(-1)!.lat, lng: window.at(-1)!.lng },
      route: DEFAULT_ROUTE,
      history: window.map((p) => ({ at: p.recordedAt, point: { lat: p.lat, lng: p.lng } })),
    });

    expect(eta.ok).toBe(false);
    if (!eta.ok) expect(eta.reason).toBe("stationary");
  });

  it("catches a truck driven off its planned lane", () => {
    const diverted: SimulatedJourney = { ...JOURNEY, lateralOffsetMetres: 3_000 };
    const track = simulateTrack(diverted, { intervalSeconds: 300, count: 20 });

    const distances = track.map((p) =>
      distanceToPolyline({ lat: p.lat, lng: p.lng }, DEFAULT_ROUTE),
    );
    const finding = detectDeviation(distances);

    expect(finding).not.toBeNull();
    expect(finding!.worstMetres).toBeGreaterThan(DEFAULT_THRESHOLDS.deviationMetres);
  });

  it("does not confuse an idling truck on the yard line with forty arrivals", () => {
    // The whole reason the debounce exists, driven from the provider rather
    // than from hand-written coordinates.
    const onTheLine: NormalizedPing[] = [];
    for (let i = 0; i < 60; i++) {
      const point = destinationPoint(DESTINATION, 90, i % 2 === 0 ? 390 : 410);
      onTheLine.push({
        deviceId: DEVICE,
        lat: point.lat,
        lng: point.lng,
        speedKmph: 0,
        heading: 0,
        ignition: true,
        odometerKm: 100_000,
        recordedAt: new Date(DEPARTED_AT.getTime() + i * 30_000),
        providerRef: `flap-${i}`,
        provider: "mock",
      });
    }

    const { transitions } = drive(onTheLine, FENCES, EMPTY_FENCE_STATE);
    expect(transitions).toEqual([]);
  });
});

describe("webhook signature", () => {
  const secret = "shared-secret-from-the-provider-config";

  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ pings: [{ deviceId: DEVICE }] });
    expect(verifySignature({ secret, body, signature: signBody(secret, body) })).toEqual({
      ok: true,
    });
  });

  it("accepts the common vendor prefixes and base64 digests", () => {
    const body = '{"deviceId":"X"}';
    const hex = signBody(secret, body);
    expect(verifySignature({ secret, body, signature: `sha256=${hex}` }).ok).toBe(true);
    expect(verifySignature({ secret, body, signature: `v1=${hex}` }).ok).toBe(true);
    expect(verifySignature({ secret, body, signature: hex.toUpperCase() }).ok).toBe(true);
    expect(
      verifySignature({
        secret,
        body,
        signature: Buffer.from(hex, "hex").toString("base64"),
      }).ok,
    ).toBe(true);
  });

  it("rejects a body altered after signing", () => {
    const body = '{"deviceId":"X","lat":28.6}';
    const signature = signBody(secret, body);
    const tampered = '{"deviceId":"X","lat":26.9}';
    expect(verifySignature({ secret, body: tampered, signature })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("fails closed when no secret is configured", () => {
    // An endpoint that accepts anything because nobody set a secret would
    // let a stranger write positions for the whole fleet.
    const body = "{}";
    expect(verifySignature({ secret: null, body, signature: "anything" }).ok).toBe(false);
    expect(verifySignature({ secret: "", body, signature: "anything" }).ok).toBe(false);
    expect(verifySignature({ secret, body, signature: null })).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});

describe("provider webhook parsing", () => {
  const secret = "webhook-secret";
  const provider = createMockProvider({ webhookSecret: secret });

  it("parses a signed batch into normalised pings", () => {
    const payload = {
      pings: [
        {
          deviceId: DEVICE,
          lat: 28.6139,
          lng: 77.209,
          speedKmph: 41.5,
          heading: 210,
          ignition: true,
          odometerKm: 128_400,
          recordedAt: "2026-08-27T03:00:00.000Z",
          providerRef: "vendor-1",
        },
      ],
    };
    const body = JSON.stringify(payload);

    const result = provider.parseWebhook(body, signBody(secret, body));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.pings).toHaveLength(1);
    expect(result.pings[0]).toMatchObject({
      deviceId: DEVICE,
      lat: 28.6139,
      lng: 77.209,
      provider: "mock",
      providerRef: "vendor-1",
    });
    expect(result.pings[0].recordedAt.toISOString()).toBe("2026-08-27T03:00:00.000Z");
  });

  it("accepts a bare array and a single object as well as a wrapper", () => {
    const one = {
      deviceId: DEVICE,
      lat: 1,
      lng: 2,
      recordedAt: "2026-08-27T03:00:00.000Z",
    };
    for (const payload of [one, [one]] as const) {
      const body = JSON.stringify(payload);
      const result = provider.parseWebhook(body, signBody(secret, body));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.pings).toHaveLength(1);
    }
  });

  it("fills the optional fields with null rather than guessing", () => {
    const body = JSON.stringify({
      deviceId: DEVICE,
      lat: 1,
      lng: 2,
      recordedAt: "2026-08-27T03:00:00.000Z",
    });
    const result = provider.parseWebhook(body, signBody(secret, body));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pings[0]).toMatchObject({
      speedKmph: null,
      heading: null,
      ignition: null,
      odometerKm: null,
      providerRef: null,
    });
  });

  it("distinguishes a forged delivery from a malformed one", () => {
    const body = JSON.stringify({ pings: [] });

    const forged = provider.parseWebhook(body, "sha256=deadbeef");
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.reason).toBe("signature");

    // Correctly signed, but an empty batch is not a position report.
    const malformed = provider.parseWebhook(body, signBody(secret, body));
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.reason).toBe("payload");
  });

  it("rejects coordinates that are not on the planet", () => {
    const body = JSON.stringify({
      deviceId: DEVICE,
      lat: 999,
      lng: 2,
      recordedAt: "2026-08-27T03:00:00.000Z",
    });
    const result = provider.parseWebhook(body, signBody(secret, body));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("payload");
  });
});
