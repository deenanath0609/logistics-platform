import { describe, expect, it } from "vitest";
import {
  sequencePickups,
  suggestExecutive,
  canReassign,
  isOpen,
  nextAttemptDate,
  type PickupCandidate,
  type ExecutiveLoad,
} from "./assignment";

function pickup(overrides: Partial<PickupCandidate> = {}): PickupCandidate {
  return {
    id: "p1",
    slot: "ANYTIME",
    priority: 0,
    expectedPackages: 1,
    pincode: "122015",
    requestedDate: new Date("2026-08-27T09:00:00Z"),
    ...overrides,
  };
}

describe("sequencePickups", () => {
  it("puts higher priority first regardless of slot", () => {
    const result = sequencePickups([
      pickup({ id: "normal", slot: "MORNING", priority: 0 }),
      pickup({ id: "urgent", slot: "EVENING", priority: 5 }),
    ]);

    expect(result.map((p) => p.id)).toEqual(["urgent", "normal"]);
  });

  it("runs morning before afternoon before evening", () => {
    const result = sequencePickups([
      pickup({ id: "evening", slot: "EVENING" }),
      pickup({ id: "morning", slot: "MORNING" }),
      pickup({ id: "afternoon", slot: "AFTERNOON" }),
    ]);

    expect(result.map((p) => p.id)).toEqual(["morning", "afternoon", "evening"]);
  });

  it("treats ANYTIME as last, so committed slots are not displaced", () => {
    const result = sequencePickups([
      pickup({ id: "anytime", slot: "ANYTIME" }),
      pickup({ id: "evening", slot: "EVENING" }),
    ]);

    expect(result.map((p) => p.id)).toEqual(["evening", "anytime"]);
  });

  it("clusters nearby pincodes within the same slot", () => {
    const result = sequencePickups([
      pickup({ id: "far", pincode: "122018" }),
      pickup({ id: "near", pincode: "122001" }),
      pickup({ id: "mid", pincode: "122015" }),
    ]);

    expect(result.map((p) => p.id)).toEqual(["near", "mid", "far"]);
  });

  it("breaks a full tie on age, so nothing waits forever", () => {
    const result = sequencePickups([
      pickup({ id: "new", requestedDate: new Date("2026-08-27T12:00:00Z") }),
      pickup({ id: "old", requestedDate: new Date("2026-08-25T12:00:00Z") }),
    ]);

    expect(result.map((p) => p.id)).toEqual(["old", "new"]);
  });

  it("does not mutate its input", () => {
    const input = [pickup({ id: "b", pincode: "999999" }), pickup({ id: "a" })];
    const before = input.map((p) => p.id);

    sequencePickups(input);

    expect(input.map((p) => p.id)).toEqual(before);
  });

  it("handles an empty list", () => {
    expect(sequencePickups([])).toEqual([]);
  });
});

describe("suggestExecutive", () => {
  const load = (o: Partial<ExecutiveLoad>): ExecutiveLoad => ({
    userId: "u",
    name: "Someone",
    assigned: 0,
    packages: 0,
    ...o,
  });

  it("picks the lightest load measured in packages, not stops", () => {
    // Ten single-carton stops is not the same job as one 40-package load.
    const result = suggestExecutive([
      load({ userId: "many-stops", name: "A", assigned: 10, packages: 10 }),
      load({ userId: "one-big", name: "B", assigned: 1, packages: 40 }),
    ]);

    expect(result?.userId).toBe("many-stops");
  });

  it("breaks a package tie on stop count", () => {
    const result = suggestExecutive([
      load({ userId: "busy", name: "A", assigned: 8, packages: 20 }),
      load({ userId: "free", name: "B", assigned: 2, packages: 20 }),
    ]);

    expect(result?.userId).toBe("free");
  });

  it("is stable when loads are identical, rather than jumping about", () => {
    const loads = [
      load({ userId: "z", name: "Zara" }),
      load({ userId: "a", name: "Amit" }),
    ];

    expect(suggestExecutive(loads)?.userId).toBe("a");
    expect(suggestExecutive(loads)?.userId).toBe("a");
  });

  it("returns null when nobody is available", () => {
    expect(suggestExecutive([])).toBeNull();
  });
});

describe("canReassign", () => {
  it("allows moving an open pickup", () => {
    expect(canReassign("REQUESTED").ok).toBe(true);
    expect(canReassign("ASSIGNED").ok).toBe(true);
    expect(canReassign("IN_PROGRESS").ok).toBe(true);
  });

  it("refuses a completed collection", () => {
    expect(canReassign("COMPLETED").ok).toBe(false);
  });

  it("refuses a failed attempt, so the history of who tried survives", () => {
    const result = canReassign("FAILED");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/re-pickup/i);
  });

  it("refuses a cancelled request", () => {
    expect(canReassign("CANCELLED").ok).toBe(false);
  });
});

describe("isOpen", () => {
  it.each(["REQUESTED", "ASSIGNED", "IN_PROGRESS"] as const)(
    "%s is still workable",
    (status) => expect(isOpen(status)).toBe(true),
  );

  it.each(["COMPLETED", "FAILED", "CANCELLED"] as const)(
    "%s is not",
    (status) => expect(isOpen(status)).toBe(false),
  );
});

describe("nextAttemptDate", () => {
  it("schedules the next day at midnight", () => {
    const next = nextAttemptDate(new Date("2026-08-27T16:30:00"));
    expect(next.getDate()).toBe(28);
    expect(next.getHours()).toBe(0);
  });

  it("rolls over a month boundary", () => {
    const next = nextAttemptDate(new Date("2026-08-31T16:30:00"));
    expect(next.getMonth()).toBe(8); // September
    expect(next.getDate()).toBe(1);
  });

  it("accepts a longer gap for a branch that is closed tomorrow", () => {
    const next = nextAttemptDate(new Date("2026-08-27T10:00:00"), 3);
    expect(next.getDate()).toBe(30);
  });
});
