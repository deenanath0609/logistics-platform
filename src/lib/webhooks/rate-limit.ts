import {
  rateLimitStore,
  type RateLimitResult,
  type RateLimitRule,
} from "@/lib/rate-limit/store";

/**
 * The limits the partner API runs on.
 *
 * Two of them, guarding different things. The per-key quota is a fair-use
 * budget for a partner who has already authenticated. The failure budget
 * is a brute-force brake on callers who have not: it is counted per
 * address rather than per key, because an attacker guessing keys has no
 * key to count against.
 *
 * The window arithmetic and its in-process store live in
 * `lib/rate-limit/store.ts`, along with a note on what the limits below
 * do and do not mean until a shared store replaces it.
 */

export type RateVerdict = RateLimitResult;

export const DEFAULT_RATE_LIMIT = 120;
export const DEFAULT_RATE_WINDOW_MS = 60_000;

/**
 * Failed authentications tolerated from one address in five minutes.
 *
 * Twenty is far above any integration's accident — a partner with a stale
 * key retries, notices the 401 and stops — and far below the volume a key
 * search needs. Note what a *failed* request costs when it is not braked:
 * a tenant resolution, a key lookup, a SHA-256 and the body parse, all
 * before anything has proved the caller is anybody.
 */
export const AUTH_FAILURE_RULE: RateLimitRule = {
  limit: 20,
  windowMs: 300_000,
};

/** Fair-use budget for one authenticated key. */
export function consumeApiQuota(
  keyId: string,
  limit = DEFAULT_RATE_LIMIT,
  now = Date.now(),
): Promise<RateVerdict> {
  return rateLimitStore.consume(
    `api-key:${keyId}`,
    { limit, windowMs: DEFAULT_RATE_WINDOW_MS },
    now,
  );
}

/**
 * Whether this address has already spent its failure budget.
 *
 * Deliberately a peek rather than a consume: a caller presenting a good
 * key must never be throttled by this limit, however many bad requests
 * came from the same address a moment earlier. Only `noteAuthFailure`
 * spends budget, and only after a request has actually failed.
 */
export function checkAuthFailures(
  bucketKey: string,
  now = Date.now(),
): Promise<RateVerdict> {
  return rateLimitStore.peek(bucketKey, AUTH_FAILURE_RULE, now);
}

/** Charges one failed authentication to the calling address. */
export function noteAuthFailure(
  bucketKey: string,
  now = Date.now(),
): Promise<RateVerdict> {
  return rateLimitStore.consume(bucketKey, AUTH_FAILURE_RULE, now);
}

/**
 * Claims the right to write one durable record for this address's burst.
 *
 * A budget of one over the same window: the first caller past the failure
 * limit gets `ok`, every caller after it does not, and the persistent
 * record is therefore written once per address per window rather than once
 * per bogus request.
 */
export function claimAuthFailureReport(
  bucketKey: string,
  now = Date.now(),
): Promise<RateVerdict> {
  return rateLimitStore.consume(
    `${bucketKey}:reported`,
    { limit: 1, windowMs: AUTH_FAILURE_RULE.windowMs },
    now,
  );
}
