import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Where a vendor's money is sent.
 *
 * `saveBankAccountAction` was gated on `vendor.update`, which the transport
 * desk holds so it can keep lorry papers and rate contracts current. That
 * made adding a primary payout account — the instruction every future
 * payment run follows — a fleet-clerk action, and the audit row masked the
 * number, so afterwards the trail could not say which account had been
 * paid.
 */

const store = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  /** `vendorBankAccount.create` payloads, in order. */
  created: [] as Array<Record<string, unknown>>,
  /** `vendorBankAccount.updateMany` payloads — the primary demotion. */
  demotions: [] as Array<Record<string, unknown>>,
  /** `vendorBankAccount.update` payloads — a correction to an existing row. */
  updated: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  vendors: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/billing/vendor", () => ({
  createVendorBill: async () => ({ ok: false, error: "unused" }),
  approveVendorBill: async () => ({ ok: false, error: "unused" }),
  disputeVendorBill: async () => ({ ok: false, error: "unused" }),
  recordVendorPayment: async () => ({ ok: false, error: "unused" }),
}));

vi.mock("@/server/services/audit", () => ({
  recordAudit: async (input: Record<string, unknown>) => {
    store.audits.push(input);
  },
  changedFields: () => ({ before: {}, after: {} }),
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    vendorBankAccount: {
      findFirst: async ({
        where,
      }: {
        where: { vendorId: string; isPrimary: boolean };
      }) =>
        store.accounts.find(
          (row) => row.vendorId === where.vendorId && row.isPrimary === where.isPrimary,
        ) ?? null,
      updateMany: async (args: Record<string, unknown>) => {
        store.demotions.push(args);
        return { count: store.accounts.length };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        store.created.push(data);
        return { id: "bank-new", accountNumber: data.accountNumber };
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.accounts.find((row) => row.id === where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        store.updated.push({ id: where.id, ...data });
        return { id: where.id, accountNumber: data.accountNumber };
      },
    },
    vendor: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.vendors.find((row) => row.id === where.id) ?? null,
      create: async () => ({}),
      update: async () => ({}),
    },
  };

  return {
    prisma: client,
    tenantTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
  };
});

let actor: SessionUser;

vi.mock("@/lib/auth/session", () => {
  class PermissionError extends Error {
    constructor(public permission: string) {
      super(`Missing permission: ${permission}`);
      this.name = "PermissionError";
    }
  }
  return {
    PermissionError,
    authorize: async (permission: string) => {
      if (!actor.permissions.has(permission)) throw new PermissionError(permission);
      return actor;
    },
    can: (user: SessionUser, permission: string) => user.permissions.has(permission),
  };
});

function staff(permissions: string[]): SessionUser {
  return {
    id: "u-staff",
    orgId: "org-1",
    name: "Staff",
    mobile: "9810000000",
    email: null,
    isFieldUser: false,
    mustChangePassword: false,
    primaryBranch: null,
    roles: [],
    permissions: new Set(permissions),
    scope: "NETWORK",
    branchIds: null,
  };
}

/** What TRANSPORT_DESK holds of the two permissions in play. */
const FLEET_CLERK = [
  "vendor.read",
  "vendor.update",
  "vehicle.update",
  "expense.record",
];

/** What ACCOUNTS holds. */
const ACCOUNTS = ["vendor.read", "settlement.approve", "payment.record"];

function bankForm(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  const base: Record<string, string> = {
    vendorId: "v-1",
    accountName: "Sharma Roadlines",
    accountNumber: "50100234567890",
    ifsc: "HDFC0001234",
    bankName: "HDFC Bank",
    isPrimary: "true",
    ...fields,
  };
  for (const [key, value] of Object.entries(base)) data.set(key, value);
  return data;
}

