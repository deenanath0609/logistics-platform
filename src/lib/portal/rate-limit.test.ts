import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `clientKey` asks the environment how many proxies stand in front of the
 * app, so the environment is stubbed rather than validated here — the same
 * arrangement `integrations/secrets.test.ts` uses.
 */
const env = vi.hoisted(() => ({
  current: { TRUSTED_PROXY_HOPS: 0 } as Record<string, unknown>,
}));

vi.mock("@/lib/env", () => ({ getEnv: () => env.current }));

const { checkRateLimit, clientKey, resetRateLimit, TRACKING_RULE } = await import(
  "./rate-limit"
);
const { parseTrackingQuery, trackingHref, MAX_LOOKUP } = await import("./tracking");

describe("checkRateLimit", () => {
  beforeEach(() => resetRateLimit());

  it("allows exactly the budget and then refuses", async () => {
    const rule = { limit: 3, windowMs: 1000 };
    const now = 1_000_000;

    expect((await checkRateLimit("a", rule, now)).ok).toBe(true);
    expect((await checkRateLimit("a", rule, now)).ok).toBe(true);
    expect((await checkRateLimit("a", rule, now)).ok).toBe(true);

    const refused = await checkRateLimit("a", rule, now);
    expect(refused.ok).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each caller separately", async () => {
    const rule = { limit: 1, windowMs: 1000 };
    const now = 2_000_000;

    expect((await checkRateLimit("ip-a", rule, now)).ok).toBe(true);
    expect((await checkRateLimit("ip-a", rule, now)).ok).toBe(false);
    // One noisy caller must not lock everyone else out.
    expect((await checkRateLimit("ip-b", rule, now)).ok).toBe(true);
  });

  it("opens a fresh window once the old one expires", async () => {
    const rule = { limit: 1, windowMs: 1000 };
    const now = 3_000_000;

    expect((await checkRateLimit("c", rule, now)).ok).toBe(true);
    expect((await checkRateLimit("c", rule, now + 500)).ok).toBe(false);
    expect((await checkRateLimit("c", rule, now + 1001)).ok).toBe(true);
  });

  it("keeps the public tracking budget usable by a person", () => {
    // A despatch clerk checking a screenful of consignments must not be
    // throttled; a scraper walking the LR series must be.
    expect(TRACKING_RULE.limit).toBeGreaterThanOrEqual(10);
    expect(TRACKING_RULE.limit).toBeLessThanOrEqual(60);
  });
});

/**
 * The bug these cover: this function used to return the *leftmost*
 * `X-Forwarded-For` value, which is the one entry a caller writes. A
 * caller who rotated it got a fresh bucket per request, which lifted the
 * public tracking limit, the portal login throttle and the operator
 * console login throttle all at once. Per-account lockouts survived;
 * spraying one password across many accounts was not throttled at all.
 */
describe("clientKey", () => {
  beforeEach(() => {
    env.current = { TRUSTED_PROXY_HOPS: 1 };
  });

  it("does not bucket on the value a caller prepended to the chain", () => {
    const headers = new Headers({
      "x-forwarded-for": "10.9.9.9, 203.0.113.7",
    });
    expect(clientKey(headers, "track")).not.toContain("10.9.9.9");
  });

  it("gives a caller who rotates the forged prefix the same bucket", () => {
    const first = clientKey(
      new Headers({ "x-forwarded-for": "10.9.9.1, 203.0.113.7" }),
      "portal-login",
    );
    const second = clientKey(
      new Headers({ "x-forwarded-for": "10.9.9.2, 203.0.113.7" }),
      "portal-login",
    );
    expect(first).toBe(second);
  });

  it("keeps different callers apart", () => {
    const a = clientKey(new Headers({ "x-forwarded-for": "203.0.113.7" }), "track");
    const b = clientKey(new Headers({ "x-forwarded-for": "203.0.113.8" }), "track");
    expect(a).not.toBe(b);
  });

  it("falls back to a real bucket rather than to no limit at all", () => {
    expect(clientKey(new Headers(), "track")).toContain("unknown");
  });

  it("takes the rightmost hop when no proxy is configured either", () => {
    // With no proxy the address cannot be trusted at all, but the bucket
    // must still not be one the caller picks by writing a header.
    env.current = { TRUSTED_PROXY_HOPS: 0 };
    expect(
      clientKey(new Headers({ "x-forwarded-for": "10.9.9.9, 203.0.113.7" }), "track"),
    ).not.toContain("10.9.9.9");
  });
});

describe("parseTrackingQuery", () => {
  it("accepts commas, spaces and pasted columns alike", () => {
    expect(parseTrackingQuery("CL001, CL002\nCL003 CL004;CL005")).toEqual([
      "CL001",
      "CL002",
      "CL003",
      "CL004",
      "CL005",
    ]);
  });

  it("upper-cases and de-duplicates", () => {
    expect(parseTrackingQuery("cl001, CL001, Cl001")).toEqual(["CL001"]);
  });

  it("caps a lookup so the endpoint cannot be used as a bulk export", () => {
    const many = Array.from({ length: 50 }, (_, i) => `CL${i + 1000}`).join(",");
    expect(parseTrackingQuery(many)).toHaveLength(MAX_LOOKUP);
  });

  it("drops noise that could never be a consignment number", () => {
    expect(parseTrackingQuery("  , ; a  ")).toEqual([]);
    expect(parseTrackingQuery("")).toEqual([]);
  });
});

describe("trackingHref", () => {
  it("gives one consignment a clean shareable path", () => {
    expect(trackingHref(["CL2608250001"])).toBe("/track/CL2608250001");
  });

  it("puts a multi-consignment lookup in the query string", () => {
    expect(trackingHref(["CL001", "CL002"])).toBe("/track?lr=CL001%2CCL002");
  });
});
