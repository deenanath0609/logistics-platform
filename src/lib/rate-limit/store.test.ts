import { describe, expect, it } from "vitest";
import { InMemoryRateLimitStore, type RateLimitRule } from "./store";

const RULE: RateLimitRule = { limit: 3, windowMs: 60_000 };

/**
 * The window arithmetic, and the one property the partner API depends on:
 * that a check can be made without spending anything.
 */

describe("InMemoryRateLimitStore.consume", () => {
  it("allows exactly the budget inside one window", async () => {
    const store = new InMemoryRateLimitStore();
    for (let call = 1; call <= 3; call++) {
      expect((await store.consume("key_1", RULE, 1_000)).ok).toBe(true);
    }
  });

  it("refuses the call past the limit and says how long to wait", async () => {
    const store = new InMemoryRateLimitStore();
    for (let call = 1; call <= 3; call++) await store.consume("key_1", RULE, 1_000);

    const verdict = await store.consume("key_1", RULE, 1_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.remaining).toBe(0);
    expect(verdict.retryAfterSeconds).toBe(60);
  });

  it("lets the caller through again once the window rolls over", async () => {
    const store = new InMemoryRateLimitStore();
    for (let call = 1; call <= 3; call++) await store.consume("key_1", RULE, 1_000);
    expect((await store.consume("key_1", RULE, 61_001)).ok).toBe(true);
  });

  it("counts each key separately", async () => {
    const store = new InMemoryRateLimitStore();
    for (let call = 1; call <= 3; call++) await store.consume("key_1", RULE, 1_000);
    // One noisy caller must not lock everyone else out.
    expect((await store.consume("key_2", RULE, 1_000)).ok).toBe(true);
  });

  it("reports the remaining budget honestly", async () => {
    const store = new InMemoryRateLimitStore();
    expect((await store.consume("key_1", RULE, 1_000)).remaining).toBe(2);
    expect((await store.consume("key_1", RULE, 1_000)).remaining).toBe(1);
    expect((await store.consume("key_1", RULE, 1_000)).remaining).toBe(0);
  });
});

describe("InMemoryRateLimitStore.peek", () => {
  it("does not spend budget", async () => {
    // The partner API peeks the failure budget before doing any work, on
    // every request including the ones that will succeed. If peeking cost
    // anything, a partner holding a good key would be throttled by nothing
    // more than their own traffic.
    const store = new InMemoryRateLimitStore();
    for (let call = 1; call <= 20; call++) await store.peek("key_1", RULE, 1_000);
    expect((await store.consume("key_1", RULE, 1_000)).remaining).toBe(2);
  });

  it("reports the refusal once the budget really is spent", async () => {
    const store = new InMemoryRateLimitStore();
    for (let call = 1; call <= 4; call++) await store.consume("key_1", RULE, 1_000);

    const peeked = await store.peek("key_1", RULE, 1_000);
    expect(peeked.ok).toBe(false);
    expect(peeked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("reports a fresh budget for a key nobody has spent", async () => {
    const store = new InMemoryRateLimitStore();
    const peeked = await store.peek("never-seen", RULE, 1_000);
    expect(peeked.ok).toBe(true);
    expect(peeked.remaining).toBe(3);
  });
});

describe("InMemoryRateLimitStore housekeeping", () => {
  it("drops rolled-over windows rather than growing forever", async () => {
    const buckets = new Map<string, { count: number; resetAt: number }>();
    const store = new InMemoryRateLimitStore(buckets);

    await store.consume("key_1", RULE, 1_000);
    await store.consume("key_2", RULE, 1_000);
    expect(buckets.size).toBe(2);

    // The sweep runs at most once a minute, so a later call is what
    // collects the expired pair — this is the path a distributed scrape
    // takes, one fresh key at a time.
    await store.consume("key_3", RULE, 61_001);
    expect(buckets.has("key_1")).toBe(false);
    expect(buckets.has("key_2")).toBe(false);
  });

  it("clears one key, or all of them", async () => {
    const store = new InMemoryRateLimitStore();
    await store.consume("key_1", RULE, 1_000);
    await store.reset("key_1");
    expect((await store.consume("key_1", RULE, 1_000)).remaining).toBe(2);

    await store.consume("key_2", RULE, 1_000);
    await store.reset();
    expect((await store.consume("key_2", RULE, 1_000)).remaining).toBe(2);
  });
});
