import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Approving, paying and cancelling a driver settlement.
 *
 * `settlement.test.ts` opens with "the approval step is a real control and
 * is left alone" — and it is left alone by the whole suite. `createSettlement`
 * has nine assertions on it; `approveSettlement`, `markSettlementPaid` and
 * `cancelSettlement` had none, so this is the one place in the product where
 * cash leaves the building and nothing could turn red.
 *
 * The control that matters is the two-person rule. It is not a permission
 * rule and cannot be: ACCOUNTS holds `settlement.prepare` *and*
 * `settlement.approve`, deliberately, because a two-person accounts team
 * needs both people to be able to do both jobs. What stops one person doing
 * both on the same document is a single line comparing `createdById` to
 * `actor.id`. Delete that line and, before this file, all 1576 tests passed.
 *
 * ── The refusals are proved twice ───────────────────────────────────────
 *
 * `approveSettlement` checks six things in order: permission, reason,
 * existence, branch scope, status, preparer. Any test of the sixth that is
 * sloppy about the first five is answered by an earlier rule and would pass
 * with the rule under test deleted. So every refusal below is paired with a
 * *control* — the same call, with only the fact under test changed, which
 * must succeed. If the refusal and the control both refuse, the assertion
 * was measuring the wrong rule.
 *
 * And every refusal asserts that nothing was written. A service that returns
 * `{ ok: false }` after updating the row reads identically to one that
 * refused; only the write log tells them apart.
 */

type SettlementRow = {
  id: string;
  number: string;
  status: string;
  netPayable: { toString(): string };
  createdById: string;
  tripId: string | null;
  driver: { name: string };
};

const store = vi.hoisted(() => ({
  settlement: null as Record<string, unknown> | null,
  trip: { originBranchId: "br-jai", destinationBranchId: "br-del" } as
    | { originBranchId: string | null; destinationBranchId: string | null }
    | null,
  updates: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/session", () => ({
  can: (actor: { permissions: ReadonlySet<string> }, permission: string) =>
    actor.permissions.has(permission),
}));

vi.mock("@/lib/numbering/number-series", () => ({
  nextNumber: async () => "SET/2627/000009",
}));

vi.mock("@/server/services/audit", () => ({
  recordAudit: async (input: Record<string, unknown>) => {
    store.audits.push(input);
  },
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    trip: { findUnique: async () => store.trip },
    driverSettlement: {
      findUnique: async () => store.settlement,
      findFirst: async () => null,
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        store.updates.push(args.data);
        return { id: "set-1" };
      },
      create: async () => ({ id: "set-1", number: "SET/2627/000009" }),
    },
  };
  return {
    prisma: client,
    tenantTransaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> =>
      callback(client),
  };
});

const { approveSettlement, markSettlementPaid, cancelSettlement } = await import(
  "./settlement"
);

type Actor = Parameters<typeof approveSettlement>[1];

function user(
  id: string,
  permissions: string[],
  branchIds: string[] | null = null,
): Actor {
  return {
    id,
    orgId: "org-1",
    name: "Someone",
    mobile: "9000000000",
    email: null,
    isFieldUser: false,
    mustChangePassword: false,
    primaryBranch: branchIds?.[0]
      ? { id: branchIds[0], code: "X", name: "X" }
      : null,
    roles: [],
    permissions: new Set(permissions),
    scope: branchIds === null ? "NETWORK" : "BRANCH",
    branchIds,
  };
}

/** The clerk who drafted it. Holds both codes, as ACCOUNTS does. */
const PREPARER = () =>
  user("usr-preparer", ["settlement.prepare", "settlement.approve", "payment.record"]);
/** A second person on the same desk, holding exactly the same codes. */
const SECOND = () =>
  user("usr-second", ["settlement.prepare", "settlement.approve", "payment.record"]);

function settlement(overrides: Partial<SettlementRow> = {}) {
  store.settlement = {
    id: "set-1",
    number: "SET/2627/000009",
    status: "DRAFT",
    netPayable: { toString: () => "19000.00" },
    createdById: "usr-preparer",
    tripId: "trip-1",
    driver: { name: "Ramesh Kumar" },
    paidAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  store.settlement = null;
  store.trip = { originBranchId: "br-jai", destinationBranchId: "br-del" };
  store.updates = [];
  store.audits = [];
  settlement();
});

// ────────────────────────────────────────────────────────────────────────
// The two-person rule
// ────────────────────────────────────────────────────────────────────────

