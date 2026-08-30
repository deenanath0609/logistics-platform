import { describe, expect, it, vi } from "vitest";

// `detector-scan.ts` reaches for Prisma, the tenant context and the
// exception service at module load. `settlementDays` touches none of them,
// so they are stubbed rather than the function being copied out of reach
// of the code it is meant to guard.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/tenant/context", () => ({ currentOrgId: () => "org_test" }));
vi.mock("@/lib/exceptions/service", () => ({ raiseException: async () => null }));

import { DEFAULT_COD_DAY_END_HOUR, settlementDays } from "./detector-scan";
import { IST_OFFSET_MINUTES } from "./policy";

/**
 * Which days the COD reconciliation settles on a given pass.
 *
 * This decides who gets an exception opened against them, and it is the
 * kind of rule that is wrong in exactly one direction at a time: settle
 * too early and every agent still out on the road is flagged for cash
 * they are carrying; settle too late and a day's shortfall is found the
 * morning after it could have been chased.
 *
 * The module had no test file, and the function is the pure half of a
 * detector whose other half is entirely SQL — so this is where the rule
 * can actually be pinned.
 */

/** A UTC instant for a given branch-local (IST) wall clock. */
function ist(ymd: string, hour: number, minute = 0): Date {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MINUTES * 60_000,
  );
}

describe("settlementDays", () => {
  it("settles yesterday and nothing else before the day-end hour", () => {
    const days = settlementDays(ist("2026-08-30", 11), DEFAULT_COD_DAY_END_HOUR);

    expect(days).toHaveLength(1);
    expect(days[0].ymd).toBe("2026-08-29");
  });

  it("adds today once the day-end hour has passed", () => {
    const days = settlementDays(ist("2026-08-30", 22), DEFAULT_COD_DAY_END_HOUR);

    expect(days.map((day) => day.ymd)).toEqual(["2026-08-29", "2026-08-30"]);
  });

  // The boundary is the whole point: one minute early and every agent on
  // the road at 21:59 is holding cash the reconciliation calls missing.
  it("does not settle today one minute before the day-end hour", () => {
    const early = settlementDays(ist("2026-08-30", 21, 59), 22);
    const onTime = settlementDays(ist("2026-08-30", 22, 0), 22);

    expect(early.map((day) => day.ymd)).toEqual(["2026-08-29"]);
    expect(onTime.map((day) => day.ymd)).toEqual(["2026-08-29", "2026-08-30"]);
  });

  it("honours a branch that closes its cash room earlier", () => {
    const days = settlementDays(ist("2026-08-30", 19), 18);

    expect(days.map((day) => day.ymd)).toEqual(["2026-08-29", "2026-08-30"]);
  });

  it("crosses a month boundary correctly", () => {
    const days = settlementDays(ist("2026-09-01", 0, 30), DEFAULT_COD_DAY_END_HOUR);

    expect(days.map((day) => day.ymd)).toEqual(["2026-08-31"]);
  });

  it("crosses a year boundary correctly", () => {
    const days = settlementDays(ist("2027-01-01", 6), DEFAULT_COD_DAY_END_HOUR);

    expect(days.map((day) => day.ymd)).toEqual(["2026-12-31"]);
  });

  it("handles a leap day", () => {
    const days = settlementDays(ist("2028-03-01", 9), DEFAULT_COD_DAY_END_HOUR);

    expect(days.map((day) => day.ymd)).toEqual(["2028-02-29"]);
  });

  // Every day this returns is one whose cash is due. The detector
  // short-circuits on `!dayEndPassed`, so a day that arrived here with it
  // false would be silently skipped rather than settled.
  it("never returns a day whose cash is not yet due", () => {
    for (const hour of [0, 6, 12, 21, 22, 23]) {
      for (const day of settlementDays(ist("2026-08-30", hour), 22)) {
        expect(day.dayEndPassed).toBe(true);
      }
    }
  });

  describe("the window each day spans", () => {
    it("runs from branch-local midnight to the next branch-local midnight", () => {
      const [yesterday] = settlementDays(ist("2026-08-30", 11), DEFAULT_COD_DAY_END_HOUR);

      expect(yesterday.from.toISOString()).toBe("2026-08-28T18:30:00.000Z");
      expect(yesterday.to.toISOString()).toBe("2026-08-29T18:30:00.000Z");
    });

    it("is exactly twenty-four hours wide", () => {
      for (const day of settlementDays(ist("2026-08-30", 23), 22)) {
        expect(day.to.getTime() - day.from.getTime()).toBe(24 * 3_600_000);
      }
    });

    it("leaves no gap between yesterday and today", () => {
      const [yesterday, today] = settlementDays(ist("2026-08-30", 23), 22);

      expect(today).toBeDefined();
      expect(yesterday.to.getTime()).toBe(today.from.getTime());
    });

    // Collections are stamped in UTC. A window built on the server's own
    // midnight instead of the branch's would put an 01:00 IST collection
    // on the wrong day, which is how a shortfall appears and then
    // disappears the next morning.
    it("is a branch-local day, not a UTC one", () => {
      const [yesterday] = settlementDays(ist("2026-08-30", 11), DEFAULT_COD_DAY_END_HOUR);

      // 00:30 IST on the 29th is 19:00 UTC on the 28th, and belongs to
      // the 29th.
      const justAfterLocalMidnight = ist("2026-08-29", 0, 30);
      expect(justAfterLocalMidnight.getTime()).toBeGreaterThanOrEqual(
        yesterday.from.getTime(),
      );
      expect(justAfterLocalMidnight.getTime()).toBeLessThan(yesterday.to.getTime());
    });
  });

  it("follows a carrier in a different timezone", () => {
    // UTC+0. Local midnight is UTC midnight, so at 09:00 UTC on the 30th
    // the settleable day is the 29th, spanning the whole UTC day.
    const days = settlementDays(new Date("2026-08-30T09:00:00.000Z"), 22, 0);

    expect(days.map((day) => day.ymd)).toEqual(["2026-08-29"]);
    expect(days[0].from.toISOString()).toBe("2026-08-29T00:00:00.000Z");
    expect(days[0].to.toISOString()).toBe("2026-08-30T00:00:00.000Z");
  });
});
