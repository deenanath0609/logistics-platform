import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Applying money that is sitting on account.
 *
 * `allocateOnAccount` checked one thing — that the total fitted inside what
 * was left unallocated on the receipt — and then wrote an allocation row
 * for whatever invoice id it was handed. Customer A's money settled
 * customer B's invoice; a ₹500 invoice could be "settled" with ₹40,000; a
 * branch clerk could reach an invoice no screen would ever show them.
 *
 * `recordPayment` had the customer and amount checks all along, which is
 * the point: the same guard is now shared, so the two cannot drift again.
 * Both are exercised here against a store that records every write.
 */

type InvoiceRow = {
  id: string;
  number: string;
  customerId: string;
  branchId: string;
  status: string;
  dueDate: Date;
  amountDue: string;
};

type PaymentRow = {
  id: string;
  number: string;
  customerId: string;
  branchId: string | null;
  unallocated: string;
};

const store = vi.hoisted(() => ({
  invoices: [] as Array<Record<string, unknown>>,
  payments: [] as Array<Record<string, unknown>>,
  /** Allocation rows written, in order. */
  allocations: [] as Array<Record<string, unknown>>,
  /** `payment.update` payloads, in order. */
  paymentUpdates: [] as Array<Record<string, unknown>>,
  /** Invoice ids handed to `recomputeInvoiceBalance`. */
  recomputed: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
}));

function invoices(): InvoiceRow[] {
  return store.invoices as unknown as InvoiceRow[];
}

vi.mock("@/server/services/audit", () => ({
  recordAudit: async (input: Record<string, unknown>) => {
    store.audits.push(input);
  },
}));

vi.mock("@/lib/numbering/number-series", () => ({
  nextNumber: async () => "RCT-DEL-0001",
}));

vi.mock("./invoice", () => ({
  recomputeInvoiceBalance: async (invoiceId: string) => {
    store.recomputed.push(invoiceId);
  },
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    invoice: {
      findMany: async ({
        where,
      }: {
        where: { customerId: string; status: { in: string[] } };
      }) =>
        invoices().filter(
          (invoice) =>
            invoice.customerId === where.customerId &&
            where.status.in.includes(invoice.status) &&
            Number(invoice.amountDue) > 0,
        ),
    },

    payment: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        (store.payments as unknown as PaymentRow[]).find((p) => p.id === where.id) ??
        null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: "pay-new",
        number: data.number,
      }),
      update: async (args: Record<string, unknown>) => {
        store.paymentUpdates.push(args);
        return {};
      },
    },

    paymentAllocation: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        store.allocations.push(data);
        return data;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        store.allocations.push(data);
        return data;
      },
    },
  };

  return {
    prisma: client,
    tenantTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
  };
});

vi.mock("@/lib/auth/session", () => ({
  can: (user: SessionUser, permission: string) => user.permissions.has(permission),
}));

function clerk(branchIds: string[] | null): SessionUser {
  return {
    id: "u-clerk",
    orgId: "org-1",
    name: "Accounts Clerk",
    mobile: "9810000000",
    email: null,
    isFieldUser: false,
    mustChangePassword: false,
    primaryBranch: { id: "br-del", code: "DEL", name: "Delhi" },
    roles: [],
    permissions: new Set(["payment.record"]),
    scope: branchIds === null ? "NETWORK" : "BRANCH",
    branchIds,
  };
}

const DUE = new Date("2026-08-01");

