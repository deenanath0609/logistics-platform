import { describe, expect, it } from "vitest";
import {
  canDeactivateFieldUser,
  hasOpenWork,
  latestActivity,
  syncFreshness,
  type OpenWork,
} from "./field-staff";

const IDLE: OpenWork = { runs: [], pickups: [] };

describe("canDeactivateFieldUser", () => {
  it("allows a field user who is carrying nothing", () => {
    expect(canDeactivateFieldUser("Rahul Verma", IDLE)).toEqual({ ok: true });
  });

  it("refuses an open delivery run and names it", () => {
    const check = canDeactivateFieldUser("Rahul Verma", {
      runs: [{ number: "DR-DEL-0042", status: "STARTED", stopsRemaining: 6 }],
      pickups: [],
    });

    expect(check.ok).toBe(false);
    if (check.ok) return;

    // Naming the document is the whole point: "reassign their work first"
    // is not something a branch manager can act on.
    expect(check.reason).toContain("Rahul Verma");
    expect(check.reason).toContain("DR-DEL-0042");
    expect(check.reason).toContain("6 stops open");
    expect(check.reason).toContain("Delivery runs");
  });

  it("refuses a planned run that has not started yet", () => {
    // The parcels are already committed to this agent even though the run
    // has not begun, so standing them down still strands the work.
    const check = canDeactivateFieldUser("Imran Sheikh", {
      runs: [{ number: "DR-JAI-0007", status: "PLANNED", stopsRemaining: 1 }],
      pickups: [],
    });

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("1 stop open");
  });

  it("refuses an unfinished pickup and names it", () => {
    const check = canDeactivateFieldUser("Sunita Rao", {
      runs: [],
      pickups: [{ number: "PU-DEL-0117" }],
    });

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("pickup PU-DEL-0117");
    expect(check.reason).toContain("Pickups");
    expect(check.reason).not.toContain("Delivery runs");
  });

  it("names everything that is open, not just the first thing", () => {
    const check = canDeactivateFieldUser("Sunita Rao", {
      runs: [{ number: "DR-DEL-0042", status: "STARTED", stopsRemaining: 2 }],
      pickups: [{ number: "PU-DEL-0117" }, { number: "PU-DEL-0118" }],
    });

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("DR-DEL-0042");
    expect(check.reason).toContain("PU-DEL-0117");
    expect(check.reason).toContain("PU-DEL-0118");
    expect(check.reason).toContain("pickups");
  });
});

describe("hasOpenWork", () => {
  it("is false only when both lists are empty", () => {
    expect(hasOpenWork(IDLE)).toBe(false);
    expect(hasOpenWork({ runs: [], pickups: [{ number: "PU-1" }] })).toBe(true);
  });
});

describe("syncFreshness", () => {
  const now = new Date("2026-08-30T18:00:00.000Z");
  const hoursAgo = (hours: number) =>
    new Date(now.getTime() - hours * 3_600_000);

  it("reads an account that has never worked as NEVER", () => {
    expect(syncFreshness(null, now)).toBe("NEVER");
  });

  it("reads activity inside the shift as FRESH", () => {
    expect(syncFreshness(hoursAgo(0.5), now)).toBe("FRESH");
    expect(syncFreshness(hoursAgo(11), now)).toBe("FRESH");
  });

  it("reads yesterday as QUIET rather than raising an alarm", () => {
    expect(syncFreshness(hoursAgo(13), now)).toBe("QUIET");
    expect(syncFreshness(hoursAgo(35), now)).toBe("QUIET");
  });

  it("reads a phone silent for more than a day and a half as STALE", () => {
    expect(syncFreshness(hoursAgo(36), now)).toBe("STALE");
    expect(syncFreshness(hoursAgo(24 * 30), now)).toBe("STALE");
  });

  it("treats a device clock running ahead as fresh, not as a negative age", () => {
    expect(syncFreshness(hoursAgo(-3), now)).toBe("FRESH");
  });
});

describe("latestActivity", () => {
  it("ignores missing timestamps and returns the newest", () => {
    const older = new Date("2026-08-29T09:00:00.000Z");
    const newer = new Date("2026-08-30T09:00:00.000Z");

    expect(latestActivity(null, older, undefined, newer)).toEqual(newer);
    expect(latestActivity(null, undefined)).toBeNull();
  });
});
