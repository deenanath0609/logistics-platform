import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit,
  clientKey,
  resetRateLimit,
  TRACKING_RULE,
} from "./rate-limit";
import { parseTrackingQuery, trackingHref, MAX_LOOKUP } from "./tracking";

describe("checkRateLimit", () => {
  beforeEach(() => resetRateLimit());

  it("allows exactly the budget and then refuses", () => {
    const rule = { limit: 3, windowMs: 1000 };
    const now = 1_000_000;

    expect(checkRateLimit("a", rule, now).ok).toBe(true);
    expect(checkRateLimit("a", rule, now).ok).toBe(true);
    expect(checkRateLimit("a", rule, now).ok).toBe(true);

    const refused = checkRateLimit("a", rule, now);
    expect(refused.ok).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each caller separately", () => {
    const rule = { limit: 1, windowMs: 1000 };
    const now = 2_000_000;

    expect(checkRateLimit("ip-a", rule, now).ok).toBe(true);
    expect(checkRateLimit("ip-a", rule, now).ok).toBe(false);
    // One noisy caller must not lock everyone else out.
    expect(checkRateLimit("ip-b", rule, now).ok).toBe(true);
  });

  it("opens a fresh window once the old one expires", () => {
    const rule = { limit: 1, windowMs: 1000 };
    const now = 3_000_000;

    expect(checkRateLimit("c", rule, now).ok).toBe(true);
    expect(checkRateLimit("c", rule, now + 500).ok).toBe(false);
    expect(checkRateLimit("c", rule, now + 1001).ok).toBe(true);
  });

  it("keeps the public tracking budget usable by a person", () => {
    // A despatch clerk checking a screenful of consignments must not be
    // throttled; a scraper walking the LR series must be.
    expect(TRACKING_RULE.limit).toBeGreaterThanOrEqual(10);
    expect(TRACKING_RULE.limit).toBeLessThanOrEqual(60);
  });
});

describe("clientKey", () => {
  it("prefers the first forwarded address", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      "x-real-ip": "10.0.0.1",
    });
    expect(clientKey(headers, "track")).toBe("track:203.0.113.7");
  });

  it("falls back to a constant rather than to no limit at all", () => {
    expect(clientKey(new Headers(), "track")).toBe("track:unknown");
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
