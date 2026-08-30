import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Plan limits, from the rule outwards.
 *
 * The pure decision is tested directly. The assertion is tested against a
 * fake Prisma that holds rows and answers `count`, so a test that says "the
 * eleventh user is refused" fails if somebody deletes the count rather than
 * passing because the stub was hard-coded to the right number. The tenant
 * comes from the real `runWithTenant`, because `assertWithinLimit` reading
 * the tenant from anywhere else would be a bug worth catching here.
 */

process.env.DATABASE_URL ??= "postgres://unused/unused";

type PlanRow = {
  code: string;
  name: string;
  maxUsers: number | null;
  maxBranches: number | null;
  maxShipmentsPerMonth: number | null;
  maxPortalUsers: number | null;
};

const db = {
  timezone: "Asia/Kolkata",
  plan: null as PlanRow | null,
  users: [] as Array<{ status: string; deletedAt: Date | null }>,
  branches: [] as Array<{ isActive: boolean; deletedAt: Date | null }>,
  portalUsers: [] as Array<{ isActive: boolean; deletedAt: Date | null }>,
  shipments: [] as Array<{ bookedAt: Date }>,
};

/** Counts of calls, so "did it query at all?" is assertable. */
const calls = { organization: 0, user: 0, branch: 0, customerUser: 0, shipment: 0 };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: {
      findUnique: async () => {
        calls.organization += 1;
        return { timezone: db.timezone, plan: db.plan };
      },
    },
    user: {
      count: async () => {
        calls.user += 1;
        return db.users.filter(
          (u) => u.deletedAt === null && u.status !== "INACTIVE",
        ).length;
      },
    },
    branch: {
      count: async () => {
        calls.branch += 1;
        return db.branches.filter((b) => b.deletedAt === null && b.isActive)
          .length;
      },
    },
    customerUser: {
      count: async () => {
        calls.customerUser += 1;
        return db.portalUsers.filter((c) => c.deletedAt === null && c.isActive)
          .length;
      },
    },
    shipment: {
      // Applies the range it is given rather than returning a fixed number,
      // so a wrong month window shows up as a wrong count.
      count: async (args: { where: { bookedAt: { gte: Date; lt: Date } } }) => {
        calls.shipment += 1;
        const { gte, lt } = args.where.bookedAt;
        return db.shipments.filter(
          (s) => s.bookedAt >= gte && s.bookedAt < lt,
        ).length;
      },
    },
  },
}));

import { runWithTenant, type TenantContext } from "@/lib/tenant/context";
import {
  assertWithinLimit,
  isPlanLimitError,
  limitOutcome,
  monthWindow,
  planUsage,
  PlanLimitError,
} from "@/lib/plan-limits";

const TENANT: TenantContext = {
  orgId: "org_acme",
  slug: "acme",
  subdomain: "acme",
  status: "ACTIVE",
  source: "host",
  readOnly: false,
};

function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenant(TENANT, fn);
}

function plan(patch: Partial<PlanRow> = {}): PlanRow {
  return {
    code: "GROWTH",
    name: "Growth",
    maxUsers: null,
    maxBranches: null,
    maxShipmentsPerMonth: null,
    maxPortalUsers: null,
    ...patch,
  };
}

function seedUsers(n: number): void {
  db.users = Array.from({ length: n }, () => ({
    status: "ACTIVE",
    deletedAt: null,
  }));
}

/** The error, or null when the call was allowed. */
async function refusal(
  key: Parameters<typeof assertWithinLimit>[0],
): Promise<PlanLimitError | null> {
  try {
    await asTenant(() => assertWithinLimit(key));
    return null;
  } catch (error) {
    if (isPlanLimitError(error)) return error as PlanLimitError;
    throw error;
  }
}

beforeEach(() => {
  db.timezone = "Asia/Kolkata";
  db.plan = null;
  db.users = [];
  db.branches = [];
  db.portalUsers = [];
  db.shipments = [];
  calls.organization = 0;
  calls.user = 0;
  calls.branch = 0;
  calls.customerUser = 0;
  calls.shipment = 0;
});

// ────────────────────────────────────────────────────────────
// The rule
// ────────────────────────────────────────────────────────────