describe("nobody approves the payout they prepared", () => {
  it("refuses the preparer, and writes nothing", async () => {
    const result = await approveSettlement(
      { settlementId: "set-1", reason: "Checked against the trip sheet." },
      PREPARER(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/prepared it/i);
    expect(store.updates).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  /**
   * The control. Identical call, identical permissions, identical branch
   * scope, identical status — only the actor's id differs. Without this,
   * the refusal above would pass just as happily if the permission check
   * or the status check were the thing answering it.
   */
  it("allows a second person holding exactly the same permissions", async () => {
    const result = await approveSettlement(
      { settlementId: "set-1", reason: "Checked against the trip sheet." },
      SECOND(),
    );

    expect(result.ok).toBe(true);
    expect(store.updates.at(0)).toMatchObject({
      status: "APPROVED",
      approvedById: "usr-second",
    });
  });

  it("compares the preparer by id, not by the permissions they hold", async () => {
    // A preparer stripped of `settlement.prepare` after drafting is still
    // the preparer: the document says who raised it.
    const strippedPreparer = user("usr-preparer", ["settlement.approve"]);

    const result = await approveSettlement(
      { settlementId: "set-1", reason: "Same person, fewer codes." },
      strippedPreparer,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/prepared it/i);
    expect(store.updates).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// The rules standing in front of it, each proved by its own control
// ────────────────────────────────────────────────────────────────────────

describe("approveSettlement refuses for the reason it says it does", () => {
  it("refuses without settlement.approve — and the same actor with it succeeds", async () => {
    const withoutIt = user("usr-second", ["settlement.prepare"]);

    const refused = await approveSettlement(
      { settlementId: "set-1", reason: "Looks fine." },
      withoutIt,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/permission/i);
    expect(store.updates).toHaveLength(0);

    const allowed = await approveSettlement(
      { settlementId: "set-1", reason: "Looks fine." },
      SECOND(),
    );
    expect(allowed.ok).toBe(true);
  });

  it("insists on a reason, because the approval is what the audit row is for", async () => {
    for (const reason of ["", "   "]) {
      store.updates = [];
      const result = await approveSettlement(
        { settlementId: "set-1", reason },
        SECOND(),
      );
      expect(result.ok, JSON.stringify(reason)).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/reason/i);
      expect(store.updates).toHaveLength(0);
    }
  });

  it("records the typed reason on the audit row, trimmed", async () => {
    await approveSettlement(
      { settlementId: "set-1", reason: "  Fuel bills seen.  " },
      SECOND(),
    );

    expect(store.audits.at(0)).toMatchObject({
      action: "APPROVE",
      entity: "DriverSettlement",
      reason: "Fuel bills seen.",
    });
    expect(store.audits.at(0)?.after).toMatchObject({
      status: "APPROVED",
      netPayable: "19000.00",
    });
  });

  it("refuses a settlement outside the actor's branches, and writes nothing", async () => {
    const elsewhere = user(
      "usr-bom",
      ["settlement.approve", "payment.record"],
      ["br-bom"],
    );

    const refused = await approveSettlement(
      { settlementId: "set-1", reason: "Approving from Mumbai." },
      elsewhere,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/branch scope/i);
    expect(store.updates).toHaveLength(0);

    // The control: the same branch-scoped actor at either end of the lane.
    for (const branch of ["br-jai", "br-del"]) {
      store.updates = [];
      const allowed = await approveSettlement(
        { settlementId: "set-1", reason: "Approving from the lane." },
        user(`usr-${branch}`, ["settlement.approve"], [branch]),
      );
      expect(allowed.ok, branch).toBe(true);
    }
  });

  it("refuses a settlement that has already moved on, and does not re-approve it", async () => {
    for (const status of ["APPROVED", "PAID", "CANCELLED"]) {
      store.updates = [];
      settlement({ status });

      const result = await approveSettlement(
        { settlementId: "set-1", reason: "Second look." },
        SECOND(),
      );

      expect(result.ok, status).toBe(false);
      if (!result.ok) expect(result.error).toMatch(new RegExp(status, "i"));
      expect(store.updates, status).toHaveLength(0);
    }
  });

  it("refuses a settlement that no longer exists", async () => {
    store.settlement = null;

    const result = await approveSettlement(
      { settlementId: "gone", reason: "Approving." },
      SECOND(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no longer exists/i);
    expect(store.updates).toHaveLength(0);
  });

  it("refuses a branch-scoped approver on a settlement with no trip behind it", async () => {
    settlement({ tripId: null });

    const refused = await approveSettlement(
      { settlementId: "set-1", reason: "Approving." },
      user("usr-jai", ["settlement.approve"], ["br-jai"]),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/branch scope/i);
    expect(store.updates).toHaveLength(0);

    // Network scope has no branch to fail against, and may still act.
    const allowed = await approveSettlement(
      { settlementId: "set-1", reason: "Approving." },
      SECOND(),
    );
    expect(allowed.ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Payout and cancellation
// ────────────────────────────────────────────────────────────────────────

describe("markSettlementPaid", () => {
  it("pays out only what has been approved", async () => {
    for (const status of ["DRAFT", "CANCELLED", "PAID"]) {
      store.updates = [];
      settlement({ status });

      const result = await markSettlementPaid({ settlementId: "set-1" }, SECOND());

      expect(result.ok, status).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/approved/i);
      expect(store.updates, status).toHaveLength(0);
    }

    settlement({ status: "APPROVED" });
    const paid = await markSettlementPaid(
      { settlementId: "set-1", reference: "NEFT/8812" },
      SECOND(),
    );
    expect(paid.ok).toBe(true);
    expect(store.updates.at(0)).toMatchObject({ status: "PAID" });
    expect(store.audits.at(0)?.after).toMatchObject({
      status: "PAID",
      amount: "19000.00",
      reference: "NEFT/8812",
    });
  });

  it("is gated on payment.record, not on settlement.approve", async () => {
    settlement({ status: "APPROVED" });
    // The person who approves and the person who moves the money are two
    // jobs, and this gate is the only thing that says so.
    const approverOnly = user("usr-appr", ["settlement.approve"]);

    const refused = await markSettlementPaid({ settlementId: "set-1" }, approverOnly);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/permission/i);
    expect(store.updates).toHaveLength(0);

    const allowed = await markSettlementPaid(
      { settlementId: "set-1" },
      user("usr-cash", ["payment.record"]),
    );
    expect(allowed.ok).toBe(true);
  });

  it("refuses a payout outside the actor's branch scope", async () => {
    settlement({ status: "APPROVED" });

    const result = await markSettlementPaid(
      { settlementId: "set-1" },
      user("usr-bom", ["payment.record"], ["br-bom"]),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/branch scope/i);
    expect(store.updates).toHaveLength(0);
  });
});

describe("cancelSettlement", () => {
  it("cancels a draft and an approved settlement, with a reason", async () => {
    for (const status of ["DRAFT", "APPROVED"]) {
      store.updates = [];
      store.audits = [];
      settlement({ status });

      const result = await cancelSettlement(
        { settlementId: "set-1", reason: "Trip re-costed." },
        SECOND(),
      );

      expect(result.ok, status).toBe(true);
      expect(store.updates.at(0)).toMatchObject({ status: "CANCELLED" });
      expect(store.audits.at(0)).toMatchObject({
        action: "CANCEL",
        reason: "Trip re-costed.",
      });
      expect(store.audits.at(0)?.before).toMatchObject({ status });
    }
  });

  it("refuses to cancel money that has already gone out", async () => {
    settlement({ status: "PAID" });

    const result = await cancelSettlement(
      { settlementId: "set-1", reason: "Raised twice." },
      SECOND(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already been paid/i);
    expect(store.updates).toHaveLength(0);
  });

  it("insists on a reason and on settlement.approve, and writes nothing without either", async () => {
    const noReason = await cancelSettlement(
      { settlementId: "set-1", reason: "  " },
      SECOND(),
    );
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error).toMatch(/reason/i);

    const noPermission = await cancelSettlement(
      { settlementId: "set-1", reason: "Raised twice." },
      user("usr-clerk", ["settlement.prepare"]),
    );
    expect(noPermission.ok).toBe(false);
    if (!noPermission.ok) expect(noPermission.error).toMatch(/permission/i);

    expect(store.updates).toHaveLength(0);
  });

  it("lets the preparer cancel their own draft — the two-person rule guards approval, not withdrawal", async () => {
    const result = await cancelSettlement(
      { settlementId: "set-1", reason: "Raised against the wrong trip." },
      PREPARER(),
    );

    expect(result.ok).toBe(true);
    expect(store.updates.at(0)).toMatchObject({ status: "CANCELLED" });
  });
});
