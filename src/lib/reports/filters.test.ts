import { describe, it, expect } from "vitest";
import {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  describeFilters,
  filtersToParams,
  parseFilters,
  rangeDays,
  toDayString,
  trendBuckets,
} from "./filters";

const NOW = new Date("2026-08-27T09:00:00.000Z");

describe("parsing report filters", () => {
  it("covers whole local days at both ends", () => {
    // A report "for the 27th" that stops at midnight UTC drops the last
    // five and a half hours of an Indian working day — which is most of
    // an evening dispatch.
    const filters = parseFilters({ from: "2026-08-27", to: "2026-08-27" }, NOW);

    expect(filters.from.toISOString()).toBe("2026-08-26T18:30:00.000Z");
    expect(filters.to.toISOString()).toBe("2026-08-27T18:29:59.999Z");
    expect(toDayString(filters.from)).toBe("2026-08-27");
    expect(toDayString(filters.to)).toBe("2026-08-27");
  });

  it("defaults to the last month rather than to everything", () => {
    const filters = parseFilters({}, NOW);

    expect(toDayString(filters.to)).toBe("2026-08-27");
    // Thirty days back plus today, so thirty-one calendar days covered.
    expect(rangeDays(filters)).toBe(DEFAULT_RANGE_DAYS + 1);
  });

  it("swaps a reversed range instead of returning nothing", () => {
    // A backwards range is a slip of the calendar picker, not a request
    // for an empty report.
    const filters = parseFilters({ from: "2026-08-27", to: "2026-08-01" }, NOW);

    expect(toDayString(filters.from)).toBe("2026-08-01");
    expect(toDayString(filters.to)).toBe("2026-08-27");
  });

  it("caps an absurd range", () => {
    const filters = parseFilters({ from: "2010-01-01", to: "2026-08-27" }, NOW);
    expect(rangeDays(filters)).toBeLessThanOrEqual(MAX_RANGE_DAYS);
  });

  it("ignores a date that is not one", () => {
    const filters = parseFilters({ from: "last tuesday" }, NOW);
    expect(rangeDays(filters)).toBe(DEFAULT_RANGE_DAYS + 1);
  });

  it("keeps only a mode the system actually has", () => {
    expect(parseFilters({ mode: "PTL" }, NOW).mode).toBe("PTL");
    expect(parseFilters({ mode: "TRAIN" }, NOW).mode).toBeNull();
  });

  it("treats blank parameters as absent", () => {
    const filters = parseFilters({ branchId: "  ", q: "" }, NOW);

    expect(filters.branchId).toBeNull();
    expect(filters.q).toBeNull();
  });

  it("takes the first value of a repeated parameter", () => {
    const filters = parseFilters({ branchId: ["b1", "b2"] }, NOW);
    expect(filters.branchId).toBe("b1");
  });
});

describe("round-tripping filters through the query string", () => {
  it("survives the trip unchanged", () => {
    const original = parseFilters(
      {
        from: "2026-08-01",
        to: "2026-08-27",
        branchId: "branch-1",
        customerId: "cust-9",
        mode: "FTL",
        q: "CL2026",
      },
      NOW,
    );

    const round = parseFilters(filtersToParams(original), NOW);

    expect(round.from.getTime()).toBe(original.from.getTime());
    expect(round.to.getTime()).toBe(original.to.getTime());
    expect(round.branchId).toBe("branch-1");
    expect(round.customerId).toBe("cust-9");
    expect(round.mode).toBe("FTL");
    expect(round.q).toBe("CL2026");
  });

  it("omits what was never set", () => {
    const params = filtersToParams(parseFilters({}, NOW));
    expect(Object.keys(params).sort()).toEqual(["from", "to"]);
  });
});

describe("describing filters", () => {
  it("reads as a sentence for the report header", () => {
    const filters = parseFilters(
      { from: "2026-08-01", to: "2026-08-27", mode: "PTL", q: "DEL" },
      NOW,
    );

    expect(
      describeFilters(filters, { branch: "HUB-DEL", customer: "Acme Ltd" }),
    ).toBe('2026-08-01 to 2026-08-27 · Branch HUB-DEL · Acme Ltd · PTL · "DEL"');
  });

  it("says which end of a half-specified lane is open", () => {
    const filters = parseFilters({ from: "2026-08-01", to: "2026-08-02" }, NOW);

    expect(describeFilters(filters, { origin: "DEL" })).toContain(
      "DEL → anywhere",
    );
  });
});

describe("trend buckets", () => {
  it("gives one bucket per day over a short range", () => {
    const filters = parseFilters({ from: "2026-08-25", to: "2026-08-27" }, NOW);
    const buckets = trendBuckets(filters);

    expect(buckets).toHaveLength(3);
    expect(buckets[0].key).toBe("2026-08-25");
    expect(buckets[2].key).toBe("2026-08-27");
    expect(buckets[2].to.getTime()).toBe(filters.to.getTime());
  });

  it("groups by week once a daily chart would be unreadable", () => {
    // 400 daily points in a 600-pixel chart is 400 unreadable pixels.
    const filters = parseFilters({ from: "2026-01-01", to: "2026-08-27" }, NOW);
    const buckets = trendBuckets(filters);

    expect(buckets.length).toBeLessThan(60);
    expect(buckets[1].from.getTime() - buckets[0].from.getTime()).toBe(
      7 * 86_400_000,
    );
  });
});
