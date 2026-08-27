import { getEnv } from "@/lib/env";
import { MOCK_PROVIDER_CODE, createMockProvider } from "./mock";
import type { GpsProvider, ProviderCredentials } from "./types";

export type { GpsProvider, NormalizedPing, ProviderCredentials, SimulatedJourney, WebhookParseResult } from "./types";
export {
  DEFAULT_ROUTE,
  DEFAULT_SPEED_KMPH,
  MOCK_PROVIDER_CODE,
  clearMockJourneys,
  configureMockJourney,
  createMockProvider,
  listMockJourneys,
  simulatePosition,
  simulateTrack,
} from "./mock";

/**
 * Adapter selection.
 *
 * `GPS_PROVIDER` names the default; a `TrackingProviderConfig` row may name
 * a different one per organisation, which is how a fleet split across two
 * telematics contracts — the usual outcome of buying a competitor — stays
 * on one live map.
 *
 * An unknown code throws rather than silently falling back to the mock.
 * Quietly simulating a fleet that is actually being tracked for real is the
 * worst failure this file could have: everything looks healthy and every
 * position is fiction.
 */

export type ProviderFactory = (credentials: ProviderCredentials) => GpsProvider;

const FACTORIES: Record<string, ProviderFactory> = {
  [MOCK_PROVIDER_CODE]: (credentials) =>
    createMockProvider({ webhookSecret: credentials.webhookSecret }),
};

export function knownProviderCodes(): string[] {
  return Object.keys(FACTORIES);
}

export function getGpsProvider(
  code?: string | null,
  credentials: ProviderCredentials = { baseUrl: null, apiKey: null, webhookSecret: null },
): GpsProvider {
  const selected = (code ?? getEnv().GPS_PROVIDER ?? MOCK_PROVIDER_CODE).trim().toLowerCase();
  const factory = FACTORIES[selected];

  if (!factory) {
    throw new Error(
      `Unknown GPS provider "${selected}". Configured adapters: ${knownProviderCodes().join(", ")}. ` +
        `A real vendor adapter is one file in src/lib/tracking/providers implementing GpsProvider.`,
    );
  }

  return factory(credentials);
}

/** True when the platform is running against simulated positions. */
export function isSimulated(code?: string | null): boolean {
  return (code ?? getEnv().GPS_PROVIDER ?? MOCK_PROVIDER_CODE).trim().toLowerCase() === MOCK_PROVIDER_CODE;
}
