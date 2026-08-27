import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A portal bulk upload cannot book for another account.
 *
 * Two halves to that claim, and they fail in different ways, so both are
 * tested:
 *
 *  · the file cannot *name* an account — `consignorForSession` is handed
 *    the row and does not read it; and
 *  · a login cannot reach a *batch* belonging to somebody else — every
 *    write proves ownership with the account id in the WHERE clause before
 *    the shared committer is called at all.
 */

type BatchRow = { id: string; customerId: string | null };
type ShipmentRow = { id: string; consignorId: string | null; bookedByCustomerUserId: string | null };

const store = vi.hoisted(() => ({
  batches: [] as BatchRow[],
  shipments: [] as ShipmentRow[],
  updateManyCalls: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
}));

const committer = vi.hoisted(() => ({ commitBatch: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bulkUploadBatch: {
      count: async ({ where }: { where: { id?: string; customerId?: string } }) =>
        store.batches.filter(
          (batch) =>
            (where.id === undefined || batch.id === where.id) &&
            (where.customerId === undefined || batch.customerId === where.customerId),
        ).length,
    },
    shipment: {
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        store.updateManyCalls.push(args);

        const ids = (args.where.id as { in: string[] } | undefined)?.in ?? [];
        // `consignorId: null` in the WHERE is honoured for real — it is the
        // clause that stops a stamp moving a counter booking onto a portal
        // account, so a mock that ignored it would not be testing anything.
        const wantsBlank =
          Object.prototype.hasOwnProperty.call(args.where, "consignorId") &&
          args.where.consignorId === null;

        let count = 0;
        for (const shipment of store.shipments) {
          if (!ids.includes(shipment.id)) continue;
          if (wantsBlank && shipment.consignorId !== null) continue;
          shipment.consignorId = args.data.consignorId as string;
          shipment.bookedByCustomerUserId = args.data
            .bookedByCustomerUserId as string;
          count++;
        }
        return { count };
      },
    },
  },
}));

vi.mock("@/lib/bulk/commit", () => ({ commitBatch: committer.commitBatch }));

const staging = vi.hoisted(() => ({
  updateBatchRow: vi.fn(),
  revalidateBatch: vi.fn(),
}));

vi.mock("@/lib/bulk/batch", () => ({
  createBulkBatch: vi.fn(),
  revalidateBatch: staging.revalidateBatch,
  updateBatchRow: staging.updateBatchRow,
  readRowNotes: () => ({ errors: {}, warnings: {} }),
}));

vi.mock("./service-actor", () => ({
  bookingActorFor: async () => ({ id: "svc_portal", orgId: "org_1" }),
  resolveBookingBranches: vi.fn(),
}));

import type { CustomerSession } from "@/lib/auth/customer-session";
import {
  commitPortalBatch,
  consignorForSession,
  ignoredAccountColumns,
  patchPortalBatchRow,
  portalBatchScope,
  ROUTED_FIELDS,
} from "./bulk";

const ACME: CustomerSession = {
  id: "cu_arun",
  name: "Arun Mehta",
  email: "arun@acme.test",
  role: "OWNER",
  mustChangePassword: false,
  customerId: "cust_acme",
  customerCode: "ACME",
  customerName: "Acme Industries",
  orgId: "org_1",
  visibleBranchIds: [],
};

const RIVAL: CustomerSession = {
  ...ACME,
  id: "cu_priya",
  customerId: "cust_rival",
  customerCode: "RIVAL",
  customerName: "Rival Freight",
};

beforeEach(() => {
  store.batches.length = 0;
  store.shipments.length = 0;
  store.updateManyCalls.length = 0;
  committer.commitBatch.mockReset();
  staging.updateBatchRow.mockReset();
  staging.revalidateBatch.mockReset();
});

// ────────────────────────────────────────────────────────────
// The file cannot name an account
// ────────────────────────────────────────────────────────────

