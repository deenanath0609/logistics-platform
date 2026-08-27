/**
 * A small fixed-window rate limiter.
 *
 * `/track` accepts an identifier from anyone on the internet, which makes
 * it an enumeration target: LR numbers are sequential, so an unthrottled
 * lookup endpoint hands out the shape of the book of business one request
 * at a time. Throttling it is the whole defence, because the endpoint
 * cannot ask for a credential.
 *
 * ── PRODUCTION NOTE ──────────────────────────────────────────
 * This counter lives in the process. That is correct for a single node and
 * wrong for anything behind a load balancer or running serverless, where
 * each instance would allow the full budget and a cold start would forget
 * every count. Move it to Redis — `src/lib/redis.ts` is already wired up —
 * before this goes in front of real traffic. The interface below is
 * deliberately the one a Redis implementation would have, so the swap is a
 * change of body, not of callers.
 * ─────────────────────────────────────────────────────────────
 */

export type RateLimitRule = {
  /** Requests allowed inside one window. */
  limit: number;
  windowMs: number;
};

export type RateLimitResult = {
  ok: boolean;
  /** Requests left in the current window. */
  remaining: number;
  /** When the window resets, as epoch milliseconds. */
  resetAt: number;
  /** Seconds to wait before retrying. Zero when the request was allowed. */
  retryAfterSeconds: number;
};

type Counter = { count: number; resetAt: number };

const globalForLimiter = globalThis as unknown as {
  portalRateLimiter: Map<string, Counter> | undefined;
};

// Survives hot reload in development, so a limit is not reset by every
// file save while it is being tested.
const buckets: Map<string, Counter> =
  globalForLimiter.portalRateLimiter ?? new Map();

if (process.env.NODE_ENV !== "production") {
  globalForLimiter.portalRateLimiter = buckets;
}

/** Public tracking: generous for a person, useless for a scraper. */
export const TRACKING_RULE: RateLimitRule = { limit: 20, windowMs: 60_000 };

/** Portal sign-in, on top of the per-account lockout. */
export const PORTAL_LOGIN_RULE: RateLimitRule = { limit: 10, windowMs: 300_000 };

export function checkRateLimit(
  key: string,
  rule: RateLimitRule = TRACKING_RULE,
  now = Date.now(),
): RateLimitResult {
  sweep(now);

  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + rule.windowMs;
    buckets.set(key, { count: 1, resetAt });
    return {
      ok: true,
      remaining: rule.limit - 1,
      resetAt,
      retryAfterSeconds: 0,
    };
  }

  existing.count += 1;

  if (existing.count > rule.limit) {
    return {
      ok: false,
      remaining: 0,
      resetAt: existing.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  return {
    ok: true,
    remaining: rule.limit - existing.count,
    resetAt: existing.resetAt,
    retryAfterSeconds: 0,
  };
}

/** Test and admin helper. Never called from a request path. */
export function resetRateLimit(key?: string): void {
  if (key) buckets.delete(key);
  else buckets.clear();
}

let lastSweep = 0;

/**
 * Drops expired counters so the map cannot grow without bound under a
 * distributed scrape. Cheap because it runs at most once a minute.
 */
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, counter] of buckets) {
    if (counter.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Best-effort client address.
 *
 * Every value here is client-controlled unless a trusted proxy overwrote
 * it, so this identifies a *caller*, not a person, and is only ever used
 * for throttling — never for authorisation, and never stored.
 */
export function clientKey(headers: Headers, prefix: string): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip =
    forwarded ||
    headers.get("x-real-ip") ||
    headers.get("cf-connecting-ip") ||
    "unknown";
  return `${prefix}:${ip}`;
}
