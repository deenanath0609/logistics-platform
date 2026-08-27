import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Partner API key verification.
 *
 * The key itself is shown once, at creation, and never again: only its
 * SHA-256 digest is stored. A stolen database therefore yields no working
 * credentials, which is the whole reason for the arrangement — and it is
 * why "resend the key" is not a feature. A lost key is rotated.
 *
 * Everything below except `generateApiKey` is pure, so the cases that
 * actually matter — revoked, expired, wrong scope, calling from an address
 * outside the allowlist — are ordinary unit tests rather than a live
 * request against a seeded database.
 */

/** Human-visible marker so a leaked key is recognisable in a log. */
export const API_KEY_PREFIX = "clk";

export type ApiKeyRecord = {
  id: string;
  orgId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  /** Permission codes this key may exercise. */
  scopes: string[];
  /** CIDR blocks or bare addresses. Empty means "from anywhere". */
  ipAllowlist: string[];
  customerId: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

export type VerifyFailureCode =
  | "malformed"
  | "unknown"
  | "revoked"
  | "expired"
  | "scope"
  | "ip";

export type VerifyResult =
  | { ok: true; key: ApiKeyRecord }
  | { ok: false; code: VerifyFailureCode; status: number; message: string };

// ────────────────────────────────────────────────────────────
// Issue
// ────────────────────────────────────────────────────────────

export type GeneratedApiKey = {
  /** The only time this value exists. Show it once, store the hash. */
  key: string;
  keyPrefix: string;
  keyHash: string;
};

/**
 * Mints a key.
 *
 * Shape is `clk_<8 hex>_<48 hex>`. The middle segment is a lookup handle,
 * not a secret: it lets one indexed read find the candidate row, so the
 * digest comparison is against exactly one hash rather than all of them.
 */
export function generateApiKey(): GeneratedApiKey {
  const handle = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("hex");
  const key = `${API_KEY_PREFIX}_${handle}_${secret}`;

  return { key, keyPrefix: `${API_KEY_PREFIX}_${handle}`, keyHash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** The indexed handle inside a presented key, or null if it is not one. */
export function keyPrefixOf(presented: string): string | null {
  const match = new RegExp(`^${API_KEY_PREFIX}_([0-9a-f]{8})_([0-9a-f]{48})$`).exec(
    presented.trim(),
  );
  return match ? `${API_KEY_PREFIX}_${match[1]}` : null;
}

/**
 * Pulls the key out of a request header.
 *
 * `Authorization: Bearer <key>` is the documented form. `X-Api-Key` is
 * accepted because half of the integrations that will ever be written
 * against this API are written in a hurry.
 */
export function parseApiKeyHeader(
  authorization: string | null | undefined,
  apiKeyHeader?: string | null,
): string | null {
  const direct = apiKeyHeader?.trim();
  if (direct) return direct;

  const header = authorization?.trim();
  if (!header) return null;

  const bearer = /^(?:Bearer|ApiKey)\s+(.+)$/i.exec(header);
  return (bearer ? bearer[1] : header).trim() || null;
}

// ────────────────────────────────────────────────────────────
// Address checks
// ────────────────────────────────────────────────────────────

function ipv4ToInt(address: string): number | null {
  const parts = address.trim().split(".");
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * Membership of an IPv4 CIDR block, or an exact match for a bare address.
 *
 * IPv6 is compared literally rather than by prefix: an allowlist is a
 * blunt instrument and a wrong IPv6 prefix calculation would be a silent
 * authorisation bug. Exact match is honest about what it does.
 */
export function ipInCidr(address: string, rule: string): boolean {
  const candidate = address.trim();
  const entry = rule.trim();
  if (entry === "") return false;
  if (candidate === entry) return true;

  const [network, bitsText] = entry.split("/");
  if (bitsText === undefined) return false;

  const bits = Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const networkInt = ipv4ToInt(network);
  const candidateInt = ipv4ToInt(candidate);
  if (networkInt === null || candidateInt === null) return false;

  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (networkInt & mask) >>> 0 === (candidateInt & mask) >>> 0;
}

/** An empty allowlist means the key is not address-restricted. */
export function ipAllowed(
  address: string | null | undefined,
  allowlist: readonly string[],
): boolean {
  if (allowlist.length === 0) return true;
  if (!address) return false;
  return allowlist.some((rule) => ipInCidr(address, rule));
}

/** First address in an `X-Forwarded-For` chain — the client, not a proxy. */
export function clientAddress(
  forwardedFor: string | null | undefined,
  realIp?: string | null,
): string | null {
  const first = forwardedFor?.split(",")[0]?.trim();
  return first || realIp?.trim() || null;
}

// ────────────────────────────────────────────────────────────
// Verify
// ────────────────────────────────────────────────────────────

function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Length is not secret — both are hex digests of a fixed size — but the
  // comparison still must not short-circuit on the first differing byte.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The whole check, in the order a caller most needs the answer.
 *
 * Order matters for the message the partner sees: "that key is revoked"
 * and "that key cannot do this" are different support calls, and
 * collapsing both into 401 costs an afternoon at the other end.
 */
export function verifyApiKey(input: {
  presented: string | null;
  record: ApiKeyRecord | null;
  requiredScope?: string;
  address?: string | null;
  now?: Date;
}): VerifyResult {
  const now = input.now ?? new Date();
  const presented = input.presented?.trim() ?? "";

  if (presented === "" || keyPrefixOf(presented) === null) {
    return {
      ok: false,
      code: "malformed",
      status: 401,
      message: "Supply an API key as `Authorization: Bearer <key>`.",
    };
  }

  const record = input.record;
  if (!record || !digestsMatch(hashApiKey(presented), record.keyHash)) {
    return {
      ok: false,
      code: "unknown",
      status: 401,
      message: "That API key is not recognised.",
    };
  }

  if (record.revokedAt && record.revokedAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      code: "revoked",
      status: 401,
      message: "That API key has been revoked.",
    };
  }

  if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      code: "expired",
      status: 401,
      message: "That API key has expired. Issue a new one.",
    };
  }

  if (!ipAllowed(input.address, record.ipAllowlist)) {
    return {
      ok: false,
      code: "ip",
      status: 403,
      message: "That API key is not permitted from this address.",
    };
  }

  if (input.requiredScope && !record.scopes.includes(input.requiredScope)) {
    return {
      ok: false,
      code: "scope",
      status: 403,
      message: `That API key does not carry the \`${input.requiredScope}\` scope.`,
    };
  }

  return { ok: true, key: record };
}
