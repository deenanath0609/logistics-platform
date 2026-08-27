import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  DEFAULT_DWELL_THRESHOLDS,
  codShortfallDecision,
  dwellThresholdHours,
  hubDwellDecision,
  parseDwellThresholds,
  pendingPodDecision,
  type CodShortfallFacts,
  type DetectorDecision,
  type HubDwellFacts,
  type PendingPodFacts,
} from "./detectors";

/**
 * The three detectors, exercised at their boundaries.
 *
 * The last block is the one that matters most: it proves that re-running
 * a detector produces the same dedupe key, and that a store enforcing
 * uniqueness on that key therefore ends up with exactly one row however
 * many times the scan runs. That guarantee is the difference between a
 * tower a duty manager reads and four hundred rows of the same problem.
 */

const NOW = new Date("2026-08-27T12:00:00.000Z");

function hours(from: Date, count: number): Date {
  return new Date(from.getTime() + count * 3_600_000);
}

// ────────────────────────────────────────────────────────────
// Hub dwell
// ────────────────────────────────────────────────────────────

function dwellFacts(overrides: Partial<HubDwellFacts> = {}): HubDwellFacts {
  return {
    shipmentId: "shp_1",
    lrNumber: "CL202608270001",
    branchId: "br_del",
    branchCode: "HUB-DEL",
    arrivedAt: hours(NOW, -30),
    hasOutboundSince: false,
    thresholdHours: 24,
    now: NOW,
    ...overrides,
  };
}

describe("hub dwell", () => {
  it("raises once the consignment has sat longer than the threshold", () => {
    const decision = hubDwellDecision(dwellFacts());

    expect(decision).not.toBeNull();
    expect(decision?.kind).toBe("HUB_DWELL");
    expect(decision?.priority).toBe("NORMAL");
    expect(decision?.title).toContain("HUB-DEL");
    expect(decision?.title).toContain("30 h");
  });

  it("says nothing while the consignment is inside its tolerance", () => {
    // 23 h at a branch that tolerates 24 h is a hub working normally.
    expect(hubDwellDecision(dwellFacts({ arrivedAt: hours(NOW, -23) }))).toBeNull();
  });

  it("fires exactly at the threshold, not a minute after", () => {
    // The threshold is the moment somebody asked to be told, so it is the
    // moment they are told.
    const decision = hubDwellDecision(dwellFacts({ arrivedAt: hours(NOW, -24) }));
    expect(decision).not.toBeNull();
  });

  it("ignores a consignment that has moved since it arrived", () => {
    // Six days at a hub with a gate-out recorded is not dwell — it is a
    // consignment mid-journey, and blaming the hub for it is wrong.
    expect(
      hubDwellDecision(
        dwellFacts({ arrivedAt: hours(NOW, -144), hasOutboundSince: true }),
      ),
    ).toBeNull();
  });

  it("raises the priority once the dwell is twice what was tolerated", () => {
    // Just over is a hub running late; twice over is freight nobody has
    // looked at, and the duty manager needs those apart.
    expect(hubDwellDecision(dwellFacts({ arrivedAt: hours(NOW, -49) }))?.priority).toBe(
      "HIGH",
    );
  });

  it("treats a threshold of zero as the monitor being switched off", () => {
    expect(hubDwellDecision(dwellFacts({ thresholdHours: 0 }))).toBeNull();
  });
});

describe("the dwell threshold config", () => {
  it("accepts a bare number, which is what most installs will write", () => {
    expect(parseDwellThresholds(12)).toEqual({
      defaultHours: 12,
      byBranchCode: {},
    });
  });

  it("accepts per-branch overrides", () => {
    const thresholds = parseDwellThresholds({
      defaultHours: 24,
      byBranchCode: { "hub-del": 6 },
    });

    // A sorting hub turning freight in four hours and a rural branch
    // waiting on a weekly line-haul cannot share one number.
    expect(dwellThresholdHours(thresholds, "HUB-DEL")).toBe(6);
    expect(dwellThresholdHours(thresholds, "BR-FBD")).toBe(24);
    expect(dwellThresholdHours(thresholds, null)).toBe(24);
  });

  it("falls back rather than throwing on a typo in the settings row", () => {
    // A bad config must fail to change the monitor, never stop it.
    expect(parseDwellThresholds("not a number")).toEqual(DEFAULT_DWELL_THRESHOLDS);
    expect(parseDwellThresholds(null)).toEqual(DEFAULT_DWELL_THRESHOLDS);
    expect(parseDwellThresholds(-5)).toEqual(DEFAULT_DWELL_THRESHOLDS);
  });
});

