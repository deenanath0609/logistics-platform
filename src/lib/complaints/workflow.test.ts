import { describe, expect, it } from "vitest";
import type { ComplaintStatus } from "@/generated/prisma/client";
import {
  LIVE,
  SETTLED,
  STATUS_LABEL,
  allowedTransitions,
  findTransition,
  isSettled,
} from "./workflow";

const ALL: ComplaintStatus[] = [
  "OPEN",
  "ASSIGNED",
  "INVESTIGATING",
  "ACTION_TAKEN",
  "RESOLVED",
  "CLOSED",
  "REOPENED",
];

describe("allowedTransitions", () => {
  it("walks the BRD workflow end to end", () => {
    const path: ComplaintStatus[] = [
      "OPEN",
      "ASSIGNED",
      "INVESTIGATING",
      "ACTION_TAKEN",
      "RESOLVED",
      "CLOSED",
    ];

    for (let i = 0; i < path.length - 1; i++) {
      expect(findTransition(path[i], path[i + 1])).not.toBeNull();
    }
  });

  it("refuses to skip the middle of the workflow", () => {
    expect(findTransition("OPEN", "RESOLVED")).toBeNull();
    expect(findTransition("OPEN", "CLOSED")).toBeNull();
    expect(findTransition("ASSIGNED", "RESOLVED")).toBeNull();
  });

  it("offers a reopen from both end states", () => {
    expect(findTransition("RESOLVED", "REOPENED")).not.toBeNull();
    expect(findTransition("CLOSED", "REOPENED")).not.toBeNull();
  });

  it("leaves a reopened complaint no way to skip straight back to closed", () => {
    expect(findTransition("REOPENED", "CLOSED")).toBeNull();
    expect(findTransition("REOPENED", "RESOLVED")).toBeNull();
  });

  it("gates resolving and closing behind complaint.resolve", () => {
    expect(findTransition("ACTION_TAKEN", "RESOLVED")?.permission).toBe(
      "complaint.resolve",
    );
    expect(findTransition("RESOLVED", "CLOSED")?.permission).toBe(
      "complaint.resolve",
    );
  });

  it("demands a note wherever the customer will read the outcome", () => {
    expect(findTransition("INVESTIGATING", "ACTION_TAKEN")?.requiresNote).toBe(true);
    expect(findTransition("ACTION_TAKEN", "RESOLVED")?.requiresNote).toBe(true);
    expect(findTransition("CLOSED", "REOPENED")?.requiresNote).toBe(true);
  });

  it("demands an owner wherever ownership changes", () => {
    expect(findTransition("OPEN", "ASSIGNED")?.requiresAssignee).toBe(true);
    expect(findTransition("ASSIGNED", "ASSIGNED")?.requiresAssignee).toBe(true);
    expect(findTransition("ASSIGNED", "INVESTIGATING")?.requiresAssignee).toBe(false);
  });

  it("never offers a transition into a status the table does not know", () => {
    for (const status of ALL) {
      for (const transition of allowedTransitions(status)) {
        expect(ALL).toContain(transition.to);
      }
    }
  });

  it("gives every status a label", () => {
    for (const status of ALL) expect(STATUS_LABEL[status]).toBeTruthy();
  });
});

describe("isSettled", () => {
  it("counts resolved and closed as settled", () => {
    expect(SETTLED.every(isSettled)).toBe(true);
  });

  it("counts a reopened complaint as live again", () => {
    expect(isSettled("REOPENED")).toBe(false);
    expect(LIVE).toContain("REOPENED");
  });

  it("partitions every status into live or settled", () => {
    for (const status of ALL) {
      expect(LIVE.includes(status) !== SETTLED.includes(status)).toBe(true);
    }
  });
});
