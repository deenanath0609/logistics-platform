import { z } from "zod";
import {
  bearingDegrees,
  destinationPoint,
  pointAlongPolyline,
  polylineLengthMetres,
  type LatLng,
} from "../geo";
import { verifySignature } from "../signature";
import type {
  GpsProvider,
  NormalizedPing,
  SimulatedJourney,
  WebhookParseResult,
} from "./types";

/**
 * The mock telematics provider.
 *
 * Devices arrive with the trucks, and trucks arrive after a contract, a
 * purchase order, and a fitment appointment. This adapter exists so none of
 * that blocks the pipeline being built, demonstrated, or regression-tested:
 * it drives a plausible vehicle down a real planned route, at a plausible
 * speed, with plausible GPS noise, and every stage downstream — dedupe,
 * fence debounce, arrival propagation, ETA, deviation, stoppage — runs
 * against it exactly as it will against a vendor.
 *
 * `simulatePosition` is PURE and deterministic: the same journey and the
 * same instant always produce the same fix. That matters twice over —
 * tests get a fixture rather than a coin toss, and a poll that runs twice
 * because two server processes started produces one row rather than two,
 * since the `(deviceId, recordedAt)` unique index sees the same pair.
 */

export const MOCK_PROVIDER_CODE = "mock";

/**
 * Where a device with no configured journey drives: the Delhi–Jaipur lane,
 * roughly via Gurugram, Dharuhera, Behror and Shahpura. Six points is not a
 * road, but it is a lane-shaped thing with real coordinates on it, which is
 * enough for the map, the ETA and the deviation check to be about something.
 */
export const DEFAULT_ROUTE: LatLng[] = [
  { lat: 28.6139, lng: 77.209 },
  { lat: 28.4595, lng: 77.0266 },
  { lat: 28.1, lng: 76.79 },
  { lat: 27.8869, lng: 76.2836 },
  { lat: 27.39, lng: 76.05 },
  { lat: 27.1, lng: 75.95 },
  { lat: 26.9124, lng: 75.7873 },
];

/** Cruising speed for a loaded truck on a national highway, in km/h. */
export const DEFAULT_SPEED_KMPH = 42;

// ────────────────────────────────────────────────────────────
// Simulation — pure
// ────────────────────────────────────────────────────────────

/** Deterministic hash of a string, for repeatable "noise". */
function hash(value: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return (h >>> 0) / 4_294_967_295;
}

/**
 * Speed wobble.
 *
 * A truck does not hold one speed for six hours; it slows through towns and
 * runs on the open highway. The cumulative distance is the integral of the
 * speed curve rather than a separate fudge, which keeps distance and speed
 * consistent with each other — an ETA computed from a speed that does not
 * match the distance covered is worse than no ETA.
 */
const WOBBLE_FRACTION = 0.12;
const WOBBLE_PERIOD_HOURS = 0.25;

function distanceMetresAt(journey: SimulatedJourney, elapsedHours: number): number {
  const base = journey.speedKmph * 1000 * elapsedHours;
  const wobble =
    journey.speedKmph *
    1000 *
    WOBBLE_FRACTION *
    WOBBLE_PERIOD_HOURS *
    (1 - Math.cos(elapsedHours / WOBBLE_PERIOD_HOURS));
  return base + wobble;
}

function speedKmphAt(journey: SimulatedJourney, elapsedHours: number): number {
  return (
    journey.speedKmph *
    (1 + WOBBLE_FRACTION * Math.sin(elapsedHours / WOBBLE_PERIOD_HOURS))
  );
}

/**
 * The fix a device would report at a given instant.
 *
 * Returns null before the journey starts — a trip that has not left yet has
 * no position, and inventing one at the origin would fire a departure fence
 * event for a truck still being loaded.
 */
