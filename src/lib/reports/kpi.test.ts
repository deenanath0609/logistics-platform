import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  ageingBuckets,
  averageHubDwell,
  averageTransit,
  codAgeing,
  damageLossRate,
  firstAttemptDelivery,
  firstDepartureAfter,
  HUB_ARRIVAL_EVENTS,
  HUB_DEPARTURE_EVENTS,
  formatMinutes,
  formatPercent,
  gradeKpi,
  onTimeDelivery,
  ratio,
  slaBreachRate,
  truckUtilisation,
  type DeliveryFact,
} from "./kpi";

/**
 * Every fixture here is small enough to add up in your head, and the sum
 * is written into the comment above the expectation. That is deliberate:
 * the first time a branch manager disputes an on-time figure, this file
 * is the answer, and an answer nobody can follow is not one.
 */

const NOW = new Date("2026-08-27T12:00:00.000Z");

/** `hours` before NOW. */
function ago(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

function delivered(
  overrides: Partial<DeliveryFact> = {},
): DeliveryFact {
  return {
    deliveredAt: NOW,
    slaState: "MET",
    attemptCount: 0,
    pickedUpAt: ago(24),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────

describe("ratio", () => {
  it("reports null rather than zero when there is nothing to divide by", () => {
    // "No deliveries yet" and "every delivery was late" are different
    // facts. Rendering both as 0% is how a dashboard lies quietly.
    expect(ratio(0, 0).percent).toBeNull();
    expect(ratio(0, 4).percent).toBe(0);
  });

  it("rounds to two places", () => {
    // 2 ÷ 3 = 66.666… %
    expect(ratio(2, 3).percent).toBe(66.67);
  });
});

// ────────────────────────────────────────────────────────────

describe("on-time delivery %", () => {
  it("counts only deliveries the SLA engine measured", () => {
    // Five shipments:
    //   2 delivered and MET       → numerator 2
    //   1 delivered and BREACHED  → denominator 3
    //   1 delivered, no policy    → unmeasured, in neither
    //   1 still in transit        → ignored entirely
    // 2 ÷ 3 = 66.67%
    const result = onTimeDelivery([
      delivered({ slaState: "MET" }),
      delivered({ slaState: "MET" }),
      delivered({ slaState: "BREACHED" }),
      delivered({ slaState: "NOT_APPLICABLE" }),
      delivered({ deliveredAt: null, slaState: "ON_TIME" }),
    ]);

    expect(result.numerator).toBe(2);
    expect(result.denominator).toBe(3);
    expect(result.percent).toBe(66.67);
    expect(result.unmeasured).toBe(1);
  });

  it("is null, not 100%, when nothing measurable has been delivered", () => {
    const result = onTimeDelivery([
      delivered({ slaState: "NOT_APPLICABLE" }),
    ]);

    expect(result.percent).toBeNull();
    expect(result.unmeasured).toBe(1);
  });
});

describe("first-attempt delivery %", () => {
  it("treats a zero failed-attempt count as delivered first time", () => {
    // `attemptCount` counts FAILED attempts — the state machine
    // increments on DELIVERY_ATTEMPTED and not on DELIVERED. So:
    //   attemptCount 0, 0 → delivered first time
    //   attemptCount 1, 2 → not
    // 2 ÷ 4 = 50%
    const result = firstAttemptDelivery([
      delivered({ attemptCount: 0 }),
      delivered({ attemptCount: 0 }),
      delivered({ attemptCount: 1 }),
      delivered({ attemptCount: 2 }),
    ]);

    expect(result.numerator).toBe(2);
    expect(result.denominator).toBe(4);
    expect(result.percent).toBe(50);
  });

  it("counts every delivery, measured or not", () => {
    // Unlike on-time %, this does not need a policy to exist.
    const result = firstAttemptDelivery([
      delivered({ slaState: null, attemptCount: 0 }),
      delivered({ slaState: "NOT_APPLICABLE", attemptCount: 1 }),
    ]);

    expect(result.denominator).toBe(2);
    expect(result.percent).toBe(50);
  });

  it("ignores shipments still in the network", () => {
    expect(
      firstAttemptDelivery([delivered({ deliveredAt: null })]).percent,
    ).toBeNull();
  });
});

describe("SLA breach %", () => {
  it("divides breaches by everything that carried a commitment", () => {
    //   MET, BREACHED, BREACHED, ON_TIME  → eligible 4
    //   NOT_APPLICABLE, not-yet-scanned   → excluded
    // 2 ÷ 4 = 50%
    const result = slaBreachRate([
      { slaState: "MET" },
      { slaState: "BREACHED" },
      { slaState: "BREACHED" },
      { slaState: "ON_TIME" },
      { slaState: "NOT_APPLICABLE" },
      { slaState: null },
    ]);

    expect(result.numerator).toBe(2);
    expect(result.denominator).toBe(4);
    expect(result.percent).toBe(50);
  });

  it("counts an open shipment already past its due time", () => {
    // AT_RISK is eligible but not yet a breach; BREACHED is a breach even
    // though nothing has been delivered.
    const result = slaBreachRate([
      { slaState: "AT_RISK" },
      { slaState: "BREACHED" },
    ]);

    expect(result.percent).toBe(50);
  });
});

// ────────────────────────────────────────────────────────────

describe("average transit time", () => {
  it("measures pickup to delivery and reports the median too", () => {
    //   600 m, 1440 m, 1800 m
    //   mean   = 3840 ÷ 3 = 1280 m
    //   median = 1440 m
    const facts: DeliveryFact[] = [
      { ...delivered(), pickedUpAt: ago(10), deliveredAt: NOW },
      { ...delivered(), pickedUpAt: ago(24), deliveredAt: NOW },
      { ...delivered(), pickedUpAt: ago(30), deliveredAt: NOW },
    ];

    const result = averageTransit(facts);

    expect(result.samples).toBe(3);
    expect(result.averageMinutes).toBe(1280);
    expect(result.medianMinutes).toBe(1440);
  });

  it("takes the midpoint of the two middle values on an even count", () => {
    //   sorted: 200, 600, 1440, 1800
    //   mean   = 4040 ÷ 4 = 1010
    //   median = (600 + 1440) ÷ 2 = 1020
    const result = averageTransit([
      { ...delivered(), pickedUpAt: ago(10 / 3), deliveredAt: NOW },
      { ...delivered(), pickedUpAt: ago(10), deliveredAt: NOW },
      { ...delivered(), pickedUpAt: ago(24), deliveredAt: NOW },
      { ...delivered(), pickedUpAt: ago(30), deliveredAt: NOW },
    ]);

    expect(result.averageMinutes).toBe(1010);
    expect(result.medianMinutes).toBe(1020);
  });

  it("accepts a working-hours measure", () => {
    // §A.17 measures transit in working hours. The measure is injected so
    // the branch calendar can supply it without this function knowing.
    const result = averageTransit(
      [{ ...delivered(), pickedUpAt: ago(48), deliveredAt: NOW }],
      () => 600,
    );

    expect(result.averageMinutes).toBe(600);
  });

  it("skips shipments with nothing to measure", () => {
    const result = averageTransit([
      { ...delivered(), pickedUpAt: null },
      { ...delivered(), deliveredAt: null },
      // Delivered before it was picked up: a clock-drift artefact, not a
      // negative transit time.
      { ...delivered(), pickedUpAt: NOW, deliveredAt: ago(5) },
    ]);

    expect(result.samples).toBe(0);
    expect(result.averageMinutes).toBeNull();
  });
});

describe("hub dwell time", () => {
  it("measures inbound scan to outbound load", () => {
    // arrived 10:00, departed 16:00 → 360 m
    const result = averageHubDwell([
      { arrivedAt: ago(8), departedAt: ago(2) },
    ]);

    expect(result.samples).toBe(1);
    expect(result.averageMinutes).toBe(360);
  });

  it("leaves consignments still sitting there out, unless asked", () => {
    const legs = [
      { arrivedAt: ago(8), departedAt: ago(2) },
      { arrivedAt: ago(2), departedAt: null },
    ];

    expect(averageHubDwell(legs).samples).toBe(1);

    // With `includeOpen` the second leg is measured to now: 120 m.
    //   mean of 360 and 120 = 240
    const withOpen = averageHubDwell(legs, { includeOpen: NOW });
    expect(withOpen.samples).toBe(2);
    expect(withOpen.averageMinutes).toBe(240);
    expect(withOpen.medianMinutes).toBe(240);
  });
});

// ────────────────────────────────────────────────────────────

describe("truck load utilisation", () => {
  it("divides fleet totals rather than averaging per trip", () => {
    //   weight: (9000 + 1000) ÷ (10000 + 2000) = 10000 ÷ 12000 = 83.33%
    //   volume: 400 ÷ 600 = 66.67%, with one trip carrying no capacity
    //
    // Averaging per trip would call a full 20-tonner and a half-empty
    // tempo "75% utilised", which is not what anyone means by the phrase.
    const result = truckUtilisation([
      {
        loadedWeightKg: 9000,
        capacityKg: 10_000,
        loadedVolumeCft: 400,
        capacityCft: 600,
      },
      { loadedWeightKg: 1000, capacityKg: 2000, capacityCft: null },
    ]);

    expect(result.weightPercent).toBe(83.33);
    expect(result.volumePercent).toBe(66.67);
    expect(result.trips).toBe(2);
    expect(result.volumeUnknown).toBe(1);
  });

  it("reports null when no capacity is known at all", () => {
    const result = truckUtilisation([
      { loadedWeightKg: 500, capacityKg: 0, capacityCft: null },
    ]);

    expect(result.weightPercent).toBeNull();
    expect(result.volumePercent).toBeNull();
  });
});

describe("damage & loss rate", () => {
  it("divides affected consignments by consignments handled", () => {
    // 3 of 20 = 15%
    const facts = Array.from({ length: 20 }, (_, index) => ({
      hadDamageOrLoss: index < 3,
    }));

    expect(damageLossRate(facts).percent).toBe(15);
  });
});

// ────────────────────────────────────────────────────────────

describe("COD ageing", () => {
  it("buckets what has been collected but not remitted", () => {
    //   ₹1,000.00 collected  6 h ago →  0 days → 0–1 d
    //   ₹2,500.50 collected 30 h ago →  1 day  → 0–1 d
    //   ₹  500.00 collected  3 d ago →  3 days → 2–3 d
    //   ₹  750.25 collected 10 d ago → 10 days → 7+ d
    //   ₹9,999.00 already remitted   → not aged at all
    //
    //   0–1 d = 3,500.50 over 2 · 2–3 d = 500.00 · 4–7 d = nil
    //   7+ d  =   750.25 over 1 · total = 4,750.75 over 4
    const result = codAgeing(
      [
        { amount: "1000.00", since: ago(6) },
        { amount: "2500.50", since: ago(30) },
        { amount: "500.00", since: ago(72) },
        { amount: "750.25", since: ago(240) },
        { amount: "9999.00", since: ago(480), until: ago(1) },
      ],
      NOW,
    );

    const [zeroToOne, twoToThree, fourToSeven, older] = result.buckets;

    expect(zeroToOne.label).toBe("0–1 d");
    expect(zeroToOne.count).toBe(2);
    expect(zeroToOne.amount.toFixed(2)).toBe("3500.50");

    expect(twoToThree.label).toBe("2–3 d");
    expect(twoToThree.count).toBe(1);
    expect(twoToThree.amount.toFixed(2)).toBe("500.00");

    expect(fourToSeven.label).toBe("4–7 d");
    expect(fourToSeven.count).toBe(0);
    expect(fourToSeven.amount.toFixed(2)).toBe("0.00");

    expect(older.label).toBe("7+ d");
    expect(older.count).toBe(1);
    expect(older.amount.toFixed(2)).toBe("750.25");

    expect(result.total.toFixed(2)).toBe("4750.75");
    expect(result.count).toBe(4);
  });

  it("adds money with decimal.js, not floats", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point. Rupees
    // are never allowed to do that.
    const result = codAgeing(
      [
        { amount: "0.10", since: ago(1) },
        { amount: "0.20", since: ago(1) },
      ],
      NOW,
    );

    expect(result.total.equals(new Decimal("0.30"))).toBe(true);
  });

  it("takes receivables edges for the outstanding report", () => {
    //   0–30 / 31–60 / 61–90 / 90+, straight out of §A.12
    const buckets = ageingBuckets([], NOW, [30, 60, 90]);

    expect(buckets.map((b) => b.label)).toEqual([
      "0–30 d",
      "31–60 d",
      "61–90 d",
      "90+ d",
    ]);
  });
});

// ────────────────────────────────────────────────────────────

describe("grading", () => {
  it("grades a higher-is-better KPI on its boundaries", () => {
    const t = { good: 95, watch: 90, better: "higher" as const };

    expect(gradeKpi(95, t)).toBe("good");
    expect(gradeKpi(94.99, t)).toBe("watch");
    expect(gradeKpi(90, t)).toBe("watch");
    expect(gradeKpi(89.99, t)).toBe("bad");
  });

  it("grades a lower-is-better KPI on its boundaries", () => {
    const t = { good: 5, watch: 10, better: "lower" as const };

    expect(gradeKpi(5, t)).toBe("good");
    expect(gradeKpi(5.01, t)).toBe("watch");
    expect(gradeKpi(10, t)).toBe("watch");
    expect(gradeKpi(10.01, t)).toBe("bad");
  });

  it("says unknown rather than bad when there is no number", () => {
    // A KPI with no data is not a failing KPI, and colouring it red sends
    // somebody to investigate an empty week.
    const t = { good: 95, watch: 90, better: "higher" as const };

    expect(gradeKpi(null, t)).toBe("unknown");
    expect(gradeKpi(Number.NaN, t)).toBe("unknown");
  });
});

describe("formatting", () => {
  it("renders minutes the way the dashboard reads them", () => {
    expect(formatMinutes(45)).toBe("45 m");
    expect(formatMinutes(600)).toBe("10 h");
    expect(formatMinutes(1280)).toBe("21 h 20 m");
    expect(formatMinutes(60 * 50)).toBe("2 d 2 h");
    expect(formatMinutes(null)).toBe("—");
  });

  it("never renders an absent percentage as zero", () => {
    expect(formatPercent(66.67)).toBe("66.7%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("pairing a hub arrival with its departure", () => {
  const at = (iso: string) => new Date(iso);

  it("matches the departure from the same hub, not merely the next one", () => {
    // A consignment gate-out at the onward hub used to close the previous
    // hub's dwell: the slow hub read fast and the delay was charged to
    // whoever handled the freight afterwards.
    const arrival = {
      shipmentId: "s1",
      occurredAt: at("2026-08-27T04:00:00.000Z"),
      branchId: "hub_del",
    };

    const departures = [
      { shipmentId: "s1", occurredAt: at("2026-08-27T05:00:00.000Z"), branchId: "hub_jai" },
      { shipmentId: "s1", occurredAt: at("2026-08-27T09:00:00.000Z"), branchId: "hub_del" },
    ];

    expect(firstDepartureAfter(departures, arrival)?.occurredAt.toISOString()).toBe(
      "2026-08-27T09:00:00.000Z",
    );
  });

  it("ignores another consignment's departure and anything before the arrival", () => {
    const arrival = {
      shipmentId: "s1",
      occurredAt: at("2026-08-27T04:00:00.000Z"),
      branchId: "hub_del",
    };

    expect(
      firstDepartureAfter(
        [
          { shipmentId: "s2", occurredAt: at("2026-08-27T06:00:00.000Z"), branchId: "hub_del" },
          { shipmentId: "s1", occurredAt: at("2026-08-27T03:00:00.000Z"), branchId: "hub_del" },
        ],
        arrival,
      ),
    ).toBeUndefined();
  });

  it("agrees with the arrival and departure event lists both readers use", () => {
    // One list, so the dashboard KPI and the dwell report cannot be
    // measured off different events.
    expect(HUB_ARRIVAL_EVENTS).toContain("UNLOADED");
    expect(HUB_DEPARTURE_EVENTS).toContain("GATE_OUT");
  });
});
