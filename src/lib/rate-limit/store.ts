/**
 * The seam between "this caller has had enough" and "where the count is
 * kept" — the same arrangement `lib/storage/object-store.ts` uses for
 * bytes, and for the same reason.
 *
 * There is no Redis on this machine and no Docker to start one, so writing
 * a Redis implementation now would ship a store nobody could exercise. The
 * in-memory one stays. What changes is that it is now *an* implementation
 * behind an interface rather than *the* implementation inlined into two
 * modules, and every member is async, so the Redis adapter is a new class
 * and one line in `createRateLimitStore()` rather than a rewrite of every
 * caller and every call site's await-ness.
 *
 * ── WHAT IS STILL UNTRUE UNTIL REDIS LANDS ───────────────────
 * Every limit expressed anywhere in this codebase is per *process*, not
 * per deployment. Concretely, with N app instances behind a balancer:
 *
 *  - The stated budget is the real budget only when N = 1. Otherwise the
 *    reachable rate is N × the number, because a caller reaching a
 *    different instance meets a different, empty counter.
 *  - Every counter is lost on deploy, restart and crash. A caller who has
 *    exhausted a five-minute login window gets a fresh one the moment the
 *    process recycles.
 *  - Nothing coordinates: two instances cannot see that together they have
 *    already served the budget.
 *
 * A Redis implementation of this interface fixes all three and changes
 * nothing else: `consume` becomes INCR plus a first-write EXPIRE, `peek`
 * becomes GET plus PTTL, `reset` becomes DEL. The verdict shape, the
 * rules, and every caller stay exactly as they are. `REDIS_URL` and
 * `lib/redis.ts` are already in place for it.
 * ─────────────────────────────────────────────────────────────
 */

export type RateLimitRule = {
  /** Requests allowed inside one window. */
  limit: number;
  windowMs: number;
};

export type RateLimitResult = {
  /** False once the budget for this window is spent. */
  ok: boolean;
  limit: number;
  /** Requests left in the current window. */
  remaining: number;
  /** When the window resets, as epoch milliseconds. */
  resetAt: number;
  /** Seconds to wait before retrying. Zero when the request was allowed. */
  retryAfterSeconds: number;
};

export interface RateLimitStore {
  /** Names the implementation, for logs and for the health endpoint. */
  readonly backend: "memory";

  /** Counts one request against `key` and says whether it may proceed. */
  consume(key: string, rule: RateLimitRule, now?: number): Promise<RateLimitResult>;

  /**
   * Reports the verdict without spending anything.
   *
   * Exists for the failure-throttle in the partner API, where the check has
   * to happen *before* any work and only genuine failures may cost budget.
   * Redis answers it with GET and PTTL.
   */
  peek(key: string, rule: RateLimitRule, now?: number): Promise<RateLimitResult>;

  /** Clears one key, or every key. Tests and administration only. */
  reset(key?: string): Promise<void>;
}

type Counter = { count: number; resetAt: number };

function verdict(
  rule: RateLimitRule,
  count: number,
  resetAt: number,
  now: number,
): RateLimitResult {
  const over = count > rule.limit;
  return {
    ok: !over,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - count),
    resetAt,
    retryAfterSeconds: over ? Math.max(1, Math.ceil((resetAt - now) / 1000)) : 0,
  };
}

/**
 * Fixed windows in a plain map.
 *
 * Correct for one node and honestly wrong for anything else — see the note
 * at the top of this file. A fixed window, not a sliding one, because the
 * burst it permits at a window boundary is a fair trade for arithmetic
 * that is obvious enough to be read and tested.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  readonly backend = "memory" as const;

  private lastSweep = 0;

  constructor(private readonly buckets: Map<string, Counter> = new Map()) {}

  async consume(
    key: string,
    rule: RateLimitRule,
    now: number = Date.now(),
  ): Promise<RateLimitResult> {
    this.sweep(now);

    const existing = this.buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      const resetAt = now + rule.windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return verdict(rule, 1, resetAt, now);
    }

    existing.count += 1;
    return verdict(rule, existing.count, existing.resetAt, now);
  }

  async peek(
    key: string,
    rule: RateLimitRule,
    now: number = Date.now(),
  ): Promise<RateLimitResult> {
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      return verdict(rule, 0, now + rule.windowMs, now);
    }
    return verdict(rule, existing.count, existing.resetAt, now);
  }

  async reset(key?: string): Promise<void> {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }

  /**
   * Drops expired counters so the map cannot grow without bound under a
   * distributed scrape. Cheap because it runs at most once a minute; Redis
   * needs no equivalent, because expiry is the store's own job there.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, counter] of this.buckets) {
      if (counter.resetAt <= now) this.buckets.delete(key);
    }
  }
}

const globalForRateLimit = globalThis as unknown as {
  rateLimitStore: RateLimitStore | undefined;
};

/**
 * The store every limit in the application shares.
 *
 * One instance, held on `globalThis` so a hot reload in development does
 * not hand a tester a fresh budget on every file save. When the Redis
 * adapter exists this is where the choice is made — on `REDIS_URL` being
 * reachable, falling back to memory — and no caller changes.
 */
export function createRateLimitStore(): RateLimitStore {
  return (globalForRateLimit.rateLimitStore ??= new InMemoryRateLimitStore());
}

export const rateLimitStore = createRateLimitStore();
