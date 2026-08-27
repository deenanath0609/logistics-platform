/**
 * Per-key rate limiting.
 *
 * A fixed window held in a plain map, because Redis is not available in
 * this environment and an API without a limit is worse than an API with an
 * approximate one. The consequences of the in-process store are stated
 * rather than hidden: the limit is per instance, and it resets on deploy.
 *
 * `consume` takes its store, its clock and its limits as arguments, so the
 * window arithmetic is testable without waiting for real seconds to pass.
 * Moving to Redis replaces the store, not the caller.
 */

export type RateWindow = { count: number; resetAt: number };

export type RateVerdict = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch milliseconds at which the window rolls over. */
  resetAt: number;
  /** Seconds to wait, for the `Retry-After` header. Zero when allowed. */
  retryAfterSeconds: number;
};

export function consume(
  store: Map<string, RateWindow>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): RateVerdict {
  const existing = store.get(key);

  if (!existing || existing.resetAt <= now) {
    const window: RateWindow = { count: 1, resetAt: now + windowMs };
    store.set(key, window);
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - 1),
      resetAt: window.resetAt,
      retryAfterSeconds: 0,
    };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: existing.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count++;
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    retryAfterSeconds: 0,
  };
}

/** Drops windows that have rolled over, so the map cannot grow forever. */
export function sweep(store: Map<string, RateWindow>, now: number): number {
  let removed = 0;
  for (const [key, window] of store) {
    if (window.resetAt <= now) {
      store.delete(key);
      removed++;
    }
  }
  return removed;
}

const globalForRateLimit = globalThis as unknown as {
  apiRateWindows: Map<string, RateWindow> | undefined;
};

/** The process-wide store used by the v1 route handlers. */
export const apiRateWindows: Map<string, RateWindow> =
  globalForRateLimit.apiRateWindows ?? new Map<string, RateWindow>();

globalForRateLimit.apiRateWindows = apiRateWindows;

export const DEFAULT_RATE_LIMIT = 120;
export const DEFAULT_RATE_WINDOW_MS = 60_000;

/** Convenience wrapper over the shared store with the default window. */
export function consumeApiQuota(
  keyId: string,
  limit = DEFAULT_RATE_LIMIT,
  now = Date.now(),
): RateVerdict {
  if (apiRateWindows.size > 5_000) sweep(apiRateWindows, now);
  return consume(apiRateWindows, keyId, limit, DEFAULT_RATE_WINDOW_MS, now);
}