describe("consignorForSession", () => {
  it("takes the account from the session and not from the row", () => {
    // A file doing its very best to book on somebody else's account.
    const hostile = {
      consignorId: "cust_rival",
      customerId: "cust_rival",
      customerCode: "RIVAL",
      consignorName: "Rival Freight",
      billToParty: "cust_rival",
    };

    expect(consignorForSession(ACME, hostile)).toEqual({
      consignorId: "cust_acme",
      bookedByCustomerUserId: "cu_arun",
    });
  });

  it("gives the same answer with no row at all", () => {
    expect(consignorForSession(ACME)).toEqual(consignorForSession(ACME, {}));
  });

  it("refuses to book unattributed when the session has no account", () => {
    expect(() => consignorForSession({ ...ACME, customerId: "" })).toThrow();
    expect(() => consignorForSession({ ...ACME, customerId: "   " })).toThrow();
  });
});

describe("ignoredAccountColumns", () => {
  it("names the account columns the parser discarded", () => {
    expect(
      ignoredAccountColumns([
        "Customer Code",
        "Bill-To Party",
        "consignor_id",
        "Handling Notes",
      ]),
    ).toEqual(["Customer Code", "Bill-To Party", "consignor_id"]);
  });

  it("does not claim to have ignored a column that is not about the account", () => {
    expect(ignoredAccountColumns(["Consignor Name", "Consignor PIN"])).toEqual([]);
    expect(ignoredAccountColumns([])).toEqual([]);
  });
});

describe("portalBatchScope", () => {
  it("pins reads to the signed-in account", () => {
    expect(portalBatchScope(ACME)).toEqual({ customerId: "cust_acme" });
  });

  it("throws rather than build an unscoped filter", () => {
    expect(() => portalBatchScope({ ...ACME, customerId: "" })).toThrow();
  });
});

// ────────────────────────────────────────────────────────────
// A login cannot reach another account's batch
// ────────────────────────────────────────────────────────────

describe("commitPortalBatch", () => {
  beforeEach(() => {
    store.batches.push({ id: "batch_acme", customerId: "cust_acme" });
    store.shipments.push(
      { id: "shp_1", consignorId: null, bookedByCustomerUserId: null },
      { id: "shp_2", consignorId: null, bookedByCustomerUserId: null },
    );

    committer.commitBatch.mockResolvedValue({
      ok: true,
      batchId: "batch_acme",
      attempted: 2,
      committed: 2,
      alreadyBooked: 0,
      failed: 0,
      stillInvalid: 0,
      outcomes: [
        { rowNumber: 1, status: "committed", shipmentId: "shp_1", lrNumber: "CL0001" },
        { rowNumber: 2, status: "committed", shipmentId: "shp_2", lrNumber: "CL0002" },
      ],
    });
  });

  it("refuses a batch belonging to another account, without touching the committer", async () => {
    const result = await commitPortalBatch(RIVAL, { batchId: "batch_acme" });

    expect(result.ok).toBe(false);
    expect(committer.commitBatch).not.toHaveBeenCalled();
    expect(store.shipments.every((s) => s.consignorId === null)).toBe(true);
  });

  it("refuses a batch that does not exist", async () => {
    const result = await commitPortalBatch(ACME, { batchId: "batch_nowhere" });

    expect(result.ok).toBe(false);
    expect(committer.commitBatch).not.toHaveBeenCalled();
  });

  it("welds the signed-in account onto everything it booked", async () => {
    const result = await commitPortalBatch(ACME, { batchId: "batch_acme" });

    expect(result.ok).toBe(true);
    expect(result.ok && result.stamped).toBe(2);

    for (const shipment of store.shipments) {
      expect(shipment.consignorId).toBe("cust_acme");
      expect(shipment.bookedByCustomerUserId).toBe("cu_arun");
    }
  });

  it("can only fill a blank consignor, never move one account's consignment to another", async () => {
    // A counter booking that happens to be named in the outcomes. The
    // `consignorId: null` clause is the only thing standing between a
    // stamping bug and one customer acquiring another's consignment.
    store.shipments.push({
      id: "shp_counter",
      consignorId: "cust_rival",
      bookedByCustomerUserId: null,
    });
    committer.commitBatch.mockResolvedValue({
      ok: true,
      batchId: "batch_acme",
      attempted: 1,
      committed: 1,
      alreadyBooked: 0,
      failed: 0,
      stillInvalid: 0,
      outcomes: [
        { rowNumber: 1, status: "committed", shipmentId: "shp_counter", lrNumber: "CL9999" },
      ],
    });

    const result = await commitPortalBatch(ACME, { batchId: "batch_acme" });

    expect(result.ok && result.stamped).toBe(0);
    expect(store.shipments.find((s) => s.id === "shp_counter")!.consignorId).toBe(
      "cust_rival",
    );
    expect(store.updateManyCalls[0].where).toMatchObject({ consignorId: null });
  });

  it("never writes currentStatus", async () => {
    await commitPortalBatch(ACME, { batchId: "batch_acme" });

    for (const call of store.updateManyCalls) {
      expect(Object.keys(call.data)).not.toContain("currentStatus");
    }
  });

  it("passes the commit straight through, so partial commit and idempotency are the shared ones", async () => {
    await commitPortalBatch(ACME, { batchId: "batch_acme", rowNumbers: [1] });

    expect(committer.commitBatch).toHaveBeenCalledWith(
      { batchId: "batch_acme", rowNumbers: [1] },
      expect.objectContaining({ id: "svc_portal" }),
    );
  });
});