beforeEach(() => {
  store.invoices.length = 0;
  store.payments.length = 0;
  store.allocations.length = 0;
  store.paymentUpdates.length = 0;
  store.recomputed.length = 0;
  store.audits.length = 0;

  store.invoices.push({
    id: "inv-a",
    number: "INV-DEL-0001",
    customerId: "cust-a",
    branchId: "br-del",
    status: "ISSUED",
    dueDate: DUE,
    amountDue: "1000.00",
  });

  store.invoices.push({
    id: "inv-b",
    number: "INV-JAI-0009",
    customerId: "cust-b",
    branchId: "br-jai",
    status: "ISSUED",
    dueDate: DUE,
    amountDue: "9000.00",
  });

  store.invoices.push({
    id: "inv-a-jaipur",
    number: "INV-JAI-0021",
    customerId: "cust-a",
    branchId: "br-jai",
    status: "ISSUED",
    dueDate: DUE,
    amountDue: "4000.00",
  });

  // Customer A paid ₹5,000 that has not been applied to anything yet.
  store.payments.push({
    id: "pay-a",
    number: "RCT-DEL-0007",
    customerId: "cust-a",
    branchId: "br-del",
    unallocated: "5000.00",
  });
});

describe("allocateOnAccount", () => {
  it("refuses to settle another customer's invoice with this customer's money", async () => {
    const { allocateOnAccount } = await import("./receivables");

    const result = await allocateOnAccount(
      { paymentId: "pay-a", allocations: [{ invoiceId: "inv-b", amount: 5000 }] },
      clerk(null),
    );

    expect(result.ok).toBe(false);
    // Nothing is written and nothing is recomputed: customer B's invoice
    // still shows the full amount open, which is the truth.
    expect(store.allocations).toHaveLength(0);
    expect(store.paymentUpdates).toHaveLength(0);
    expect(store.recomputed).toHaveLength(0);
  });

  it("refuses to apply more than the invoice still owes", async () => {
    const { allocateOnAccount } = await import("./receivables");

    const result = await allocateOnAccount(
      { paymentId: "pay-a", allocations: [{ invoiceId: "inv-a", amount: 5000 }] },
      clerk(null),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("INV-DEL-0001");
    expect(store.allocations).toHaveLength(0);
  });

  it("refuses an invoice outside the clerk's branch scope", async () => {
    const { allocateOnAccount } = await import("./receivables");

    // Same customer, same tenant, but a Delhi clerk is never shown the
    // Jaipur invoice — `customerLedger` is branch-scoped, so naming it here
    // means the id was typed or replayed.
    const result = await allocateOnAccount(
      { paymentId: "pay-a", allocations: [{ invoiceId: "inv-a-jaipur", amount: 1000 }] },
      clerk(["br-del"]),
    );

    expect(result.ok).toBe(false);
    expect(store.allocations).toHaveLength(0);
  });

  it("applies money to the payer's own invoice", async () => {
    const { allocateOnAccount } = await import("./receivables");

    const result = await allocateOnAccount(
      { paymentId: "pay-a", allocations: [{ invoiceId: "inv-a", amount: 600 }] },
      clerk(["br-del"]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unallocated.toFixed(2)).toBe("4400.00");
    expect(store.allocations).toHaveLength(1);
    expect(store.allocations[0].invoiceId).toBe("inv-a");
    expect(store.recomputed).toEqual(["inv-a"]);
  });
});

describe("recordPayment", () => {
  it("keeps refusing an invoice that belongs to somebody else", async () => {
    const { recordPayment } = await import("./receivables");

    const result = await recordPayment(
      {
        customerId: "cust-a",
        amount: 500,
        mode: "NEFT",
        receivedOn: new Date("2026-08-20"),
        allocations: [{ invoiceId: "inv-b", amount: 500 }],
      },
      clerk(null),
    );

    expect(result.ok).toBe(false);
    expect(store.allocations).toHaveLength(0);
  });

  it("settles the oldest invoices across branches when none is named", async () => {
    const { recordPayment } = await import("./receivables");

    // Oldest-first stays account-level on purpose: a receipt banked at
    // Delhi clears what the customer owes, wherever it was raised.
    const result = await recordPayment(
      {
        customerId: "cust-a",
        amount: 5000,
        mode: "NEFT",
        receivedOn: new Date("2026-08-20"),
      },
      clerk(["br-del"]),
    );

    expect(result.ok).toBe(true);
    expect(store.allocations.map((a) => a.invoiceId).sort()).toEqual([
      "inv-a",
      "inv-a-jaipur",
    ]);
  });
});
