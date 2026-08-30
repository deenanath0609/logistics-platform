import { getEnv } from "@/lib/env";
import { clientIpFrom, ipBucketKey } from "@/lib/net/client-ip";
import {
  rateLimitStore,
  type RateLimitRule,
  type RateLimitResult,
} from "@/lib/rate-limit/store";

/**
 * The limits that guard the unauthenticated edges.
 *
 * `/track` accepts an identifier from anyone on the internet, which makes
 * it an enumeration target: LR numbers are sequential, so an unthrottled
 * lookup endpoint hands out the shape of the book of business one request
 * at a time. Throttling it is the whole defence, because the endpoint
 * cannot ask for a credential.
 *
 * The counting itself now lives behind `RateLimitStore`, which is also
 * where the consequences of its in-process implementation are written
 * down. The rules and the caller-identification stay here.
 */

export type { RateLimitRule, RateLimitResult };

/** Public tracking: generous for a person, useless for a scraper. */
export const TRACKING_RULE: RateLimitRule = { limit: 20, windowMs: 60_000 };

/** Portal sign-in, on top of the per-account lockout. */
export const PORTAL_LOGIN_RULE: RateLimitRule = { limit: 10, windowMs: 300_000 };

export function checkRateLimit(
  key: string,
  rule: RateLimitRule = TRACKING_RULE,
  now = Date.now(),
): Promise<RateLimitResult> {
  return rateLimitStore.consume(key, rule, now);
}

/** Test and admin helper. Never called from a request path. */
export function resetRateLimit(key?: string): Promise<void> {
  return rateLimitStore.reset(key);
}

/**
 * The bucket a caller counts against.
 *
 * The address comes from the single trusted-IP derivation, which is told
 * how many proxies stand in front of this process. Before that existed,
 * this function took the leftmost `X-Forwarded-For` value — a number the
 * caller writes — so every limit below could be lifted by rotating a
 * header, and the login throttles in particular stopped a password spray
 * not at all.
 *
 * A throttle still buckets on an untrusted address when that is all there
 * is: a forgeable bucket is weaker than a real one, but far better than
 * one shared bucket in which every anonymous caller throttles every other.
 * `ipBucketKey` keeps the two kinds of address in separate buckets so a
 * forged value cannot exhaust a genuine caller's budget. Authorisation and
 * the audit trail make the opposite choice — see `lib/net/client-ip.ts`.
 */
export function clientKey(headers: Headers, prefix: string): string {
  return ipBucketKey(prefix, clientIpFrom(headers, getEnv().TRUSTED_PROXY_HOPS));
}
