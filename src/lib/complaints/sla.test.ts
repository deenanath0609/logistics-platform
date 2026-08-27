import { describe, expect, it } from "vitest";
import type { ComplaintStatus } from "@/generated/prisma/client";
import {
  AT_RISK_THRESHOLD,
  ageMinutes,
  breachState,
  deadlinesFrom,
  formatAge,
  isBreached,
  minutesRemaining,
  slaFor,
  type ComplaintClock,
} from "./sla";

const RAISED = new Date("2026-08-27T09:00:00.000Z");

function clock(overrides: Partial<ComplaintClock> = {}): ComplaintClock {
  const { respondBy, resolveBy } = deadlinesFrom(RAISED, "DELAY", "NORMAL");
  return {
    createdAt: RAISED,
    respondBy,
    resolveBy,
    firstResponseAt: null,
    resolvedAt: null,
    status: "OPEN" as ComplaintStatus,
    ...overrides,
  };
}

/** Minutes after the complaint was raised. */
function at(minutes: number): Date {
  return new Date(RAISED.getTime() + minutes * 60_000);
}

describe("slaFor", () => {
  it("gives a missing consignment a tighter response than a billing dispute", () => {
    expect(slaFor("MISSING", "NORMAL").responseMinutes).toBeLessThan(
      slaFor("BILLING", "NORMAL").responseMinutes,
    );
  });

  it("halves the window at HIGH and quarters it at CRITICAL", () => {
    const normal = slaFor("DELAY", "NORMAL");
    expect(slaFor("DELAY", "HIGH").resolutionMinutes).toBe(
      normal.resolutionMinutes / 2,
    );
    expect(slaFor("DELAY", "CRITICAL").resolutionMinutes).toBe(
      normal.resolutionMinutes / 4,
    );
  });

  it("doubles the window at LOW", () => {
    expect(slaFor("OTHER", "LOW").responseMinutes).toBe(
      slaFor("OTHER", "NORMAL").responseMinutes * 2,
    );
  });

  it("never produces a response target under fifteen minutes", () => {
    // PICKUP_ISSUE at CRITICAL is 2 h / 4 = 30 min, so the floor is tested
    // where it actually binds rather than where it happens not to.
    for (const priority of ["CRITICAL", "HIGH", "NORMAL", "LOW"] as const) {
      expect(slaFor("PICKUP_ISSUE", priority).responseMinutes).toBeGreaterThanOrEqual(15);
      expect(slaFor("PICKUP_ISSUE", priority).resolutionMinutes).toBeGreaterThanOrEqual(60);
    }
  });

  it("keeps the response deadline inside the resolution deadline", () => {
    const categories = [
      "DELAY", "DAMAGE", "MISSING", "WRONG_DELIVERY", "BILLING",
      "POD_ISSUE", "PICKUP_ISSUE", "BEHAVIOUR", "OTHER",
    ] as const;

    for (const category of categories) {
      for (const priority of ["CRITICAL", "HIGH", "NORMAL", "LOW"] as const) {
        const target = slaFor(category, priority);
        expect(target.responseMinutes).toBeLessThanOrEqual(target.resolutionMinutes);
      }
    }
  });
});

describe("deadlinesFrom", () => {
  it("stamps both deadlines from the moment it was raised", () => {
    const { respondBy, resolveBy } = deadlinesFrom(RAISED, "DELAY", "NORMAL");
    expect(respondBy).toEqual(at(4 * 60));
    expect(resolveBy).toEqual(at(48 * 60));
  });
});