export function simulatePosition(
  journey: SimulatedJourney,
  at: Date,
): NormalizedPing | null {
  const route = journey.route.length >= 2 ? journey.route : DEFAULT_ROUTE;
  const elapsedMs = at.getTime() - journey.startedAt.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;

  const haltMs =
    journey.haltAfterMinutes != null && journey.haltAfterMinutes >= 0
      ? journey.haltAfterMinutes * 60_000
      : null;
  const movingMs = haltMs === null ? elapsedMs : Math.min(elapsedMs, haltMs);
  const halted = haltMs !== null && elapsedMs > haltMs;

  const movingHours = movingMs / 3_600_000;
  const routeLength = polylineLengthMetres(route);
  const rawDistance = distanceMetresAt(journey, movingHours);
  const distance = Math.min(rawDistance, routeLength);
  const arrived = rawDistance >= routeLength;

  const here = pointAlongPolyline(route, distance) ?? route[0];
  // Look a little ahead for a heading; at the very end, look back instead,
  // so a parked vehicle still points the way it was travelling.
  const ahead = pointAlongPolyline(route, Math.min(distance + 250, routeLength)) ?? here;
  const behind = pointAlongPolyline(route, Math.max(distance - 250, 0)) ?? here;
  const heading = arrived ? bearingDegrees(behind, here) : bearingDegrees(here, ahead);

  // GPS noise, plus any deliberate lateral offset used to exercise the
  // deviation alert. Both are deterministic in the device and the minute.
  const noiseSeed = hash(`${journey.deviceId}:${Math.floor(at.getTime() / 60_000)}`);
  const noiseMetres = 3 + noiseSeed * 6;
  const noiseBearing = noiseSeed * 360;
  const offset = journey.lateralOffsetMetres ?? 0;

  let position = destinationPoint(here, noiseBearing, noiseMetres);
  if (offset !== 0) {
    position = destinationPoint(position, (heading + 90) % 360, offset);
  }

  const speed = halted || arrived ? 0 : Math.max(0, speedKmphAt(journey, movingHours));
  const odometerBase = Math.round(hash(journey.deviceId) * 180_000);

  return {
    deviceId: journey.deviceId,
    lat: Number(position.lat.toFixed(7)),
    lng: Number(position.lng.toFixed(7)),
    speedKmph: Number(speed.toFixed(2)),
    heading: Math.round(heading) % 360,
    ignition: !halted,
    odometerKm: odometerBase + Math.round(distance / 1000),
    // Truncated to the second: a device clock does not carry milliseconds,
    // and dedupe on `(deviceId, recordedAt)` only works if the same instant
    // produces the same key twice.
    recordedAt: new Date(Math.floor(at.getTime() / 1000) * 1000),
    providerRef: `mock-${journey.deviceId}-${Math.floor(at.getTime() / 1000)}`,
    provider: MOCK_PROVIDER_CODE,
  };
}

/**
 * A whole journey sampled at a fixed interval.
 *
 * This is what makes an end-to-end test possible without hardware or a
 * clock: six hours of driving becomes a few hundred fixes that can be fed
 * through the pipeline in a millisecond.
 */
export function simulateTrack(
  journey: SimulatedJourney,
  options: { intervalSeconds?: number; count?: number; until?: Date } = {},
): NormalizedPing[] {
  const interval = (options.intervalSeconds ?? 30) * 1000;
  const count =
    options.count ??
    (options.until
      ? Math.max(0, Math.floor((options.until.getTime() - journey.startedAt.getTime()) / interval))
      : 120);

  const pings: NormalizedPing[] = [];
  for (let i = 0; i < count; i++) {
    const ping = simulatePosition(journey, new Date(journey.startedAt.getTime() + i * interval));
    if (ping) pings.push(ping);
  }
  return pings;
}

// ────────────────────────────────────────────────────────────
// Journey registry
// ────────────────────────────────────────────────────────────

/**
 * Held on `globalThis` so the dev server's module reloads do not send every
 * simulated truck back to the depot mid-demonstration.
 */
const globalForMock = globalThis as unknown as {
  mockJourneys: Map<string, SimulatedJourney> | undefined;
};

function registry(): Map<string, SimulatedJourney> {
  globalForMock.mockJourneys ??= new Map();
  return globalForMock.mockJourneys;
}

export function configureMockJourney(journey: SimulatedJourney): void {
  registry().set(journey.deviceId, journey);
}

export function listMockJourneys(): SimulatedJourney[] {
  return [...registry().values()];
}

export function clearMockJourneys(): void {
  registry().clear();
}

/**
 * A device nobody has configured still has to go somewhere.
 *
 * The departure is measured back from the instant being asked about rather
 * than from the wall clock, so a test that drives the fleet through last
 * Tuesday gets a truck that has already left rather than one that has not
 * set off yet.
 */
