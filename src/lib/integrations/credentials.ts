import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { currentTenant } from "@/lib/tenant/context";
import { decryptSecret } from "./secrets";
import type { CredentialKind } from "@/generated/prisma/client";

/**
 * Which account a carrier's traffic actually leaves on.
 *
 * Until now every message on the platform went out through *our* gateway
 * account, read from `process.env`, under the carrier's brand. That is one
 * bill, one rate limit, and one revoked key that takes every carrier down
 * together — and it is the last thing standing between onboarding a new
 * carrier and a code change. `TenantCredential` gives each carrier their own
 * account; this module is where the two are reconciled.
 *
 * ── The fallback is a fact, not a default ────────────────────
 *
 * A carrier with no credential still sends, on the platform's shared
 * account. That has to keep working — a carrier is onboarded weeks before
 * their DLT registration clears — but it must never be *invisible*, because
 * "whose gateway account is this carrier on?" is a question with billing,
 * rate-limit and blast-radius consequences and no operator should have to
 * read code to answer it. So it is surfaced three ways:
 *
 *   1. every resolution carries `source`, which the caller can log or act on;
 *   2. the first time a tenant falls back in a process, a warning naming the
 *      carrier and the service is written to the log (once — a per-message
 *      warning is a warning nobody reads);
 *   3. the operator console renders it per slot on the tenant screen, in
 *      words, next to the button that fixes it.
 *
 * ── All or nothing ───────────────────────────────────────────
 *
 * A carrier is on their own account only when their row carries a secret.
 * A row with settings and no secret is an ordinary onboarding state — a slot
 * opened before the key arrived — and it resolves to the platform account
 * whole. There is deliberately no merging of one carrier's SMTP host with
 * the platform's SMTP password: half a credential is not a credential, and
 * the combination would authenticate as us to a relay that is not ours.
 *
 * ── Failures do not fall back ────────────────────────────────
 *
 * If a stored secret is present but will not decrypt, this throws. Treating
 * a failed decryption as "no credential" would turn one mis-deployed
 * `CREDENTIALS_KEY` into every carrier's traffic silently re-routed onto the
 * platform's bill, which is the exact outcome this table exists to end.
 */

export type CredentialSource =
  /** The carrier's own account. */
  | "tenant"
  /** The platform's shared account, from the environment. */
  | "platform"
  /** Nothing anywhere. The caller must refuse to send. */
  | "none";

export type SmsSettings = {
  /** The header registered on *this* account, where it differs from the org's. */
  senderId: string | null;
  baseUrl: string | null;
};

export type SmtpSettings = {
  host: string | null;
  port: number | null;
  user: string | null;
  /** Implicit TLS, which in practice means port 465. */
  secure: boolean;
};

export type WhatsAppSettings = {
  /** The BSP's id for the carrier's sending number, not the number itself. */
  phoneNumberId: string | null;
  baseUrl: string | null;
};

export type GpsSettings = {
  /** Which adapter in `lib/tracking/providers` speaks to this vendor. */
  providerCode: string | null;
  baseUrl: string | null;
};

export type CredentialSettingsFor = {
  SMS: SmsSettings;
  SMTP: SmtpSettings;
  WHATSAPP: WhatsAppSettings;
  GPS: GpsSettings;
};

export type ResolvedCredential<K extends CredentialKind = CredentialKind> = {
  kind: K;
  source: CredentialSource;
  /** Decrypted. Null only when `source` is "none". */
  secret: string | null;
  settings: CredentialSettingsFor[K];
  /** The carrier this was resolved for, or null outside a tenant. */
  orgId: string | null;
  /** When the carrier's own row last changed. Null on the platform account. */
  updatedAt: Date | null;
};

// ────────────────────────────────────────────────────────────
// Cache
// ────────────────────────────────────────────────────────────

/**
 * Held for a few seconds, for the same reason `carrierIdentity()` is: one
 * outbox event resolves this several times over, and the drain is not a
 * request, so there is no request cache underneath it to lean on.
 *
 * Short on purpose. A key rotated because it leaked has to stop being used
 * in seconds, not on the next deploy — this window is the one place where a
 * revoked key is still in play, and thirty seconds is as long as that is
 * tolerable.
 *
 * The decrypted secret is in here. That is a deliberate trade: the
 * alternative is an AES operation and a query per message, and the plaintext
 * is already in memory at the moment of the send either way.
 */
const TTL_MS = 30_000;

const cache = new Map<string, { value: ResolvedCredential; expires: number }>();

/** Called by tests, and by the console after an operator edits a credential. */
export function resetCredentialCache(): void {
  cache.clear();
  warned.clear();
}

// ────────────────────────────────────────────────────────────
// Resolution
// ────────────────────────────────────────────────────────────

/**
 * The account this carrier's calls to `kind` should be made on.
 *
 * Never throws for a missing credential — "nothing configured anywhere" is
 * `source: "none"`, which each channel turns into its own refusal with its
 * own explanation. It does throw when a stored secret will not decrypt.
 */