// ────────────────────────────────────────────────────────────
// Routing stays the network's decision
// ────────────────────────────────────────────────────────────

describe("patchPortalBatchRow", () => {
  beforeEach(() => {
    store.batches.push({ id: "batch_acme", customerId: "cust_acme" });
    staging.updateBatchRow.mockResolvedValue({ ok: true });
    staging.revalidateBatch.mockResolvedValue({
      ok: true,
      summary: { rows: [{ rowNumber: 1, errors: {}, warnings: {} }], validCount: 1, invalidCount: 0 },
    });
  });

  it("refuses a correction to another account's batch", async () => {
    const result = await patchPortalBatchRow(RIVAL, {
      batchId: "batch_acme",
      rowNumber: 1,
      patch: { consigneeName: "Anyone" },
    });

    expect(result.ok).toBe(false);
    expect(staging.updateBatchRow).not.toHaveBeenCalled();
  });

  it("drops the routing columns, so a posted form cannot choose a branch", async () => {
    const result = await patchPortalBatchRow(ACME, {
      batchId: "batch_acme",
      rowNumber: 1,
      patch: {
        consigneeName: "Sharma Stores",
        originBranchCode: "DEL",
        destinationBranchCode: "JAI",
      },
    });

    expect(result.ok).toBe(true);
    expect(staging.updateBatchRow).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { consigneeName: "Sharma Stores" } }),
      expect.anything(),
    );
  });

  it("refuses a patch that was nothing but routing", async () => {
    const result = await patchPortalBatchRow(ACME, {
      batchId: "batch_acme",
      rowNumber: 1,
      patch: { originBranchCode: "DEL" },
    });

    expect(result.ok).toBe(false);
    expect(staging.updateBatchRow).not.toHaveBeenCalled();
  });

  it("ignores a column the schema does not declare", async () => {
    const result = await patchPortalBatchRow(ACME, {
      batchId: "batch_acme",
      rowNumber: 1,
      patch: { consigneeName: "Sharma Stores", consignorId: "cust_rival" },
    });

    expect(result.ok).toBe(true);
    expect(staging.updateBatchRow).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { consigneeName: "Sharma Stores" } }),
      expect.anything(),
    );
  });

  it("names both routing columns and nothing else", () => {
    expect([...ROUTED_FIELDS].sort()).toEqual([
      "destinationBranchCode",
      "originBranchCode",
    ]);
  });
});
