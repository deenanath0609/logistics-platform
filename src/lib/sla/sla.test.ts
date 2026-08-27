import { describe, it, expect } from "vitest";
import {
  IST_OFFSET_MINUTES,
  addWorkingTime,
  evaluateSlaState,
  formatDuration,
  explainClockStart,
  explainPlan,
  explainWorkingTime,
  planSla,
  policySpecificity,
  resolvePolicy,
  shapeCalendar,
  startOfClock,
  varianceMinutes,
  workingTimeBetween,
  type LaneKey,
  type PolicyCandidate,
  type WorkingCalendar,
} from "./policy";

/**
 * Every expectation here is worked out by hand in the comment above it.
 * A transit calculation nobody can check by hand is a transit calculation
 * nobody will accept when it says their branch breached.
 */

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

/** An instant, given as branch-local wall-clock time (IST). */
function ist(ymd: string, hhmm: string): Date {
  const [year, month, day] = ymd.split("-").map(Number);
  const [hours, minutes] = hhmm.split(":").map(Number);
  return new Date(
    Date.UTC(year, month - 1, day, hours, minutes) -
      IST_OFFSET_MINUTES * 60_000,
  );
}

/** Renders an instant back as branch-local wall-clock, for readable failures. */
function local(at: Date): string {
  const shifted = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

/** Opens 09:00, closes 19:00 (ten working hours), cut-off 18:00, shut Sundays. */
const BRANCH: WorkingCalendar = {
  openingTime: "09:00",
  closingTime: "19:00",
  bookingCutoff: "18:00",
  weeklyOffDays: [0],
  holidays: [],
};

const EXPRESS: PolicyCandidate = {
  id: "pol-express",
  code: "EXP-DEL-JAI",
  name: "Delhi → Jaipur express",
  serviceTypeId: "svc-express",
  originCityId: "city-delhi",
  destinationCityId: "city-jaipur",
  originZoneId: null,
  destinationZoneId: null,
  transitHours: 24,
  useWorkingHours: true,
  respectCutoff: true,
  atRiskPercent: 80,
  priority: 0,
  isActive: true,
};

const LANE: LaneKey = {
  serviceTypeId: "svc-express",
  originCityId: "city-delhi",
  destinationCityId: "city-jaipur",
  originZoneIds: ["zone-north"],
  destinationZoneIds: ["zone-west"],
};

function plan(
  overrides: Partial<PolicyCandidate>,
  startedAt: Date,
  calendar: WorkingCalendar = BRANCH,
  lane: LaneKey = LANE,
) {
  const result = planSla({
    startedAt,
    lane,
    policies: [{ ...EXPRESS, ...overrides }],
    calendar,
  });
  if (result.state !== "SCHEDULED") {
    throw new Error(`Expected a schedule, got ${result.state}`);
  }
  return result;
}

// ────────────────────────────────────────────────────────────
// The cut-off
// ────────────────────────────────────────────────────────────

describe("the booking cut-off", () => {
  it("starts the clock immediately for a booking before cut-off", () => {
    // Tue 25 Aug 10:00, 24 working hours at 10 h/day:
    //   Tue 10:00→19:00  =  9 h   (15 left)
    //   Wed 09:00→19:00  = 10 h   ( 5 left)
    //   Thu 09:00 + 5 h  = 14:00
    const result = plan({}, ist("2026-08-25", "10:00"));

    expect(local(result.startedAt)).toBe("2026-08-25 10:00");
    expect(local(result.dueAt)).toBe("2026-08-27 14:00");
  });

  it("starts the clock next working morning for a booking after cut-off", () => {
    // Tue 25 Aug 18:40 is past the 18:00 cut-off, so the clock starts
    // Wed 09:00:
    //   Wed 09:00→19:00 = 10 h   (14 left)
    //   Thu 09:00→19:00 = 10 h   ( 4 left)
    //   Fri 09:00 + 4 h = 13:00
    const result = plan({}, ist("2026-08-25", "18:40"));

    expect(local(result.startedAt)).toBe("2026-08-26 09:00");
    expect(local(result.dueAt)).toBe("2026-08-28 13:00");
  });

  it("treats a booking exactly on the cut-off as inside it", () => {
    // 18:00 is not "after 18:00". A clerk who makes the deadline made it.
    //   Tue 18:00→19:00 =  1 h   (23 left)
    //   Wed             = 10 h   (13 left)
    //   Thu             = 10 h   ( 3 left)
    //   Fri 09:00 + 3 h = 12:00
    const result = plan({}, ist("2026-08-25", "18:00"));

    expect(local(result.startedAt)).toBe("2026-08-25 18:00");
    expect(local(result.dueAt)).toBe("2026-08-28 12:00");
  });

  it("holds a pre-opening booking until the shutters go up", () => {
    // 07:30 on a working Tuesday: the branch opens at 09:00 and nothing
    // moves before then, so that is when the promise begins.
    const result = plan({}, ist("2026-08-25", "07:30"));

    expect(local(result.startedAt)).toBe("2026-08-25 09:00");
    expect(local(result.dueAt)).toBe("2026-08-27 13:00");
  });

  it("ignores the cut-off when the policy does not respect it", () => {
    // Same 18:40 booking, respectCutoff off: the clock starts where it is,
    // consuming the last 20 minutes of Tuesday.
    //   Tue 18:40→19:00 = 20 m   (23 h 40 m left)
    //   Wed             = 10 h   (13 h 40 m left)
    //   Thu             = 10 h   ( 3 h 40 m left)
    //   Fri 09:00 + 3 h 40 m = 12:40
    const result = plan(
      { respectCutoff: false },
      ist("2026-08-25", "18:40"),
    );

    expect(local(result.startedAt)).toBe("2026-08-25 18:40");
    expect(local(result.dueAt)).toBe("2026-08-28 12:40");
  });
});

// ────────────────────────────────────────────────────────────
// The working calendar
// ────────────────────────────────────────────────────────────

describe("the working calendar", () => {
  it("steps over a weekend inside the transit window", () => {
    // Shut Saturday and Sunday. Fri 28 Aug 10:00, 24 working hours:
    //   Fri 10:00→19:00 =  9 h   (15 left)
    //   Sat, Sun          shut
    //   Mon 31 Aug      = 10 h   ( 5 left)
    //   Tue  1 Sep 09:00 + 5 h = 14:00
    const result = plan({}, ist("2026-08-28", "10:00"), {
      ...BRANCH,
      weeklyOffDays: [0, 6],
    });

    expect(local(result.dueAt)).toBe("2026-09-01 14:00");
  });

  it("steps over a branch holiday", () => {
    // Same start as the first case, but Thursday 27 Aug is a branch
    // holiday, so the last five hours land on Friday instead.
    const result = plan({}, ist("2026-08-25", "10:00"), {
      ...BRANCH,
      holidays: ["2026-08-27"],
    });

    expect(local(result.dueAt)).toBe("2026-08-28 14:00");
  });

  it("starts a booking taken on a closed day the next working morning", () => {
    // Sunday 30 Aug: the branch is shut, so the clock starts Monday 09:00.
    //   Mon 31 Aug = 10 h   (14 left)
    //   Tue  1 Sep = 10 h   ( 4 left)
    //   Wed  2 Sep 09:00 + 4 h = 13:00
    const result = plan({}, ist("2026-08-30", "11:00"));

    expect(local(result.startedAt)).toBe("2026-08-31 09:00");
    expect(local(result.dueAt)).toBe("2026-09-02 13:00");
  });

  it("lands exactly on closing time rather than rolling to the morning", () => {
    // Tue 09:00 + 10 working hours is 19:00 the same day. A promise met in
    // the last minute of the day was met.
    const result = plan(
      { transitHours: 10 },
      ist("2026-08-25", "09:00"),
    );

    expect(local(result.dueAt)).toBe("2026-08-25 19:00");
  });

  it("falls back to default hours when a branch closes before it opens", () => {
    const shape = shapeCalendar({ openingTime: "19:00", closingTime: "09:00" });

    expect(shape.openingMs).toBe(9 * 3_600_000);
    expect(shape.closingMs).toBe(19 * 3_600_000);
  });

  it("ignores a calendar that marks every day as a weekly off", () => {
    // Seven days off is a typo, not a calendar. Honouring it would push
    // every due date past the search guard and turn the tower green.
    const shape = shapeCalendar({ weeklyOffDays: [0, 1, 2, 3, 4, 5, 6] });
    const due = addWorkingTime(ist("2026-08-25", "10:00"), 3_600_000, shape);

    expect(local(due)).toBe("2026-08-25 11:00");
  });

  it("measures working time between two instants", () => {
    // Tue 17:00 → Thu 11:00, ten-hour days, no closures between:
    //   Tue 17:00→19:00 = 2 h
    //   Wed             = 10 h
    //   Thu 09:00→11:00 = 2 h
    const shape = shapeCalendar(BRANCH);
    const minutes =
      workingTimeBetween(
        ist("2026-08-25", "17:00"),
        ist("2026-08-27", "11:00"),
        shape,
      ) / 60_000;

    expect(minutes).toBe(14 * 60);
  });

  it("counts no working time across a closed day", () => {
    const shape = shapeCalendar({ ...BRANCH, weeklyOffDays: [0, 6] });
    const minutes =
      workingTimeBetween(
        ist("2026-08-29", "10:00"),
        ist("2026-08-30", "18:00"),
        shape,
      ) / 60_000;

    expect(minutes).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────
// Wall-clock policies
// ────────────────────────────────────────────────────────────

describe("a policy that does not use working hours", () => {
  it("runs straight through the weekend", () => {
    // Fri 28 Aug 10:00 + 24 wall-clock hours = Sat 29 Aug 10:00, even
    // though the branch is shut on Saturday. Some lanes really are
    // promised in elapsed time — a hotshot courier does not stop for the
    // weekend — and the flag exists to say so.
    const result = plan(
      { useWorkingHours: false, respectCutoff: false },
      ist("2026-08-28", "10:00"),
      { ...BRANCH, weeklyOffDays: [0, 6] },
    );

    expect(local(result.startedAt)).toBe("2026-08-28 10:00");
    expect(local(result.dueAt)).toBe("2026-08-29 10:00");
  });

  it("still honours the cut-off when asked to", () => {
    // The two flags are independent: elapsed-time transit, but a booking
    // that missed the counter still waits for the counter to reopen.
    // Fri 18:40 → Mon 09:00 start, + 24 wall hours = Tue 09:00.
    const result = plan(
      { useWorkingHours: false, respectCutoff: true },
      ist("2026-08-28", "18:40"),
      { ...BRANCH, weeklyOffDays: [0, 6] },
    );

    expect(local(result.startedAt)).toBe("2026-08-31 09:00");
    expect(local(result.dueAt)).toBe("2026-09-01 09:00");
  });

  it("computes at-risk on the same wall clock", () => {
    // 80% of 24 h = 19 h 12 m. Fri 10:00 + 19 h 12 m = Sat 05:12.
    const result = plan(
      { useWorkingHours: false, respectCutoff: false },
      ist("2026-08-28", "10:00"),
      { ...BRANCH, weeklyOffDays: [0, 6] },
    );

    expect(local(result.atRiskAt)).toBe("2026-08-29 05:12");
  });
});

// ────────────────────────────────────────────────────────────
// The at-risk threshold
// ────────────────────────────────────────────────────────────

describe("the at-risk threshold", () => {
  // Tue 25 Aug 10:00, 24 working hours, 80% at risk:
  //   80% of 24 h = 19 h 12 m
  //   Tue 10:00→19:00 =  9 h        (10 h 12 m left)
  //   Wed             = 10 h        (     12 m left)
  //   Thu 09:00 + 12 m = 09:12
  const scheduled = plan({}, ist("2026-08-25", "10:00"));

  it("lands where the working-hours arithmetic says", () => {
    expect(local(scheduled.atRiskAt)).toBe("2026-08-27 09:12");
    expect(local(scheduled.dueAt)).toBe("2026-08-27 14:00");
  });

  it("is on time a millisecond before the threshold", () => {
    const now = new Date(scheduled.atRiskAt.getTime() - 1);
    expect(
      evaluateSlaState(
        { dueAt: scheduled.dueAt, atRiskAt: scheduled.atRiskAt, settledAt: null },
        now,
      ),
    ).toBe("ON_TIME");
  });

  it("is at risk exactly on the threshold", () => {
    expect(
      evaluateSlaState(
        { dueAt: scheduled.dueAt, atRiskAt: scheduled.atRiskAt, settledAt: null },
        scheduled.atRiskAt,
      ),
    ).toBe("AT_RISK");
  });

  it("is still at risk exactly on the deadline", () => {
    expect(
      evaluateSlaState(
        { dueAt: scheduled.dueAt, atRiskAt: scheduled.atRiskAt, settledAt: null },
        scheduled.dueAt,
      ),
    ).toBe("AT_RISK");
  });

  it("breaches a millisecond after the deadline", () => {
    expect(
      evaluateSlaState(
        { dueAt: scheduled.dueAt, atRiskAt: scheduled.atRiskAt, settledAt: null },
        new Date(scheduled.dueAt.getTime() + 1),
      ),
    ).toBe("BREACHED");
  });

  it("counts a delivery on the deadline as met", () => {
    expect(
      evaluateSlaState(
        {
          dueAt: scheduled.dueAt,
          atRiskAt: scheduled.atRiskAt,
          settledAt: scheduled.dueAt,
        },
        new Date(scheduled.dueAt.getTime() + 86_400_000),
      ),
    ).toBe("MET");
  });

  it("counts a delivery a minute late as breached, however early it is read", () => {
    const settledAt = new Date(scheduled.dueAt.getTime() + 60_000);

    expect(
      evaluateSlaState(
        { dueAt: scheduled.dueAt, atRiskAt: scheduled.atRiskAt, settledAt },
        settledAt,
      ),
    ).toBe("BREACHED");
    expect(varianceMinutes(scheduled.dueAt, settledAt)).toBe(1);
  });

  it("reports how early an early delivery was", () => {
    const settledAt = new Date(scheduled.dueAt.getTime() - 90 * 60_000);
    expect(varianceMinutes(scheduled.dueAt, settledAt)).toBe(-90);
  });

  it("puts a zero-percent threshold at the start of the clock", () => {
    const result = plan({ atRiskPercent: 0 }, ist("2026-08-25", "10:00"));
    expect(result.atRiskAt.getTime()).toBe(result.startedAt.getTime());
  });
});

// ────────────────────────────────────────────────────────────
// Policy resolution
// ────────────────────────────────────────────────────────────

describe("policy resolution", () => {
  const cityPair = EXPRESS;

  const zonePair: PolicyCandidate = {
    ...EXPRESS,
    id: "pol-zone",
    code: "EXP-N-W",
    originCityId: null,
    destinationCityId: null,
    originZoneId: "zone-north",
    destinationZoneId: "zone-west",
    transitHours: 48,
  };

  const serviceDefault: PolicyCandidate = {
    ...EXPRESS,
    id: "pol-service",
    code: "EXP-DEFAULT",
    originCityId: null,
    destinationCityId: null,
    originZoneId: null,
    destinationZoneId: null,
    transitHours: 72,
  };

  const networkDefault: PolicyCandidate = {
    ...serviceDefault,
    id: "pol-network",
    code: "ALL-DEFAULT",
    serviceTypeId: null,
    transitHours: 96,
  };

  it("prefers the city pair over the zone pair and the defaults", () => {
    const match = resolvePolicy(
      [networkDefault, serviceDefault, zonePair, cityPair],
      LANE,
    );

    expect(match?.policy.id).toBe("pol-express");
    expect(match?.matchedOn).toBe("city");
  });

  it("falls back to the zone pair when no city pair covers the lane", () => {
    const match = resolvePolicy([networkDefault, serviceDefault, zonePair], LANE);

    expect(match?.policy.id).toBe("pol-zone");
    expect(match?.matchedOn).toBe("zone");
  });

  it("falls back to the service default when no geography matches", () => {
    const match = resolvePolicy([networkDefault, serviceDefault], LANE);

    expect(match?.policy.id).toBe("pol-service");
    expect(match?.matchedOn).toBe("service");
  });

  it("falls back to a network default that names no service", () => {
    const match = resolvePolicy([networkDefault], LANE);

    expect(match?.policy.id).toBe("pol-network");
    expect(match?.matchedOn).toBe("network");
  });

  it("skips a policy for a different service", () => {
    const match = resolvePolicy([cityPair], {
      ...LANE,
      serviceTypeId: "svc-surface",
    });

    expect(match).toBeNull();
  });

  it("skips an inactive policy", () => {
    const match = resolvePolicy(
      [{ ...cityPair, isActive: false }, serviceDefault],
      LANE,
    );

    expect(match?.policy.id).toBe("pol-service");
  });

  it("lets an explicit priority outrank specificity", () => {
    // A festival-season override is the only reason this field exists:
    // without it there is no way to say "no, this one, whatever your
    // scoring thinks".
    const override: PolicyCandidate = {
      ...serviceDefault,
      id: "pol-diwali",
      code: "DIWALI",
      priority: 10,
    };

    const match = resolvePolicy([cityPair, override], LANE);
    expect(match?.policy.id).toBe("pol-diwali");
  });
});

// ────────────────────────────────────────────────────────────
// Lanes with nothing to measure
// ────────────────────────────────────────────────────────────

describe("a lane with no policy", () => {
  it("is NOT_APPLICABLE rather than an invented commitment", () => {
    const result = planSla({
      startedAt: ist("2026-08-25", "10:00"),
      lane: { ...LANE, serviceTypeId: "svc-surface" },
      policies: [EXPRESS],
      calendar: BRANCH,
    });

    expect(result.state).toBe("NOT_APPLICABLE");
    if (result.state === "NOT_APPLICABLE") {
      expect(result.reason).toMatch(/No SLA policy/i);
    }
  });

  it("is NOT_APPLICABLE when the matched policy promises nothing", () => {
    const result = planSla({
      startedAt: ist("2026-08-25", "10:00"),
      lane: LANE,
      policies: [{ ...EXPRESS, transitHours: 0 }],
      calendar: BRANCH,
    });

    expect(result.state).toBe("NOT_APPLICABLE");
    if (result.state === "NOT_APPLICABLE") {
      expect(result.reason).toContain("EXP-DEL-JAI");
    }
  });

  it("reads NOT_APPLICABLE from an empty policy set", () => {
    const result = planSla({
      startedAt: ist("2026-08-25", "10:00"),
      lane: LANE,
      policies: [],
      calendar: BRANCH,
    });

    expect(result.state).toBe("NOT_APPLICABLE");
  });
});

// ────────────────────────────────────────────────────────────
// Odds and ends
// ────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("leaves the clock alone when neither calendar rule applies", () => {
    const at = ist("2026-08-30", "23:15");
    const shape = shapeCalendar(BRANCH);

    expect(
      startOfClock(at, shape, {
        useWorkingHours: false,
        respectCutoff: false,
      }).getTime(),
    ).toBe(at.getTime());
  });

  it("formats durations the way the ageing columns read", () => {
    expect(formatDuration(45)).toBe("45 m");
    expect(formatDuration(60)).toBe("1 h");
    expect(formatDuration(200)).toBe("3 h 20 m");
    expect(formatDuration(60 * 50)).toBe("2 d 2 h");
    expect(formatDuration(-200)).toBe("3 h 20 m");
  });
});

// ────────────────────────────────────────────────────────────
// Showing the working
//
// The admin screen's "test a lane" control prints these. They are the
// same functions the scanner runs — `startOfClock`, `addWorkingTime` and
// `planSla` are thin calls onto the explaining versions — and this block
// exists to keep them that way. A second implementation "for the UI"
// would drift within a month, and the screen whose whole job is
// explaining the maths would be the one lying about it.
// ────────────────────────────────────────────────────────────

describe("explaining the clock", () => {
  it("agrees with startOfClock, rule for rule", () => {
    const options = { useWorkingHours: true, respectCutoff: true };
    const shape = shapeCalendar(BRANCH);

    for (const at of [
      ist("2026-08-25", "10:00"), // inside hours
      ist("2026-08-25", "18:40"), // past cut-off
      ist("2026-08-25", "07:30"), // before opening
      ist("2026-08-30", "11:00"), // a Sunday
      ist("2026-08-25", "19:30"), // after closing
    ]) {
      expect(explainClockStart(at, shape, options).at.getTime()).toBe(
        startOfClock(at, shape, options).getTime(),
      );
    }
  });

  it("names the cut-off rule that moved a Friday-evening booking", () => {
    const explained = explainClockStart(
      ist("2026-08-28", "18:40"),
      shapeCalendar(BRANCH),
      { useWorkingHours: true, respectCutoff: true },
    );

    expect(explained.steps.map((step) => step.rule)).toEqual(["Cut-off missed"]);
    expect(explained.steps[0].detail).toContain("18:00");
    expect(local(explained.at)).toBe("2026-08-29 09:00");
  });

  it("reports the Sunday it stepped over rather than silently skipping it", () => {
    // Sat 29 Aug 18:40 misses the cut-off, and Sunday is a weekly off, so
    // the clock lands on Monday morning. Somebody reading a Monday start
    // against a Saturday booking deserves to be told why.
    const explained = explainClockStart(
      ist("2026-08-29", "18:40"),
      shapeCalendar(BRANCH),
      { useWorkingHours: true, respectCutoff: true },
    );

    expect(local(explained.at)).toBe("2026-08-31 09:00");
    expect(explained.skipped).toEqual([
      { ymd: "2026-08-30", dayOfWeek: 0, reason: "Weekly off" },
    ]);
  });

  it("tells a branch holiday apart from a weekly off", () => {
    const explained = explainClockStart(
      ist("2026-08-25", "18:40"),
      shapeCalendar({ ...BRANCH, holidays: ["2026-08-26"] }),
      { useWorkingHours: true, respectCutoff: true },
    );

    expect(explained.skipped).toEqual([
      { ymd: "2026-08-26", dayOfWeek: 3, reason: "Branch holiday" },
    ]);
    expect(local(explained.at)).toBe("2026-08-27 09:00");
  });

  it("says so plainly when a policy runs on wall time", () => {
    const at = ist("2026-08-30", "23:15");
    const explained = explainClockStart(at, shapeCalendar(BRANCH), {
      useWorkingHours: false,
      respectCutoff: false,
    });

    expect(explained.at.getTime()).toBe(at.getTime());
    expect(explained.steps[0].rule).toBe("Wall clock");
  });
});

describe("explaining the transit walk", () => {
  it("agrees with addWorkingTime", () => {
    const shape = shapeCalendar(BRANCH);
    const from = ist("2026-08-28", "10:00");

    for (const hours of [1, 9, 24, 72]) {
      expect(explainWorkingTime(from, hours * 3_600_000, shape).at.getTime()).toBe(
        addWorkingTime(from, hours * 3_600_000, shape).getTime(),
      );
    }
  });

  it("lists the weekend it crossed", () => {
    // Fri 28 Aug 10:00 + 24 working hours at 10 h/day:
    //   Fri 10:00→19:00  =  9 h  (15 left)
    //   Sat 09:00→19:00  = 10 h  ( 5 left)
    //   Sun is a weekly off
    //   Mon 09:00 + 5 h  = 14:00
    const explained = explainWorkingTime(
      ist("2026-08-28", "10:00"),
      24 * 3_600_000,
      shapeCalendar(BRANCH),
    );

    expect(local(explained.at)).toBe("2026-08-31 14:00");
    expect(explained.skipped.map((day) => day.ymd)).toEqual(["2026-08-30"]);
    expect(explained.workingDaysUsed).toBe(3);
  });
});

describe("explaining the whole plan", () => {
  it("returns exactly the plan planSla returns", () => {
    const startedAt = ist("2026-08-28", "18:40");
    const input = {
      startedAt,
      lane: LANE,
      policies: [EXPRESS],
      calendar: BRANCH,
    };

    expect(explainPlan(input).plan).toEqual(planSla(input));
  });

  it("ranks every policy that covers the lane, winner first", () => {
    const network: PolicyCandidate = {
      ...EXPRESS,
      id: "pol-network",
      code: "NET-ANY",
      originCityId: null,
      destinationCityId: null,
      transitHours: 72,
    };
    const zonal: PolicyCandidate = {
      ...EXPRESS,
      id: "pol-zone",
      code: "ZON-N-W",
      originCityId: null,
      destinationCityId: null,
      originZoneId: "zone-north",
      destinationZoneId: "zone-west",
      transitHours: 48,
    };

    const explained = explainPlan({
      startedAt: ist("2026-08-25", "10:00"),
      lane: LANE,
      policies: [network, zonal, EXPRESS],
      calendar: BRANCH,
    });

    // City pair (41) beats zone pair (21) beats service default (1) —
    // which is the whole answer to "why did this one win?", and the only
    // form of it an operations manager can check.
    expect(explained.matches.map((m) => m.policy.code)).toEqual([
      "EXP-DEL-JAI",
      "ZON-N-W",
      "NET-ANY",
    ]);
    expect(explained.matches.map((m) => m.specificity)).toEqual([41, 21, 1]);
  });

  it("scores specificity the same way whether or not a lane is in hand", () => {
    // The admin list sorts by `policySpecificity` with no lane to resolve
    // against. If it disagreed with the resolver the list would be sorted
    // into an order that does not predict which policy wins.
    const explained = explainPlan({
      startedAt: ist("2026-08-25", "10:00"),
      lane: LANE,
      policies: [EXPRESS],
      calendar: BRANCH,
    });

    expect(policySpecificity(EXPRESS)).toBe(explained.matches[0].specificity);
  });

  it("explains an unmeasurable lane instead of inventing a promise", () => {
    const explained = explainPlan({
      startedAt: ist("2026-08-25", "10:00"),
      lane: { ...LANE, originCityId: "city-mumbai" },
      policies: [EXPRESS],
      calendar: BRANCH,
    });

    expect(explained.matches).toEqual([]);
    expect(explained.plan.state).toBe("NOT_APPLICABLE");
    expect(explained.clockSteps).toEqual([]);
  });

  it("does not double-count a Sunday the at-risk walk also crossed", () => {
    // At-risk is a prefix of the transit walk, so both cross the same
    // Sunday. Printing it twice would invite the reader to think two
    // Sundays were lost.
    const explained = explainPlan({
      startedAt: ist("2026-08-28", "10:00"),
      lane: LANE,
      policies: [EXPRESS],
      calendar: BRANCH,
    });

    expect(explained.skipped.map((day) => day.ymd)).toEqual(["2026-08-30"]);
  });
});
