import { describe, expect, it } from "vitest";
import {
  attemptsRemaining,
  isFinalAttempt,
  nextAction,
  nextWorkingDay,
  validateAttemptCapture,
  type AttemptReasonPolicy,
} from "./attempts";

/**
 * The reason rows below mirror the auto-action table in docs/BRD.html
 * §A.10. They are fixtures, not a catalogue — the point of every test here
 * is that behaviour follows the flags, so operations can retire a reason or
 * change what it triggers without a release.
 */
function reason(overrides: Partial<AttemptReasonPolicy> = {}): AttemptReasonPolicy {
  return {
    triggersReattempt: false,
    triggersException: false,
    isChargeable: false,
    notifiesConsignor: false,
    notifiesConsignee: false,
    requiresPhoto: false,
    requiresRemarks: false,
    ...overrides,
  };
}

/** "Consignee unavailable" — reattempt next working day, free the first time. */
const CONSIGNEE_UNAVAILABLE = reason({
  triggersReattempt: true,
  notifiesConsignee: true,
});

/** "Wrong address" — support has to fix the address first. Chargeable. */
const WRONG_ADDRESS = reason({
  triggersException: true,
  isChargeable: true,
  notifiesConsignor: true,
});

/** "Shipment damaged" — photo is the claim evidence, so it is mandatory. */
const DAMAGED = reason({
  triggersException: true,
  requiresPhoto: true,
  requiresRemarks: true,
  notifiesConsignor: true,
});

const EXPRESS = { maxDeliveryAttempts: 3 };

// A Wednesday, so the default reattempt lands on a plain Thursday.
const WEDNESDAY = new Date(2026, 7, 26, 15, 30);

describe("the first failure buys another visit", () => {
  it("schedules a reattempt on the next working day", () => {
    const decision = nextAction(
      { attemptCount: 1 },
      CONSIGNEE_UNAVAILABLE,
      EXPRESS,
      { now: WEDNESDAY },
    );

    expect(decision.action).toBe("REATTEMPT");
    expect(decision.scheduledFor).toBeInstanceOf(Date);
    // Thursday the 27th, at the branch's opening hour.
    expect(decision.scheduledFor?.getDate()).toBe(27);
    expect(decision.scheduledFor?.getHours()).toBe(9);
  });

  it("takes the notify and charge flags from the row, not from the code", () => {
    const decision = nextAction(
      { attemptCount: 1 },
      CONSIGNEE_UNAVAILABLE,
      EXPRESS,
      { now: WEDNESDAY },
    );

    expect(decision.notifyConsignee).toBe(true);
    expect(decision.notifyConsignor).toBe(false);
    expect(decision.chargeable).toBe(false);

    // Operations makes the same reason chargeable and notify the consignor.
    // Nothing in the module may resist that.
    const retuned = nextAction(
      { attemptCount: 1 },
      { ...CONSIGNEE_UNAVAILABLE, isChargeable: true, notifiesConsignor: true },
      EXPRESS,
      { now: WEDNESDAY },
    );

    expect(retuned.action).toBe("REATTEMPT");
    expect(retuned.chargeable).toBe(true);
    expect(retuned.notifyConsignor).toBe(true);
  });

  it("skips weekly offs and branch holidays", () => {
    // Saturday. The branch is shut Sunday and takes Monday as a holiday.
    const saturday = new Date(2026, 7, 29, 18, 0);

    const decision = nextAction(
      { attemptCount: 1 },
      CONSIGNEE_UNAVAILABLE,
      EXPRESS,
      { now: saturday, weeklyOffDays: [0], holidays: ["2026-08-31"] },
    );

    // Sunday 30th is a weekly off, Monday 31st a holiday — Tuesday it is.
    expect(decision.scheduledFor?.getDate()).toBe(1);
    expect(decision.scheduledFor?.getMonth()).toBe(8);
  });
});

