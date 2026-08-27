import { describe, expect, it } from "vitest";
import type { ShipmentStatus } from "@/generated/prisma/client";
import {
  evaluateTransition,
  isTerminal,
  ruleFor,
  TRANSITIONS,
  type TransitionContext,
} from "./state-machine";

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    currentStatus: "BOOKED",
    originBranchId: "origin",
    destinationBranchId: "destination",
    attemptCount: 0,
    maxDeliveryAttempts: 3,
    ...overrides,
  };
}

describe("the happy path", () => {
  it("walks booking through to closure", () => {
    // Each step asserts both that the event is allowed and where it leads,
    // so a reordering of the lifecycle cannot pass silently.
    const journey: Array<[Parameters<typeof evaluateTransition>[0], ShipmentStatus, ShipmentStatus]> = [
      ["PICKUP_ASSIGNED", "BOOKED", "PICKUP_ASSIGNED"],
      ["PICKUP_COMPLETED", "PICKUP_ASSIGNED", "PICKED_UP"],
      ["INBOUND_SCAN", "PICKED_UP", "RECEIVED_AT_ORIGIN"],
      ["SORTED", "RECEIVED_AT_ORIGIN", "PROCESSED"],
      ["MANIFEST_ADDED", "PROCESSED", "MANIFESTED"],
      ["GATE_OUT", "MANIFESTED", "DISPATCHED"],
      ["GEOFENCE_EXIT", "DISPATCHED", "IN_TRANSIT"],
      ["GATE_IN", "IN_TRANSIT", "ARRIVED_AT_HUB"],
      ["INBOUND_SCAN", "ARRIVED_AT_HUB", "RECEIVED_AT_HUB"],
      ["DELIVERY_ASSIGNED", "RECEIVED_AT_HUB", "ASSIGNED_FOR_DELIVERY"],
      ["RUN_STARTED", "ASSIGNED_FOR_DELIVERY", "OUT_FOR_DELIVERY"],
      ["DELIVERED", "OUT_FOR_DELIVERY", "DELIVERED"],
      ["POD_SYNCED", "DELIVERED", "POD_UPLOADED"],
      ["CLOSED", "POD_UPLOADED", "CLOSED"],
    ];

    for (const [event, from, expected] of journey) {
      const result = evaluateTransition(
        event,
        ctx({ currentStatus: from }),
        { branchId: "branch", reasonCodeId: "reason", remarks: "note" },
      );

      expect(result.ok, `${event} from ${from}: ${result.ok ? "" : result.reason}`).toBe(true);
      if (result.ok) expect(result.nextStatus, `${event} from ${from}`).toBe(expected);
    }
  });
});

describe("an inbound scan means different things in different places", () => {
  it("is receipt at origin when the goods have just been picked up", () => {
    const result = evaluateTransition(
      "INBOUND_SCAN",
      ctx({ currentStatus: "PICKED_UP" }),
      { branchId: "origin" },
    );
    expect(result.ok && result.nextStatus).toBe("RECEIVED_AT_ORIGIN");
  });

  it("is receipt at a hub once the goods are already moving", () => {
    const result = evaluateTransition(
      "INBOUND_SCAN",
      ctx({ currentStatus: "IN_TRANSIT" }),
      { branchId: "hub" },
    );
    expect(result.ok && result.nextStatus).toBe("RECEIVED_AT_HUB");
  });
});

describe("a failed delivery attempt", () => {
  it("returns the shipment to the hub rather than inventing a failed status", () => {
    const result = evaluateTransition(
      "DELIVERY_ATTEMPTED",
      ctx({ currentStatus: "OUT_FOR_DELIVERY" }),
      { reasonCodeId: "DF-UNAVAILABLE" },
    );

    expect(result.ok && result.nextStatus).toBe("RECEIVED_AT_HUB");
  });

  it("cannot be recorded without a reason code", () => {
    const result = evaluateTransition(
      "DELIVERY_ATTEMPTED",
      ctx({ currentStatus: "OUT_FOR_DELIVERY" }),
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/reason is required/i);
  });
});

describe("events that record without moving the status", () => {
  it.each([
    ["WEIGHT_CAPTURED", "RECEIVED_AT_ORIGIN"],
    ["LOADED", "MANIFESTED"],
    ["DAMAGE_RECORDED", "IN_TRANSIT"],
    ["HELD", "PROCESSED"],
  ] as const)("%s leaves the shipment where it was", (event, from) => {
    const result = evaluateTransition(
      event,
      ctx({ currentStatus: from }),
      { branchId: "branch", reasonCodeId: "reason" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextStatus).toBeNull();
  });
});

describe("illegal transitions", () => {
  it("refuses to deliver something that was never dispatched", () => {
    const result = evaluateTransition("DELIVERED", ctx({ currentStatus: "BOOKED" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cannot deliver/i);
  });

  it("refuses to cancel a shipment already in transit", () => {
    const result = evaluateTransition(
      "CANCELLED",
      ctx({ currentStatus: "IN_TRANSIT" }),
      { reasonCodeId: "CN-CUSTOMER" },
    );
    expect(result.ok).toBe(false);
  });

  it("allows cancelling before dispatch", () => {
    const result = evaluateTransition(
      "CANCELLED",
      ctx({ currentStatus: "BOOKED" }),
      { reasonCodeId: "CN-CUSTOMER" },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown event type", () => {
    const result = evaluateTransition(
      "NOT_A_REAL_EVENT" as never,
      ctx(),
    );
    expect(result.ok).toBe(false);
  });
});

describe("terminal states", () => {
  it.each(["CLOSED", "CANCELLED", "LOST", "RTO_DELIVERED"] as ShipmentStatus[])(
    "%s accepts no further operational events",
    (status) => {
      expect(isTerminal(status)).toBe(true);

      const result = evaluateTransition(
        "INBOUND_SCAN",
        ctx({ currentStatus: status }),
        { branchId: "branch" },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/no further events/i);
    },
  );

  it("still allows a status correction, which is the escape hatch", () => {
    const result = evaluateTransition(
      "STATUS_CORRECTED",
      ctx({ currentStatus: "CANCELLED" }),
      { reasonCodeId: "SC-MISSCAN", remarks: "Cancelled in error" },
      "BOOKED",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextStatus).toBe("BOOKED");
  });

  it("refuses a correction without a target status", () => {
    const result = evaluateTransition(
      "STATUS_CORRECTED",
      ctx({ currentStatus: "CANCELLED" }),
      { reasonCodeId: "SC-MISSCAN", remarks: "why" },
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a correction without remarks — the audit row would be useless", () => {
    const result = evaluateTransition(
      "STATUS_CORRECTED",
      ctx({ currentStatus: "CANCELLED" }),
      { reasonCodeId: "SC-MISSCAN" },
      "BOOKED",
    );
    expect(result.ok).toBe(false);
  });
});

describe("the rule table itself", () => {
  it("declares every event exactly once", () => {
    const seen = new Set<string>();
    for (const rule of TRANSITIONS) {
      expect(seen.has(rule.event), `duplicate rule for ${rule.event}`).toBe(false);
      seen.add(rule.event);
    }
  });

  it("gives every rule a permission and a description", () => {
    for (const rule of TRANSITIONS) {
      expect(rule.permission, rule.event).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(rule.describe.length, rule.event).toBeGreaterThan(3);
    }
  });

  it("exposes rules by event name", () => {
    expect(ruleFor("DELIVERED")?.permission).toBe("delivery.execute");
    expect(ruleFor("NOPE" as never)).toBeUndefined();
  });
});