describe("limitOutcome", () => {
  it("treats null as unlimited at any count", () => {
    expect(limitOutcome(null, 0)).toEqual({ allowed: true });
    expect(limitOutcome(null, 1_000_000)).toEqual({ allowed: true });
  });

  it("treats zero as the feature being off, not as no limit", () => {
    expect(limitOutcome(0, 0)).toEqual({
      allowed: false,
      reason: "not-included",
    });
  });

  it("allows up to the cap and refuses at it", () => {
    expect(limitOutcome(10, 9)).toEqual({ allowed: true });
    expect(limitOutcome(10, 10)).toEqual({
      allowed: false,
      reason: "at-capacity",
    });
    expect(limitOutcome(10, 11)).toEqual({
      allowed: false,
      reason: "at-capacity",
    });
  });
});

// ────────────────────────────────────────────────────────────
// The eleventh user
// ────────────────────────────────────────────────────────────

describe("a ten-user plan", () => {
  beforeEach(() => {
    db.plan = plan({ maxUsers: 10 });
  });

  it("admits the tenth", async () => {
    seedUsers(9);
    expect(await refusal("users")).toBeNull();
  });

  it("refuses the eleventh, naming the plan and the number", async () => {
    seedUsers(10);
    const error = await refusal("users");

    expect(error).not.toBeNull();
    expect(error?.reason).toBe("at-capacity");
    expect(error?.limit).toBe(10);
    expect(error?.current).toBe(10);
    expect(error?.planName).toBe("Growth");
    expect(error?.message).toBe(
      "You have reached your limit of 10 staff users on the Growth plan.",
    );
  });

  it("does not count staff who have been stood down", async () => {
    seedUsers(10);
    db.users[0] = { status: "INACTIVE", deletedAt: new Date() };
    // Nine seats in use, so the roster can take one more without the
    // carrier being billed for a driver who left.
    expect(await refusal("users")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// Null is not zero
// ────────────────────────────────────────────────────────────

describe("null against zero", () => {
  it("null is unlimited, and does not even count", async () => {
    db.plan = plan({ maxPortalUsers: null });
    db.portalUsers = Array.from({ length: 5_000 }, () => ({
      isActive: true,
      deletedAt: null,
    }));

    expect(await refusal("portalUsers")).toBeNull();
    expect(calls.customerUser).toBe(0);
  });

  it("zero refuses with the not-included wording, not the limit wording", async () => {
    db.plan = plan({ name: "Starter", maxPortalUsers: 0 });
    const error = await refusal("portalUsers");

    expect(error?.reason).toBe("not-included");
    expect(error?.message).toBe(
      "Customer portal logins are not included in your Starter plan.",
    );
    // The two sentences must not be confusable — a carrier told the wrong
    // one rings up to buy more of something they cannot have.
    expect(error?.message).not.toContain("reached your limit");
    // And no count was taken: no number could change the answer.
    expect(calls.customerUser).toBe(0);
  });

  it("says 'reached your limit' only when there is a limit to reach", async () => {
    db.plan = plan({ maxBranches: 3 });
    db.branches = Array.from({ length: 3 }, () => ({
      isActive: true,
      deletedAt: null,
    }));
    const error = await refusal("branches");

    expect(error?.message).toBe(
      "You have reached your limit of 3 branches on the Growth plan.",
    );
    expect(error?.message).not.toContain("not included");
  });
});

// ────────────────────────────────────────────────────────────
// No plan at all
// ────────────────────────────────────────────────────────────

describe("a carrier with no plan", () => {
  // Provisioning creates every tenant with `planId: null`, so this is the
  // ordinary state of a new carrier rather than a corner case. It is
  // unconstrained on purpose: a limit is a term of a contract that does not
  // exist yet, and treating "no plan" as zero would mean provisioning could
  // not create the head-office branch or the owner login it needs to hand
  // the tenant over.
  it("is capped at nothing, and takes no counts", async () => {
    db.plan = null;
    seedUsers(500);
    db.branches = Array.from({ length: 40 }, () => ({
      isActive: true,
      deletedAt: null,
    }));

    expect(await refusal("users")).toBeNull();
    expect(await refusal("branches")).toBeNull();
    expect(await refusal("shipmentsThisMonth")).toBeNull();
    expect(await refusal("portalUsers")).toBeNull();

    expect(calls.user).toBe(0);
    expect(calls.branch).toBe(0);
    expect(calls.shipment).toBe(0);
  });

  it("still reports usage, so the numbers are visible before a plan lands", async () => {
    db.plan = null;
    seedUsers(8);

    const usage = await asTenant(() => planUsage());
    const users = usage.limits.find((l) => l.key === "users");

    expect(usage.planName).toBeNull();
    expect(users?.current).toBe(8);
    expect(users?.limit).toBeNull();
    expect(users?.remaining).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// The month boundary
// ────────────────────────────────────────────────────────────

describe("the monthly shipment count", () => {
  // 31 Aug 2026, 23:00 IST — 17:30 UTC on the 31st.
  const LATE_IN_AUGUST = new Date("2026-08-31T17:30:00.000Z");
  // 1 Sep 2026, 02:00 IST — 20:30 UTC on the *31st of August*. This is the
  // instant a UTC-based window gets wrong, and the carrier is billed on
  // their own calendar, not the server's.
  const EARLY_IN_SEPTEMBER = new Date("2026-08-31T20:30:00.000Z");

  beforeEach(() => {
    db.plan = plan({ maxShipmentsPerMonth: 2 });
    db.shipments = [
      { bookedAt: new Date("2026-08-05T06:00:00.000Z") },
      { bookedAt: new Date("2026-08-20T06:00:00.000Z") },
    ];
  });

  it("refuses the third booking of the month", async () => {
    vi.setSystemTime(LATE_IN_AUGUST);
    const error = await refusal("shipmentsThisMonth");

    expect(error?.reason).toBe("at-capacity");
    expect(error?.current).toBe(2);
    expect(error?.message).toBe(
      "You have reached your limit of 2 shipments a month on the Growth plan.",
    );
    vi.useRealTimers();
  });

  it("resets once the carrier's month turns over", async () => {
    vi.setSystemTime(EARLY_IN_SEPTEMBER);
    // Same two August shipments in the table, but they are no longer in
    // this month's window, so the carrier starts September with room.
    expect(await refusal("shipmentsThisMonth")).toBeNull();
    vi.useRealTimers();
  });

  it("counts on the carrier's clock, not the server's", () => {
    const august = monthWindow(LATE_IN_AUGUST, "Asia/Kolkata");
    const september = monthWindow(EARLY_IN_SEPTEMBER, "Asia/Kolkata");

    expect(august.key).toBe("2026-08");
    expect(september.key).toBe("2026-09");
    // Both instants fall on 31 August in UTC. A UTC window would have put
    // them in the same month and the reset above would never happen.
    expect(LATE_IN_AUGUST.getUTCDate()).toBe(31);
    expect(EARLY_IN_SEPTEMBER.getUTCDate()).toBe(31);
    // The windows meet exactly, so no booking falls in both or neither.
    expect(august.end.getTime()).toBe(september.start.getTime());
  });

  it("puts the boundary at local midnight", () => {
    const { start } = monthWindow(EARLY_IN_SEPTEMBER, "Asia/Kolkata");
    // 1 Sep 00:00 IST is 31 Aug 18:30 UTC.
    expect(start.toISOString()).toBe("2026-08-31T18:30:00.000Z");
  });

  it("handles a zone that shifts for daylight saving", () => {
    // Europe/London is on BST in August and GMT in December.
    const summer = monthWindow(
      new Date("2026-08-15T12:00:00.000Z"),
      "Europe/London",
    );
    const winter = monthWindow(
      new Date("2026-12-15T12:00:00.000Z"),
      "Europe/London",
    );

    expect(summer.start.toISOString()).toBe("2026-07-31T23:00:00.000Z");
    expect(winter.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });
});

// ────────────────────────────────────────────────────────────
// The read side
// ────────────────────────────────────────────────────────────

describe("planUsage", () => {
  it("reports current against limit for every cap", async () => {
    db.plan = plan({ maxUsers: 10, maxBranches: 0, maxPortalUsers: 4 });
    seedUsers(8);
    db.portalUsers = [{ isActive: true, deletedAt: null }];

    const usage = await asTenant(() => planUsage());
    const by = Object.fromEntries(usage.limits.map((l) => [l.key, l]));

    expect(usage.planName).toBe("Growth");
    expect(by.users).toMatchObject({ current: 8, limit: 10, remaining: 2 });
    expect(by.users.fraction).toBeCloseTo(0.8);
    // Switched off reads as full rather than as a division by zero.
    expect(by.branches).toMatchObject({ limit: 0, remaining: 0, fraction: 1 });
    expect(by.shipmentsThisMonth).toMatchObject({ limit: null, remaining: null });
  });

  it("never reports negative headroom when a carrier is already over", async () => {
    db.plan = plan({ maxUsers: 2 });
    seedUsers(5);

    const usage = await asTenant(() => planUsage());
    const users = usage.limits.find((l) => l.key === "users");

    expect(users?.current).toBe(5);
    expect(users?.remaining).toBe(0);
    expect(users?.fraction).toBe(1);
  });
});