function journeyFor(
  deviceId: string,
  journeys: Map<string, SimulatedJourney>,
  at: Date,
): SimulatedJourney {
  const configured = journeys.get(deviceId);
  if (configured) return configured;

  // Staggered by a hash of the device id so a yard full of unconfigured
  // trucks does not drive in perfect formation.
  const offsetHours = hash(deviceId) * 5;
  return {
    deviceId,
    route: DEFAULT_ROUTE,
    startedAt: new Date(at.getTime() - offsetHours * 3_600_000),
    speedKmph: DEFAULT_SPEED_KMPH,
  };
}

// ────────────────────────────────────────────────────────────
// Webhook
// ────────────────────────────────────────────────────────────

/**
 * The push payload the mock accepts, and a reasonable lowest common
 * denominator of what vendors send. Coordinates and device id are required;
 * everything else is optional, because a device with no odometer is a
 * device with no odometer and not a malformed delivery.
 */
const pingSchema = z.object({
  deviceId: z.string().trim().min(1).max(80),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  speedKmph: z.coerce.number().min(0).max(300).nullish(),
  heading: z.coerce.number().min(0).max(360).nullish(),
  ignition: z.coerce.boolean().nullish(),
  odometerKm: z.coerce.number().int().min(0).max(9_999_999).nullish(),
  recordedAt: z.coerce.date(),
  providerRef: z.string().trim().max(120).nullish(),
});

const bodySchema = z.union([
  z.object({ pings: z.array(pingSchema).min(1).max(500) }),
  z.array(pingSchema).min(1).max(500),
  pingSchema,
]);

export function parseMockWebhook(
  body: unknown,
  signature: string | null,
  secret: string | null,
): WebhookParseResult {
  const verified = verifySignature({
    secret,
    // The route handler hands us the parsed object and the raw text it came
    // from; only the raw text is ever signed.
    body: typeof body === "string" ? body : JSON.stringify(body),
    signature,
  });
  if (!verified.ok) {
    return {
      ok: false,
      reason: "signature",
      detail:
        verified.reason === "missing"
          ? "Signature or shared secret missing."
          : "Signature does not match the body.",
    };
  }

  const payload = typeof body === "string" ? safeJson(body) : body;
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "payload",
      detail: parsed.error.issues[0]?.message ?? "Unrecognised payload.",
    };
  }

  const raw = Array.isArray(parsed.data)
    ? parsed.data
    : "pings" in parsed.data
      ? parsed.data.pings
      : [parsed.data];

  return {
    ok: true,
    pings: raw.map((entry) => ({
      deviceId: entry.deviceId,
      lat: entry.lat,
      lng: entry.lng,
      speedKmph: entry.speedKmph ?? null,
      heading: entry.heading == null ? null : Math.round(entry.heading) % 360,
      ignition: entry.ignition ?? null,
      odometerKm: entry.odometerKm ?? null,
      recordedAt: new Date(Math.floor(entry.recordedAt.getTime() / 1000) * 1000),
      providerRef: entry.providerRef ?? null,
      provider: MOCK_PROVIDER_CODE,
    })),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// Adapter
// ────────────────────────────────────────────────────────────

export type MockProviderOptions = {
  /** Override the shared registry — used by tests to stay hermetic. */
  journeys?: SimulatedJourney[];
  /** Override the clock, so a test can drive six hours in one call. */
  now?: () => Date;
  webhookSecret?: string | null;
};

export function createMockProvider(options: MockProviderOptions = {}): GpsProvider {
  const local = options.journeys
    ? new Map(options.journeys.map((j) => [j.deviceId, j]))
    : null;
  const now = options.now ?? (() => new Date());

  return {
    code: MOCK_PROVIDER_CODE,
    label: "Simulated fleet (no hardware)",
    mode: "both",

    async fetchPositions(deviceIds: string[]): Promise<NormalizedPing[]> {
      const journeys = local ?? registry();
      const at = now();
      return deviceIds
        .map((deviceId) => simulatePosition(journeyFor(deviceId, journeys, at), at))
        .filter((ping): ping is NormalizedPing => ping !== null);
    },

    parseWebhook(body: unknown, signature: string | null): WebhookParseResult {
      return parseMockWebhook(body, signature, options.webhookSecret ?? null);
    },
  };
}