describe("breachState — boundaries", () => {
  it("is on track at the start", () => {
    expect(breachState(clock(), at(0)).worst).toBe("ON_TRACK");
  });

  it("is still on track one minute before the at-risk threshold", () => {
    // Response window is 240 minutes; 80% of it is 192.
    expect(breachState(clock(), at(191)).response).toBe("ON_TRACK");
  });

  it("turns at risk exactly on the threshold", () => {
    expect(AT_RISK_THRESHOLD).toBe(0.8);
    expect(breachState(clock(), at(192)).response).toBe("AT_RISK");
  });

  it("is not breached at the exact deadline", () => {
    expect(breachState(clock(), at(240)).response).toBe("AT_RISK");
    expect(isBreached(clock(), at(240))).toBe(false);
  });

  it("is breached one millisecond past the deadline", () => {
    const now = new Date(at(240).getTime() + 1);
    expect(breachState(clock(), now).response).toBe("BREACHED");
    expect(isBreached(clock(), now)).toBe(true);
  });

  it("counts a response landing exactly on the deadline as met", () => {
    const state = breachState(
      clock({ firstResponseAt: at(240) }),
      at(300),
    );
    expect(state.response).toBe("MET");
  });

  it("counts a response one millisecond late as breached, and keeps it that way", () => {
    const late = new Date(at(240).getTime() + 1);
    const state = breachState(clock({ firstResponseAt: late }), at(1000));
    expect(state.response).toBe("BREACHED");
    // A late answer does not become on-time later just because it was given.
    expect(breachState(clock({ firstResponseAt: late }), at(100_000)).response).toBe(
      "BREACHED",
    );
  });

  it("measures the two clocks separately", () => {
    // Answered promptly, still unresolved three days later.
    const state = breachState(
      clock({ firstResponseAt: at(30) }),
      at(72 * 60),
    );
    expect(state.response).toBe("MET");
    expect(state.resolution).toBe("BREACHED");
    expect(state.worst).toBe("BREACHED");
  });

  it("reports the worse of the two as the headline state", () => {
    const state = breachState(clock({ firstResponseAt: at(10) }), at(200));
    expect(state.response).toBe("MET");
    expect(state.resolution).toBe("ON_TRACK");
    expect(state.worst).toBe("ON_TRACK");
  });

  it("is untracked when no deadline was ever stamped", () => {
    const state = breachState(
      clock({ respondBy: null, resolveBy: null }),
      at(100_000),
    );
    expect(state).toEqual({
      response: "UNTRACKED",
      resolution: "UNTRACKED",
      worst: "UNTRACKED",
    });
    expect(isBreached(clock({ respondBy: null, resolveBy: null }), at(100_000))).toBe(
      false,
    );
  });

  it("treats a deadline that is not after the raise time as immediately at risk", () => {
    const state = breachState(
      clock({ respondBy: RAISED, resolveBy: RAISED }),
      RAISED,
    );
    expect(state.worst).toBe("AT_RISK");
  });

  it("stops both clocks once the complaint is resolved inside the window", () => {
    const resolved = clock({ firstResponseAt: at(20), resolvedAt: at(600) });
    expect(breachState(resolved, at(500_000))).toEqual({
      response: "MET",
      resolution: "MET",
      worst: "MET",
    });
  });
});

describe("ageMinutes", () => {
  it("counts from raised to now while open", () => {
    expect(ageMinutes(clock(), at(125))).toBe(125);
  });

  it("stops at resolution, not at closure", () => {
    expect(ageMinutes(clock({ resolvedAt: at(90) }), at(10_000))).toBe(90);
  });

  it("never goes negative on a clock skew", () => {
    expect(ageMinutes(clock(), at(-30))).toBe(0);
  });
});

describe("formatAge", () => {
  it("uses minutes under an hour", () => {
    expect(formatAge(0)).toBe("0 m");
    expect(formatAge(59)).toBe("59 m");
  });

  it("uses hours and minutes up to two days", () => {
    expect(formatAge(60)).toBe("1 h");
    expect(formatAge(200)).toBe("3 h 20 m");
  });

  it("switches to days past forty-eight hours", () => {
    expect(formatAge(48 * 60)).toBe("2 d 0 h");
    expect(formatAge(50 * 60 + 30)).toBe("2 d 2 h");
  });
});

describe("minutesRemaining", () => {
  it("is positive before the deadline and negative after it", () => {
    const { respondBy } = deadlinesFrom(RAISED, "DELAY", "NORMAL");
    expect(minutesRemaining(respondBy, at(100))).toBe(140);
    expect(minutesRemaining(respondBy, at(300))).toBe(-60);
  });

  it("has nothing to say about an untracked complaint", () => {
    expect(minutesRemaining(null)).toBeNull();
  });
});