// ────────────────────────────────────────────────────────────
// Pending POD
// ────────────────────────────────────────────────────────────

function podFacts(overrides: Partial<PendingPodFacts> = {}): PendingPodFacts {
  return {
    shipmentId: "shp_2",
    lrNumber: "CL202608260014",
    deliveredAt: hours(NOW, -30),
    hasPod: false,
    thresholdHours: 24,
    now: NOW,
    branchCode: "HUB-JAI",
    ...overrides,
  };
}

describe("pending POD", () => {
  it("raises when a delivery is older than the window with no proof", () => {
    const decision = pendingPodDecision(podFacts());

    expect(decision?.kind).toBe("POD_PENDING");
    expect(decision?.priority).toBe("LOW");
    expect(decision?.detail).toContain("HUB-JAI");
  });

  it("says nothing once the POD exists, however late it was", () => {
    expect(
      pendingPodDecision(podFacts({ hasPod: true, deliveredAt: hours(NOW, -500) })),
    ).toBeNull();
  });

  it("says nothing about a shipment that has not been delivered", () => {
    expect(pendingPodDecision(podFacts({ deliveredAt: null }))).toBeNull();
  });

  it("holds off inside the 24 h the BRD allows", () => {
    expect(pendingPodDecision(podFacts({ deliveredAt: hours(NOW, -23) }))).toBeNull();
  });

  it("lifts the priority once the proof is not late but missing", () => {
    // Past 48 h nobody is going back for a signature.
    expect(
      pendingPodDecision(podFacts({ deliveredAt: hours(NOW, -49) }))?.priority,
    ).toBe("NORMAL");
  });
});

// ────────────────────────────────────────────────────────────
// COD shortfall
// ────────────────────────────────────────────────────────────

function codFacts(overrides: Partial<CodShortfallFacts> = {}): CodShortfallFacts {
  return {
    agentId: "usr_agent",
    agentName: "Ramesh Kumar",
    branchId: "br_ggn",
    branchCode: "BR-GGN",
    date: "2026-08-26",
    collected: new Decimal("12500.00"),
    deposited: new Decimal("11000.00"),
    tolerance: new Decimal(0),
    dayEndPassed: true,
    ...overrides,
  };
}

describe("COD shortfall", () => {
  it("raises when an agent has collected more than they handed over", () => {
    const decision = codShortfallDecision(codFacts());

    expect(decision?.kind).toBe("COD_SHORTFALL");
    expect(decision?.priority).toBe("CRITICAL");
    expect(decision?.title).toContain("1500.00");
  });

  it("stays silent until the day is actually over", () => {
    // Collected-minus-deposited is non-zero for every agent for most of
    // every day. A detector that ignored that would open an exception
    // against the whole delivery fleet by mid-morning.
    expect(codShortfallDecision(codFacts({ dayEndPassed: false }))).toBeNull();
  });

  it("says nothing when the cash adds up", () => {
    expect(
      codShortfallDecision(codFacts({ deposited: new Decimal("12500.00") })),
    ).toBeNull();
  });

  it("says nothing when the agent deposited more than they collected", () => {
    // An over-deposit is a reconciliation question for accounts, not a
    // shortfall, and calling it one would send it to the wrong desk.
    expect(
      codShortfallDecision(codFacts({ deposited: new Decimal("13000.00") })),
    ).toBeNull();
  });

  it("respects a configured tolerance", () => {
    const tolerance = new Decimal("2000");
    expect(codShortfallDecision(codFacts({ tolerance }))).toBeNull();
  });

  it("counts a shortfall exactly at the tolerance as within it", () => {
    expect(
      codShortfallDecision(codFacts({ tolerance: new Decimal("1500") })),
    ).toBeNull();
  });

  it("does not lose paise to floating point", () => {
    const decision = codShortfallDecision(
      codFacts({
        collected: new Decimal("0.30"),
        deposited: new Decimal("0.10"),
      }),
    );

    // 0.3 - 0.1 is 0.19999999999999998 in a float. Money is not a float.
    expect(decision?.title).toContain("0.20");
  });
});

