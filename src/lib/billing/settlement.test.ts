import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Preparing a driver settlement.
 *
 * This is the document a payout is made against, and three things about it
 * were decided by whoever posted the form. The trip was fetched by id with
 * nothing but tenant scoping, so any id settled. The earning was taken
 * from the form *in preference to* the trip's own `freightPayable`, so a
 * number typed into a field beat the record. And the gate is
 * `settlement.prepare` — which the DRIVER role holds, for logging fuel in the
 * field — so the payee could raise their own payout.
 *
 * The approval step is a real control and is left alone; these tests are
 * about what the preparer can decide unilaterally.
 */

const store = vi.hoisted(() => ({
  /** The trip's own agreed freight. Null is the common case today. */
  freightPayable: null as string | null,
  /** The app_user behind the driver, when they have a field login. */
  driverUserId: null as string | null,
  created: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/session", () => ({
  can: (actor: { permissions: ReadonlySet<string> }, permission: string) =>
    actor.permissions.has(permission),
}));

vi.mock("@/lib/numbering/number-series", () => ({
  nextNumber: async () => "SET/2627/000004",
}));

vi.mock("@/server/services/audit", () => ({
  recordAudit: async (input: Record<string, unknown>) => {
    store.audits.push(input);
  },
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    trip: {
      findUnique: async () => ({
        id: "trip-1",
        number: "TR/2627/000014",
        driverId: "drv-1",
        originBranchId: "br-jai",
        destinationBranchId: "br-del",
        freightPayable: store.freightPayable,
        advancePaid: "2000.00",
        driver: { id: "drv-1", name: "Ramesh Kumar", userId: store.driverUserId },
        expenses: [
          {
            id: "exp-1",
            category: "FUEL",
            amount: "3000.00",
            isApproved: true,
            incurredOn: new Date("2026-08-20"),
          },
        ],
      }),
    },
    driverSettlement: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        store.created.push(args.data);
        return { id: "set-1", number: args.data.number };
      },
    },
  };

  return {
    prisma: client,
    tenantTransaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> =>
      callback(client),
  };
});

const { createSettlement } = await import("./settlement");

type Actor = Parameters<typeof createSettlement>[1];

function user(
  id: string,
  branchIds: string[] | null,
  scope: Actor["scope"] = "BRANCH",
): Actor {
  return {
    id,
    orgId: "org-1",
    name: "Someone",
    mobile: "9000000000",
    email: null,
    isFieldUser: false,
    mustChangePassword: false,
    primaryBranch: branchIds?.[0] ? { id: branchIds[0], code: "X", name: "X" } : null,
    roles: [],
    permissions: new Set(["settlement.prepare"]),
    scope,
    branchIds,
  };
}

/** The transport desk: network scope, holds `settlement.prepare`. */
const desk = () => user("usr-desk", null, "NETWORK");

beforeEach(() => {
  store.freightPayable = null;
  store.driverUserId = null;
  store.created = [];
  store.audits = [];
});

describe("the earning comes from the trip, not from the form", () => {
  it("ignores a figure posted against a trip that has its own freight", async () => {
    store.freightPayable = "18000.00";

    const result = await createSettlement(
      { tripId: "trip-1", tripEarning: 180000 },
      desk(),
    );

    expect(result.ok).toBe(true);
    expect(store.created.at(0)).toMatchObject({ tripEarning: "18000.00" });
    // 18000 − 2000 advance + 3000 approved expenses.
    expect(store.created.at(0)).toMatchObject({ netPayable: "19000.00" });
    expect(store.audits.at(0)?.after).toMatchObject({
      tripEarningSource: "trip freight payable",
    });
  });

  it("accepts a typed figure only where the trip carries none, and says so", async () => {
    const result = await createSettlement(
      { tripId: "trip-1", tripEarning: 18000 },
      desk(),
    );

    expect(result.ok).toBe(true);
    expect(store.created.at(0)).toMatchObject({ tripEarning: "18000.00" });
    expect(store.audits.at(0)?.after).toMatchObject({
      tripEarningSource: "entered by hand",
    });
  });
});

describe("a settlement is scoped to the trip's branches", () => {
  it("refuses a trip that ran between branches the preparer does not cover", async () => {
    const elsewhere = user("usr-bom", ["br-bom"]);

    const result = await createSettlement(
      { tripId: "trip-1", tripEarning: 18000 },
      elsewhere,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/do not cover/i);
    expect(store.created).toHaveLength(0);
  });

  it("allows either end of the lane, which is what the queue shows", async () => {
    for (const branch of ["br-jai", "br-del"]) {
      store.created = [];
      const result = await createSettlement(
        { tripId: "trip-1", tripEarning: 18000 },
        user(`usr-${branch}`, [branch]),
      );
      expect(result.ok, branch).toBe(true);
    }
  });
});

describe("nobody prepares their own payout", () => {
  it("refuses the driver being settled, who holds settlement.prepare for fuel claims", async () => {
    store.driverUserId = "usr-ramesh";

    const result = await createSettlement(
      { tripId: "trip-1", tripEarning: 250000 },
      user("usr-ramesh", ["br-jai"]),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/own settlement/i);
    expect(store.created).toHaveLength(0);
  });

  it("still lets a colleague at the same branch raise it", async () => {
    store.driverUserId = "usr-ramesh";

    const result = await createSettlement(
      { tripId: "trip-1", tripEarning: 18000 },
      user("usr-clerk", ["br-jai"]),
    );

    expect(result.ok).toBe(true);
    expect(store.created).toHaveLength(1);
  });
});
