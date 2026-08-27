import type { LatLng } from "../geo";

/**
 * The telematics adapter boundary (docs/BRD.html §B.6).
 *
 * Everything downstream of this interface — dedupe, geofencing, ETA,
 * alerts, the live map — is written against `NormalizedPing` and knows
 * nothing about which vendor is attached. That is the whole point: a
 * telematics contract is a commercial decision made on price and device
 * fitment, and it will be revisited. When it is, one file in this folder
 * is written and nothing else moves.
 *
 * No vendor SDK is imported here. Every provider we are likely to meet
 * speaks HTTP and JSON, and an adapter that owns its own `fetch` is easier
 * to reason about, mock, and rate-limit than one buried in a package.
 */

/** One position fix, in the shape the rest of the system understands. */
export type NormalizedPing = {
  /** Vendor's device identifier, matched against `Vehicle.gpsDeviceId`. */
  deviceId: string;
  lat: number;
  lng: number;
  speedKmph: number | null;
  /** Degrees clockwise from north, 0–359. */
  heading: number | null;
  ignition: boolean | null;
  odometerKm: number | null;
  /**
   * The device clock. Deliberately not the moment we received it: a device
   * that spent an hour in a tunnel flushes its buffer on reconnection, and
   * treating those fixes as current would teleport the truck.
   */
  recordedAt: Date;
  /** Vendor's own id for this record, kept for support conversations. */
  providerRef: string | null;
  /** Adapter code, so a mixed fleet on two vendors stays attributable. */
  provider: string;
};

export type ProviderCredentials = {
  baseUrl: string | null;
  apiKey: string | null;
  webhookSecret: string | null;
};

export type WebhookParseResult =
  | { ok: true; pings: NormalizedPing[] }
  | {
      ok: false;
      /**
       * `signature` means reject with 401 and never look at the body;
       * `payload` means the body was malformed, which is a 400 and a log
       * line rather than a security event.
       */
      reason: "signature" | "payload";
      detail: string;
    };

export interface GpsProvider {
  /** Matches `TrackingProviderConfig.code`. */
  readonly code: string;
  readonly label: string;
  /** Pull, push, or both. Drives which half of the pipeline runs. */
  readonly mode: "poll" | "webhook" | "both";

  /**
   * Pull-based providers. Returns at most one current fix per device;
   * devices the vendor has never heard of are omitted, not errored, because
   * one unfitted truck must not stop the poll for the other forty.
   */
  fetchPositions(deviceIds: string[]): Promise<NormalizedPing[]>;

  /**
   * Push-based providers. Verifies the signature before parsing, and
   * returns a discriminated result rather than throwing — a webhook handler
   * that distinguishes "forged" from "malformed" can answer 401 and 400
   * correctly, and a thrown exception cannot.
   */
  parseWebhook(body: unknown, signature: string | null): WebhookParseResult;
}

/** A vehicle's planned path, handed to the mock so it drives somewhere real. */
export type SimulatedJourney = {
  deviceId: string;
  route: LatLng[];
  /** When the vehicle set off. Progress is measured from here. */
  startedAt: Date;
  /** Cruising speed. Real speed varies around it; see `mock.ts`. */
  speedKmph: number;
  /**
   * Parks the simulated truck this many minutes in, so the stoppage and
   * deviation alerts can be exercised without waiting for a real driver to
   * stop for lunch outside a fence.
   */
  haltAfterMinutes?: number | null;
  /** Metres offset from the planned route, for exercising deviation. */
  lateralOffsetMetres?: number | null;
};
