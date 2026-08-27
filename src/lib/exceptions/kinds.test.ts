import { describe, it, expect } from "vitest";
import type { ExceptionKind } from "@/generated/prisma/client";
import {
  KIND_DEFS,
  KIND_ORDER,
  ageMinutes,
  bySeverityThenAge,
  isLive,
  kindLabel,
  transitionTo,
  transitionsFor,
} from "./kinds";

const NOW = new Date("2026-08-27T12:00:00.000Z");

function ago(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

const EVERYTHING = new Set(["exception.assign", "exception.resolve"]);

describe("the exception catalogue", () => {
  it("describes every kind the schema can store", () => {
    // A kind with no entry falls through to a blank owner and a
    // twelve-hour escalation nobody chose. The enum and this table have
    // to stay in step.
    for (const kind of KIND_ORDER) {
      expect(KIND_DEFS[kind]).toBeDefined();
      expect(KIND_DEFS[kind].defaultOwner.length).toBeGreaterThan(0);
      expect(KIND_DEFS[kind].escalateAfterMinutes).toBeGreaterThan(0);
    }
  });

  it("falls back to something readable for an unknown kind", () => {
    expect(kindLabel("SLA_BREACHED")).toBe("SLA breached");
    expect(kindLabel("NOT_A_KIND" as ExceptionKind)).toBe("not a kind");
  });

  it("escalates a route deviation sooner than a pending POD", () => {
    // §A.11: deviation at 30 minutes, POD at 48 hours. A tower that
    // shouts equally loudly about both trains everyone to ignore it.
    expect(KIND_DEFS.ROUTE_DEVIATION.escalateAfterMinutes).toBeLessThan(
      KIND_DEFS.POD_PENDING.escalateAfterMinutes,
    );
  });
});

describe("the workflow", () => {
  it("requires a note to resolve or dismiss, but not to acknowledge", () => {
    // Nothing closes without a resolution note. An exception that
    // vanishes silently teaches everyone to ignore the tower.
    const fromOpen = transitionsFor("OPEN", EVERYTHING);

    expect(fromOpen.find((t) => t.to === "RESOLVED")?.requiresNote).toBe(true);
    expect(fromOpen.find((t) => t.to === "DISMISSED")?.requiresNote).toBe(true);
    expect(fromOpen.find((t) => t.to === "ACKNOWLEDGED")?.requiresNote).toBe(
      false,
    );
  });

  it("offers only what the user may actually do", () => {
    const assignOnly = transitionsFor("OPEN", new Set(["exception.assign"]));

    expect(assignOnly.map((t) => t.to)).toEqual(["ACKNOWLEDGED", "IN_PROGRESS"]);
    expect(transitionsFor("OPEN", new Set())).toHaveLength(0);
  });

  it("refuses a transition the workflow does not have", () => {
    expect(transitionTo("OPEN", "CLOSED")).toBeNull();
    expect(transitionTo("RESOLVED", "CLOSED")).not.toBeNull();
  });

  it("lets a closed exception be reopened, with a reason", () => {
    const reopen = transitionTo("CLOSED", "IN_PROGRESS");

    expect(reopen).not.toBeNull();
    expect(reopen?.requiresNote).toBe(true);
  });

  it("knows which statuses still need somebody", () => {
    expect(isLive("OPEN")).toBe(true);
    expect(isLive("IN_PROGRESS")).toBe(true);
    expect(isLive("RESOLVED")).toBe(false);
    expect(isLive("DISMISSED")).toBe(false);
  });
});

describe("the tower's reading order", () => {
  it("puts the worst first, then the oldest", () => {
    const rows = [
      { id: "normal-old", priority: "NORMAL" as const, detectedAt: ago(600) },
      { id: "critical-new", priority: "CRITICAL" as const, detectedAt: ago(5) },
      { id: "high-old", priority: "HIGH" as const, detectedAt: ago(900) },
      { id: "high-new", priority: "HIGH" as const, detectedAt: ago(60) },
    ];

    expect([...rows].sort(bySeverityThenAge).map((r) => r.id)).toEqual([
      "critical-new",
      "high-old",
      "high-new",
      "normal-old",
    ]);
  });
});

describe("ageing", () => {
  it("stops the clock at resolution, not at closure", () => {
    // The wait that matters ended when somebody fixed it, not when
    // somebody remembered to tick it shut a week later.
    expect(
      ageMinutes({ detectedAt: ago(600), resolvedAt: ago(300) }, NOW),
    ).toBe(300);
  });

  it("runs to now while it is still open", () => {
    expect(ageMinutes({ detectedAt: ago(90) }, NOW)).toBe(90);
  });

  it("never reports a negative age", () => {
    // Clock drift on a field device can stamp a detection in the future.
    expect(ageMinutes({ detectedAt: new Date(NOW.getTime() + 60_000) }, NOW)).toBe(
      0,
    );
  });
});