describe("the attempt limit proposes RTO", () => {
  it("returns RTO once the contracted attempts are spent", () => {
    const decision = nextAction(
      { attemptCount: 3 },
      CONSIGNEE_UNAVAILABLE,
      EXPRESS,
      { now: WEDNESDAY },
    );

    expect(decision.action).toBe("RTO");
    // Nothing is scheduled — a human with `delivery.rto` decides next.
    expect(decision.scheduledFor).toBeUndefined();
  });

  it("respects a service that allows only one attempt", () => {
    const decision = nextAction(
      { attemptCount: 1 },
      CONSIGNEE_UNAVAILABLE,
      { maxDeliveryAttempts: 1 },
      { now: WEDNESDAY },
    );

    expect(decision.action).toBe("RTO");
  });

  it("still carries the charge and notification flags into RTO", () => {
    const decision = nextAction({ attemptCount: 4 }, WRONG_ADDRESS, EXPRESS);

    expect(decision.action).toBe("RTO");
    expect(decision.chargeable).toBe(true);
    expect(decision.notifyConsignor).toBe(true);
  });

  it("counts down the remaining allowance", () => {
    expect(attemptsRemaining({ attemptCount: 1 }, EXPRESS)).toBe(2);
    expect(attemptsRemaining({ attemptCount: 3 }, EXPRESS)).toBe(0);
    expect(attemptsRemaining({ attemptCount: 9 }, EXPRESS)).toBe(0);

    expect(isFinalAttempt({ attemptCount: 2 }, EXPRESS)).toBe(false);
    expect(isFinalAttempt({ attemptCount: 3 }, EXPRESS)).toBe(true);
  });
});

describe("a reason that does not trigger a reattempt", () => {
  it("holds for an ops decision rather than sending the agent back", () => {
    const decision = nextAction({ attemptCount: 1 }, WRONG_ADDRESS, EXPRESS, {
      now: WEDNESDAY,
    });

    expect(decision.action).toBe("HOLD");
    expect(decision.scheduledFor).toBeUndefined();
    expect(decision.chargeable).toBe(true);
    expect(decision.notifyConsignor).toBe(true);
  });

  it("becomes a reattempt the moment operations flips the flag", () => {
    const decision = nextAction(
      { attemptCount: 1 },
      { ...WRONG_ADDRESS, triggersReattempt: true },
      EXPRESS,
      { now: WEDNESDAY },
    );

    expect(decision.action).toBe("REATTEMPT");
    expect(decision.scheduledFor).toBeInstanceOf(Date);
  });
});

describe("a reason that requires a photo", () => {
  it("refuses the capture until the photo is attached", () => {
    expect(validateAttemptCapture(DAMAGED, { remarks: "Carton crushed" })).toBe(
      "This reason needs a photo before it can be submitted.",
    );

    expect(
      validateAttemptCapture(DAMAGED, {
        photoAssetId: "file_123",
        remarks: "Carton crushed",
      }),
    ).toBeNull();
  });

  it("asks for remarks separately", () => {
    expect(
      validateAttemptCapture(DAMAGED, { photoAssetId: "file_123" }),
    ).toBe("This reason needs a note explaining what happened.");

    // Whitespace is not a note.
    expect(
      validateAttemptCapture(DAMAGED, {
        photoAssetId: "file_123",
        remarks: "   ",
      }),
    ).toBe("This reason needs a note explaining what happened.");
  });

  it("demands nothing when the row demands nothing", () => {
    expect(validateAttemptCapture(CONSIGNEE_UNAVAILABLE, {})).toBeNull();
  });

  it("decides the follow-up action independently of the evidence", () => {
    // A missing photo blocks submission; it does not change what the
    // failure means once it is submitted.
    const decision = nextAction({ attemptCount: 1 }, DAMAGED, EXPRESS, {
      now: WEDNESDAY,
    });

    expect(decision.action).toBe("HOLD");
    expect(decision.notifyConsignor).toBe(true);
  });
});

describe("the working calendar", () => {
  it("never returns the same day", () => {
    const monday = new Date(2026, 7, 24, 9, 0);
    expect(nextWorkingDay(monday).getDate()).toBe(25);
  });

  it("uses the branch opening hour", () => {
    expect(nextWorkingDay(WEDNESDAY, { hour: 10 }).getHours()).toBe(10);
  });

  it("gives up rather than looping when every day is an off day", () => {
    const result = nextWorkingDay(WEDNESDAY, {
      weeklyOffDays: [0, 1, 2, 3, 4, 5, 6],
    });
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThan(WEDNESDAY.getTime());
  });
});
