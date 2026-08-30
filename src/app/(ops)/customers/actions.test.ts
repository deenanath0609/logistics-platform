import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Customer addresses, and who an address belongs to.
 *
 * `saveCustomerAddress` took both `id` and `customerId` from the form and
 * compared them to nothing: an address could be updated by id alone, and
 * its `customerId` rewritten in the same call. That moved one customer's
 * pickup address onto another account — as the default, which is what the
 * booking screen pre-fills — and the customer whose account was being
 * edited was never scope-checked at all, though `updateCustomer` twelve
 * lines above has always done exactly that.
 */

type AddressRow = { id: string; customerId: string; label: string };
type CustomerRow = { id: string; branchId: string | null };

const store = vi.hoisted(() => ({
  customers: [] as Array<Record<string, unknown>>,
  addresses: [] as Array<Record<string, unknown>>,
  /** `customerAddress.update` payloads, in order. */
  updates: [] as Array<Record<string, unknown>>,
  /** `customerAddress.create` payloads, in order. */
  creates: [] as Array<Record<string, unknown>>,
  /** `customerAddress.updateMany` payloads — the default-clearing sweep. */
  defaultSweeps: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/server/services/audit", () => ({
  recordAudit: async (input: Record<string, unknown>) => {
    store.audits.push(input);
  },
  changedFields: () => ({ before: {}, after: {} }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    customer: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        (store.customers as unknown as CustomerRow[]).find((c) => c.id === where.id) ??
        null,
    },
    customerAddress: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        (store.addresses as unknown as AddressRow[]).find((a) => a.id === where.id) ??
        null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        store.updates.push({ id: where.id, ...data });
        return { id: where.id, ...data };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        store.creates.push(data);
        return { id: "addr-new", ...data };
      },
      updateMany: async (args: Record<string, unknown>) => {
        store.defaultSweeps.push(args);
        return { count: 0 };
      },
    },
  },
}));

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

function addressForm(fields: Record<string, string>): FormData {
  const data = new FormData();
  const base: Record<string, string> = {
    customerId: "cust-a",
    label: "Okhla warehouse",
    kind: "PICKUP",
    contactName: "",
    phone: "",
    address: "Plot 14, Okhla Phase II",
    cityId: "city-del",
    pincode: "110020",
    landmark: "",
    isDefault: "true",
    ...fields,
  };
  for (const [key, value] of Object.entries(base)) data.set(key, value);
  return data;
}

function clerk(branchIds: string[] | null): SessionUser {
  return {
    id: "u-clerk",
    orgId: "org-1",
    name: "Support",
    mobile: "9810000000",
    email: null,
    isFieldUser: false,
    mustChangePassword: false,
    primaryBranch: { id: "br-del", code: "DEL", name: "Delhi" },
    roles: [],
    permissions: new Set(["customer.update"]),
    scope: branchIds === null ? "NETWORK" : "BRANCH",
    branchIds,
  };
}

beforeEach(() => {
  store.customers.length = 0;
  store.addresses.length = 0;
  store.updates.length = 0;
  store.creates.length = 0;
  store.defaultSweeps.length = 0;
  store.audits.length = 0;

  store.customers.push({ id: "cust-a", branchId: "br-del" });
  store.customers.push({ id: "cust-b", branchId: "br-del" });
  store.customers.push({ id: "cust-jaipur", branchId: "br-jai" });

  store.addresses.push({
    id: "addr-a1",
    customerId: "cust-a",
    label: "Okhla warehouse",
  });

  actor = clerk(null);
});

describe("saveCustomerAddress", () => {
  it("refuses to re-parent an address onto another customer", async () => {
    const { saveCustomerAddress } = await import("./actions");

    // Customer A's pickup address, posted with customer B's id and
    // `isDefault` — the booking screen would then pre-fill it for B.
    const result = await saveCustomerAddress(
      {},
      addressForm({ id: "addr-a1", customerId: "cust-b" }),
    );

    expect(result.error).toContain("different customer");
    expect(store.updates).toHaveLength(0);
    // The sweep matters as much as the write: it clears `isDefault` on the
    // target's other addresses, so running it alone would leave customer B
    // with no default at all.
    expect(store.defaultSweeps).toHaveLength(0);
  });

  it("refuses an address on a customer outside the actor's branch scope", async () => {
    const { saveCustomerAddress } = await import("./actions");
    actor = clerk(["br-del"]);

    const result = await saveCustomerAddress(
      {},
      addressForm({ customerId: "cust-jaipur" }),
    );

    expect(result.error).toContain("outside your scope");
    expect(store.creates).toHaveLength(0);
  });

  it("refuses an address whose customer no longer exists", async () => {
    const { saveCustomerAddress } = await import("./actions");

    const result = await saveCustomerAddress({}, addressForm({ customerId: "cust-gone" }));

    expect(result.error).toContain("no longer exists");
    expect(store.creates).toHaveLength(0);
  });

  it("saves an edit to the account the address already belongs to", async () => {
    const { saveCustomerAddress } = await import("./actions");

    const result = await saveCustomerAddress(
      {},
      addressForm({ id: "addr-a1", label: "Okhla warehouse (gate 2)" }),
    );

    expect(result.ok).toBe(true);
    expect(store.updates).toHaveLength(1);
    expect(store.defaultSweeps).toHaveLength(1);
  });

  it("adds a new address to a customer in scope", async () => {
    const { saveCustomerAddress } = await import("./actions");
    actor = clerk(["br-del"]);

    const result = await saveCustomerAddress({}, addressForm({}));

    expect(result.ok).toBe(true);
    expect(store.creates).toHaveLength(1);
  });
});