beforeEach(() => {
  store.accounts.length = 0;
  store.created.length = 0;
  store.demotions.length = 0;
  store.updated.length = 0;
  store.audits.length = 0;
  store.vendors.length = 0;

  store.vendors.push({ id: "v-1", code: "SHARMA", deletedAt: null });
  store.vendors.push({ id: "v-2", code: "OTHER", deletedAt: null });

  store.accounts.push({
    id: "bank-old",
    vendorId: "v-1",
    accountName: "Sharma Roadlines",
    accountNumber: "911020001111",
    isPrimary: true,
  });
});

describe("saveBankAccountAction", () => {
  it("refuses a fleet clerk holding vendor.update", async () => {
    const { saveBankAccountAction } = await import("./actions");
    actor = staff(FLEET_CLERK);

    const result = await saveBankAccountAction({}, bankForm());

    expect(result.error).toContain("permission");
    expect(store.created).toHaveLength(0);
    // The demotion is half the attack on its own: run it and the real
    // account stops being primary.
    expect(store.demotions).toHaveLength(0);
  });

  it("lets the desk that approves payouts set the account", async () => {
    const { saveBankAccountAction } = await import("./actions");
    actor = staff(ACCOUNTS);

    const result = await saveBankAccountAction({}, bankForm());

    expect(result.ok).toBe(true);
    expect(store.created).toHaveLength(1);
    expect(store.demotions).toHaveLength(1);
  });

  it("writes an audit row that names the account money will go to", async () => {
    const { saveBankAccountAction } = await import("./actions");
    actor = staff(ACCOUNTS);

    await saveBankAccountAction({}, bankForm());

    expect(store.audits).toHaveLength(1);
    const audit = store.audits[0] as {
      entityRef: string;
      before?: { previousPrimary?: { accountNumber?: string } };
      after: { accountNumber?: string; ifsc?: string };
    };

    // The masked tail stays as the searchable reference, but an
    // investigation into a redirected payout has to be able to read the
    // destination itself — and what it displaced.
    expect(audit.entityRef).toBe("••••7890");
    expect(audit.after.accountNumber).toBe("50100234567890");
    expect(audit.after.ifsc).toBe("HDFC0001234");
    expect(audit.before?.previousPrimary?.accountNumber).toBe("911020001111");
  });

  /**
   * The vendor id travels in a hidden input and used to be written
   * straight onto the row. Within one organisation that is enough to
   * land a payee instruction on somebody else's transporter, and every
   * future payout to them would follow it.
   */
  it("refuses a vendor id that does not resolve", async () => {
    const { saveBankAccountAction } = await import("./actions");
    actor = staff(ACCOUNTS);

    const result = await saveBankAccountAction(
      {},
      bankForm({ vendorId: "v-does-not-exist" }),
    );

    expect(result.error).toContain("no longer exists");
    expect(store.created).toHaveLength(0);
    expect(store.demotions).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  /**
   * A typed-wrong IFSC could only ever be answered by adding a second
   * primary account, because this action only ever `create`d.
   */
  it("corrects an existing account rather than adding another", async () => {
    const { saveBankAccountAction } = await import("./actions");
    actor = staff(ACCOUNTS);

    const result = await saveBankAccountAction(
      {},
      bankForm({ id: "bank-old", ifsc: "HDFC0009999" }),
    );

    expect(result.ok).toBe(true);
    expect(store.created).toHaveLength(0);
    expect(store.updated).toHaveLength(1);
    expect(store.updated[0].id).toBe("bank-old");
    expect(store.updated[0].ifsc).toBe("HDFC0009999");
  });

  it("refuses to correct an account belonging to another vendor", async () => {
    const { saveBankAccountAction } = await import("./actions");
    actor = staff(ACCOUNTS);

    const result = await saveBankAccountAction(
      {},
      bankForm({ id: "bank-old", vendorId: "v-2" }),
    );

    expect(result.error).toContain("not on this vendor");
    expect(store.created).toHaveLength(0);
    expect(store.updated).toHaveLength(0);
    expect(store.demotions).toHaveLength(0);
  });
});