// ────────────────────────────────────────────────────────────
// Idempotency — the guarantee the whole tower rests on
// ────────────────────────────────────────────────────────────

/**
 * A stand-in for `Exception.dedupeKey`'s unique index.
 *
 * `raiseException` returns the existing row rather than creating a second
 * one when the key is taken; this models exactly that, so the assertion
 * below is about the detectors' keys rather than about Prisma.
 */
function makeTower() {
  const rows = new Map<string, DetectorDecision & { detectedAt: Date }>();

  return {
    raise(decision: DetectorDecision | null, at: Date): boolean {
      if (!decision) return false;
      if (rows.has(decision.dedupeKey)) return false;
      rows.set(decision.dedupeKey, { ...decision, detectedAt: at });
      return true;
    },
    size: () => rows.size,
    get: (key: string) => rows.get(key),
    keys: () => [...rows.keys()],
  };
}

describe("re-running a detector", () => {
  it("opens one hub-dwell exception however many times the scan runs", () => {
    const tower = makeTower();
    const arrivedAt = hours(NOW, -30);
    let opened = 0;

    // The sweep runs every three minutes. Eight hours of it, over a
    // consignment that nobody moves.
    for (let tick = 0; tick < 160; tick++) {
      const now = new Date(NOW.getTime() + tick * 180_000);
      if (tower.raise(hubDwellDecision(dwellFacts({ arrivedAt, now })), now)) {
        opened++;
      }
    }

    expect(opened).toBe(1);
    expect(tower.size()).toBe(1);

    // And the row still carries the first detection, which is what the
    // ageing column shows. A key derived from `now` would have reset it
    // on every pass and reported the problem as three minutes old.
    expect(tower.get("dwell:shp_1:br_del")?.detectedAt).toEqual(NOW);
  });

  it("opens one pending-POD exception however many times the scan runs", () => {
    const tower = makeTower();
    const deliveredAt = hours(NOW, -30);
    let opened = 0;

    for (let tick = 0; tick < 160; tick++) {
      const now = new Date(NOW.getTime() + tick * 180_000);
      tower.raise(pendingPodDecision(podFacts({ deliveredAt, now })), now);
    }

    opened = tower.size();
    expect(opened).toBe(1);
  });

  it("opens one COD shortfall per agent per day, not per pass", () => {
    const tower = makeTower();

    for (let tick = 0; tick < 50; tick++) {
      const now = new Date(NOW.getTime() + tick * 180_000);
      tower.raise(codShortfallDecision(codFacts()), now);
    }

    expect(tower.size()).toBe(1);

    // The next day going wrong is a second, separate failure — the date
    // is in the key precisely so it does not disappear behind the first.
    tower.raise(codShortfallDecision(codFacts({ date: "2026-08-27" })), NOW);
    expect(tower.size()).toBe(2);
  });

  it("keeps two hubs' dwell apart", () => {
    const tower = makeTower();

    // Idle at Delhi, then moved on and idle at Jaipur: two failures, by
    // two hubs, and collapsing them would let the second hub off.
    tower.raise(hubDwellDecision(dwellFacts()), NOW);
    tower.raise(
      hubDwellDecision(dwellFacts({ branchId: "br_jai", branchCode: "HUB-JAI" })),
      NOW,
    );

    expect(tower.keys()).toEqual(["dwell:shp_1:br_del", "dwell:shp_1:br_jai"]);
  });

  it("keeps the three detectors' keys from colliding with each other", () => {
    // All three can fire on the same shipment id, and a shared prefix
    // would silently drop two of them.
    const keys = new Set([
      hubDwellDecision(dwellFacts({ shipmentId: "shp_x" }))?.dedupeKey,
      pendingPodDecision(podFacts({ shipmentId: "shp_x" }))?.dedupeKey,
      codShortfallDecision(codFacts({ agentId: "shp_x" }))?.dedupeKey,
    ]);

    expect(keys.size).toBe(3);
  });
});
