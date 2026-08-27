import { describe, it, expect } from "vitest";
import { breachReasonFrom, slaDedupeKey, type BreachFacts } from "./scanner";

/**
 * The parts of the scanner that can be reasoned about without a database.
 *
 * The idempotency guarantee lives in two places: this key, and the unique
 * index on `Exception.dedupeKey`. The index is the one that actually
 * enforces it; this file pins the key's shape so a refactor cannot
 * quietly make it time-varying — which would let the scanner raise the
 * same exception every three minutes, all day, and nobody would notice
 * until the tower had four hundred rows in it.
 */

const NOW = new Date("2026-08-27T12:00:00.000Z");
const DUE = new Date("2026-08-27T09:00:00.000Z");

function facts(overrides: Partial<BreachFacts> = {}): BreachFacts {
  return {
    attemptCount: 0,
    dispatchedAt: new Date("2026-08-26T06:00:00.000Z"),
    dueAt: DUE,
    now: NOW,
    lastArrival: null,
    firstDeparture: null,
    ...overrides,
  };
}

describe("the dedupe key", () => {
  it("names the problem, not the moment", () => {
    expect(slaDedupeKey("SLA_BREACHED", "shp_1")).toBe(
      "sla:SLA_BREACHED:shp_1",
    );

    // The same shipment, scanned again five minutes later, must produce
    // the same key or the unique index cannot do its job.
    expect(slaDedupeKey("SLA_BREACHED", "shp_1")).toBe(
      slaDedupeKey("SLA_BREACHED", "shp_1"),
    );
  });

  it("separates at-risk from breached", () => {
    // A shipment goes at risk first and breaches later. Both are real
    // exceptions and must not collapse into one row — the at-risk one is
    // what somebody could have acted on.
    expect(slaDedupeKey("SLA_AT_RISK", "shp_1")).not.toBe(
      slaDedupeKey("SLA_BREACHED", "shp_1"),
    );
  });

  it("separates shipments", () => {
    expect(slaDedupeKey("SLA_BREACHED", "shp_1")).not.toBe(
      slaDedupeKey("SLA_BREACHED", "shp_2"),
    );
  });
});

describe("inferring why an SLA broke", () => {
  it("blames a failed attempt above anything upstream", () => {
    // Even with a dwell and a late dispatch in the same history, the
    // failed attempt is the cause closest to the missed date and the one
    // the destination branch can answer for.
    const reason = breachReasonFrom(
      facts({
        attemptCount: 1,
        dispatchedAt: null,
        lastArrival: {
          at: new Date("2026-08-20T00:00:00.000Z"),
          branchCode: "HUB-DEL",
          isDestination: false,
        },
      }),
    );

    expect(reason).toBe("Delivery attempted once and failed");
  });

  it("counts repeated attempts", () => {
    expect(breachReasonFrom(facts({ attemptCount: 3 }))).toBe(
      "Delivery attempted 3 times and failed",
    );
  });

  it("says so when the consignment never left", () => {
    expect(breachReasonFrom(facts({ dispatchedAt: null }))).toBe(
      "Never dispatched from origin",
    );
  });

  it("names a dispatch that happened after the promise was already due", () => {
    expect(
      breachReasonFrom(
        facts({ dispatchedAt: new Date("2026-08-27T10:00:00.000Z") }),
      ),
    ).toBe("Late dispatch — left origin after the promised delivery time");
  });

  it("names the hub a consignment has been sitting at", () => {
    // Arrived 30 hours ago, past the 24-hour dwell threshold.
    const reason = breachReasonFrom(
      facts({
        lastArrival: {
          at: new Date("2026-08-26T06:00:00.000Z"),
          branchCode: "HUB-JAI",
          isDestination: false,
        },
      }),
    );

    expect(reason).toBe("Held at hub HUB-JAI for 30 h");
  });

  it("says destination branch rather than a hub code when it is there", () => {
    const reason = breachReasonFrom(
      facts({
        lastArrival: {
          at: new Date("2026-08-26T06:00:00.000Z"),
          branchCode: "BR-JAI",
          isDestination: true,
        },
      }),
    );

    expect(reason).toBe("Held at destination branch for 30 h");
  });

  it("does not call a short stop a dwell", () => {
    // Four hours at a hub is a hub working normally, not a problem.
    expect(
      breachReasonFrom(
        facts({
          lastArrival: {
            at: new Date("2026-08-27T08:00:00.000Z"),
            branchCode: "HUB-JAI",
            isDestination: false,
          },
        }),
      ),
    ).toBeNull();
  });

  it("flags a departure that left no time to arrive", () => {
    // Gate-out half an hour before the promised delivery: the run itself
    // never had a chance, whatever happened afterwards.
    expect(
      breachReasonFrom(
        facts({ firstDeparture: new Date("2026-08-27T08:30:00.000Z") }),
      ),
    ).toBe("Late dispatch from origin");
  });

  it("admits it does not know rather than guessing", () => {
    // Dispatched in good time, no dwell, no failed attempt. Something
    // went wrong and the log does not say what — and a guessed cause
    // would send somebody to the wrong branch.
    expect(breachReasonFrom(facts())).toBeNull();
  });
});