export async function credentialFor<K extends CredentialKind>(
  kind: K,
): Promise<ResolvedCredential<K>> {
  const tenant = currentTenant();

  // No tenant: the template preview, a script, the seed, a test. There is
  // no carrier to have an account, so the environment is the only answer —
  // and it is not a "fallback" here, it is the whole configuration.
  if (!tenant) return fromEnvironment(kind, null);

  const cacheKey = `${tenant.orgId}:${kind}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    return hit.value as ResolvedCredential<K>;
  }

  // `findFirst` rather than the compound unique: the tenant extension adds
  // `orgId` to the `where` itself, so naming it here would say the same
  // thing twice and invite the two to disagree.
  const row = await prisma.tenantCredential.findFirst({
    where: { kind },
    select: { secret: true, settings: true, updatedAt: true },
  });

  const value: ResolvedCredential<K> = row?.secret
    ? {
        kind,
        source: "tenant",
        // Bound to this org and kind when it was written; a row moved
        // between tenants fails here rather than authenticating as the
        // wrong carrier. See `lib/integrations/secrets.ts`.
        secret: decryptSecret(row.secret, contextFor(tenant.orgId, kind)),
        settings: settingsFrom(kind, row.settings),
        orgId: tenant.orgId,
        updatedAt: row.updatedAt,
      }
    : fromEnvironment(kind, tenant.orgId);

  if (value.source !== "tenant") warnOnce(tenant.orgId, kind, value.source);

  cache.set(cacheKey, { value, expires: Date.now() + TTL_MS });
  return value;
}

/** The additional authenticated data every stored secret is bound to. */
export function contextFor(orgId: string, kind: CredentialKind): string {
  return `${orgId}:${kind}`;
}

// ────────────────────────────────────────────────────────────
// The platform's shared account
// ────────────────────────────────────────────────────────────

/**
 * The environment variables that served everybody before this table existed.
 *
 * Read straight from `process.env` for everything except the two the
 * environment schema already owns. That is not an oversight: these are
 * credentials, and putting them in `getEnv()` puts them in the object that
 * gets dumped whole into a boot log the first time something is wrong.
 */
function fromEnvironment<K extends CredentialKind>(
  kind: K,
  orgId: string | null,
): ResolvedCredential<K> {
  const secret = trimmed(
    {
      SMS: process.env.SMS_API_KEY,
      SMTP: process.env.SMTP_PASSWORD,
      WHATSAPP: process.env.WHATSAPP_API_KEY,
      GPS: process.env.GPS_API_KEY,
    }[kind],
  );

  return {
    kind,
    source: secret ? "platform" : "none",
    secret,
    settings: environmentSettings(kind),
    orgId,
    updatedAt: null,
  };
}

function environmentSettings<K extends CredentialKind>(
  kind: K,
): CredentialSettingsFor[K] {
  const env = getEnv();

  const all: CredentialSettingsFor = {
    SMS: {
      senderId: trimmed(env.SMS_SENDER_ID),
      baseUrl: null,
    },
    SMTP: {
      host: trimmed(process.env.SMTP_HOST),
      port: port(process.env.SMTP_PORT),
      user: trimmed(process.env.SMTP_USER),
      // The platform relay has never been configured for implicit TLS, and
      // guessing from the port is what the operator screen does too.
      secure: port(process.env.SMTP_PORT) === 465,
    },
    WHATSAPP: {
      phoneNumberId: null,
      baseUrl: null,
    },
    GPS: {
      providerCode: trimmed(env.GPS_PROVIDER),
      baseUrl: trimmed(process.env.GPS_API_BASE),
    },
  };

  return all[kind];
}

// ────────────────────────────────────────────────────────────
// Stored settings
// ────────────────────────────────────────────────────────────

/**
 * Reads the non-secret half of a stored credential.
 *
 * `settings` is JSON an operator typed into a form, so nothing in it is
 * trusted to be the right shape — a missing key and a key holding a number
 * where a string belongs both have to come out as the same "not set" rather
 * than as a value the SMTP client will choke on halfway through a send.
 */
export function settingsFrom<K extends CredentialKind>(
  kind: K,
  raw: unknown,
): CredentialSettingsFor[K] {
  const json = (raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const all: CredentialSettingsFor = {
    SMS: {
      senderId: text(json.senderId),
      baseUrl: text(json.baseUrl),
    },
    SMTP: {
      host: text(json.host),
      port: port(json.port),
      user: text(json.user),
      secure: json.secure === true || json.secure === "true" || port(json.port) === 465,
    },
    WHATSAPP: {
      phoneNumberId: text(json.phoneNumberId),
      baseUrl: text(json.baseUrl),
    },
    GPS: {
      providerCode: text(json.providerCode),
      baseUrl: text(json.baseUrl),
    },
  };

  return all[kind];
}

// ────────────────────────────────────────────────────────────
// Making the shared account visible
// ────────────────────────────────────────────────────────────

const warned = new Set<string>();

/**
 * Says once, per carrier per service per process, that this carrier's
 * traffic is going out on our account.
 *
 * Once rather than per message: a warning printed for every delivery SMS is
 * a warning that gets filtered out of the log within a week, which is worse
 * than not printing it. The operator console is where this is *answered*;
 * this line is what makes it noticeable in the first place.
 */
function warnOnce(orgId: string, kind: CredentialKind, source: CredentialSource): void {
  const seen = `${orgId}:${kind}:${source}`;
  if (warned.has(seen)) return;
  warned.add(seen);

  console.warn(
    source === "platform"
      ? `[credentials] ${orgId} has no ${kind} account of its own; this carrier's ` +
          "traffic is going out on the platform's shared account — our bill, our " +
          "rate limit, and one revoked key away from taking every carrier down. " +
          `Enter their own at /platform/tenants/${orgId}.`
      : `[credentials] ${orgId} has no ${kind} account and neither has the platform. ` +
          "Sends on this channel will be refused rather than attempted.",
  );
}

// ────────────────────────────────────────────────────────────

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function text(value: unknown): string | null {
  return trimmed(value);
}

function port(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}
