import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import { credentialFor } from "@/lib/integrations/credentials";
import { MOCK_PROVIDER_CODE } from "./mock";
import type { ProviderCredentials } from "./types";

/**
 * Whose telematics account this carrier's positions are pulled from.
 *
 * The push half of the pipeline has answered this per carrier since the
 * webhook route learned to identify a sender by whichever configured secret
 * verifies the body. The pull half never did: it read `GPS_PROVIDER` out of
 * the environment and polled every organisation through one vendor account,
 * which is the same failure `lib/integrations/credentials.ts` was written to
 * end for SMS, SMTP and WhatsApp — one bill, one rate limit, and one revoked
 * key that stops every carrier's live map together.
 *
 * ── Three sources, in this order ─────────────────────────────
 *
 *   1. **The carrier's own provider rows.** `TrackingProviderConfig` is
 *      edited by the carrier's own staff at `/tracking/providers` and is the
 *      same table the webhook resolves against, so a carrier who has
 *      configured a vendor is polled through that vendor and nothing else.
 *      Several rows are returned rather than one: an organisation running two
 *      telematics contracts — the ordinary outcome of buying a competitor —
 *      has both fleets on one live map, and picking "the" provider for them
 *      would silently stop polling half their trucks.
 *
 *   2. **The operator-held credential.** `TenantCredential` kind `GPS`,
 *      entered in the platform console and stored encrypted. This is the slot
 *      for a carrier whose vendor account we hold on their behalf and who has
 *      never opened the provider screen.
 *
 *   3. **The environment.** `GPS_PROVIDER`, `GPS_API_BASE`, `GPS_API_KEY` —
 *      which in development means the simulated fleet. Reached through
 *      `credentialFor` rather than read here, so "no account anywhere" and
 *      "the platform's shared account" stay the same two states they are on
 *      every other channel, with the same warning printed once per carrier.
 *
 * A row's `apiKey` is stored as the carrier typed it, not encrypted: it is
 * theirs, entered by their own staff, and it never leaves the server —
 * `loadProviders` reduces it to a boolean at the query. The operator-held
 * credential in (2) is encrypted because it is held *for* them by somebody
 * else. The difference is deliberate and is the reason both exist.
 */

export type PollProviderSource =
  /** A `TrackingProviderConfig` row the carrier configured themselves. */
  | "config"
  /** The carrier's own `TenantCredential`, held by the operator. */
  | "credential"
  /** `GPS_PROVIDER` and friends — the platform's shared account. */
  | "environment";

export type ResolvedPollProvider = {
  source: PollProviderSource;
  /** The provider row this came from, or null for either fallback. */
  configId: string | null;
  /** Adapter code, matched against `knownProviderCodes()` at poll time. */
  code: string;
  credentials: ProviderCredentials;
  /** How often this vendor should be pulled, in seconds. */
  pollIntervalSeconds: number;
  /** Last successful contact, for the due check. Null for the fallbacks. */
  lastPolledAt: Date | null;
};

/**
 * Modes that are pulled from.
 *
 * A row set to `webhook` is not polled at all — the vendor pushes, and
 * polling it as well would double every fix and turn the debounce counters
 * into noise. `both` is pulled *and* pushed, which is how a vendor with an
 * unreliable webhook is run.
 */
const PULLED_MODES = ["poll", "both"];

/**
 * The vendors to pull this carrier's positions from, most specific first.
 *
 * Must be called inside a tenant — it reads tenant-owned rows, and the
 * Prisma extension refuses the query rather than returning every
 * organisation's providers.
 */
export async function resolvePollProviders(): Promise<ResolvedPollProvider[]> {
  const rows = await prisma.trackingProviderConfig.findMany({
    where: { isActive: true, mode: { in: PULLED_MODES } },
    orderBy: { code: "asc" },
    select: {
      id: true,
      code: true,
      baseUrl: true,
      apiKey: true,
      webhookSecret: true,
      pollIntervalSeconds: true,
      lastPolledAt: true,
    },
  });

  if (rows.length > 0) {
    return rows.map((row) => ({
      source: "config" as const,
      configId: row.id,
      code: row.code,
      credentials: {
        baseUrl: row.baseUrl,
        apiKey: row.apiKey,
        webhookSecret: row.webhookSecret,
      },
      pollIntervalSeconds: row.pollIntervalSeconds,
      lastPolledAt: row.lastPolledAt,
    }));
  }

  // No row of their own. `credentialFor` answers the same question for every
  // other channel, including the "nothing anywhere" case and the warning
  // that makes a shared account visible, so it answers it here too.
  const credential = await credentialFor("GPS");
  const env = getEnv();

  return [
    {
      source: credential.source === "tenant" ? "credential" : "environment",
      configId: null,
      code: credential.settings.providerCode ?? env.GPS_PROVIDER ?? MOCK_PROVIDER_CODE,
      credentials: {
        baseUrl: credential.settings.baseUrl,
        apiKey: credential.secret,
        // A pull needs no webhook secret, and the one on the credential row
        // — if a vendor ever shared them — is not this one's to hand out.
        webhookSecret: null,
      },
      pollIntervalSeconds: env.GPS_POLL_INTERVAL_SECONDS,
      lastPolledAt: null,
    },
  ];
}

/**
 * Whether this vendor is due to be pulled again.
 *
 * The process ticks on one interval for everybody; a carrier who asked to be
 * polled every five minutes is skipped on the ticks in between rather than
 * being given a timer of their own. That is the honest limit of this design
 * and worth stating: **a carrier cannot be polled more often than the
 * process tick**, so a row asking for ten seconds under a thirty-second tick
 * gets thirty. Lowering `GPS_POLL_INTERVAL_SECONDS` is what makes the floor
 * lower, for everybody.
 *
 * A fallback provider has no row to remember its last contact on, so it is
 * always due — it is already being asked at exactly the environment's
 * interval, which is the tick itself.
 */
export function isDue(
  provider: ResolvedPollProvider,
  now: Date = new Date(),
): boolean {
  if (!provider.lastPolledAt) return true;

  const elapsed = now.getTime() - provider.lastPolledAt.getTime();
  // A clock that has gone backwards — a VM resumed, an NTP correction —
  // would otherwise park a vendor until the future it thinks it is in
  // arrives. Treated as due instead.
  if (elapsed < 0) return true;

  return elapsed >= provider.pollIntervalSeconds * 1_000;
}
