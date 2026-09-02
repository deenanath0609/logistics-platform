import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The other half of the reweigh.
 *
 * Repricing a consignment that has already been invoiced changes nothing
 * the customer can be asked to pay — an issued invoice cannot be edited,
 * so the extra has to leave the building on a document of its own. These
 * tests hold the three decisions that make or lose that money: not yet
 * invoiced (nothing to do), still a draft (regenerate, do not correct),
 * and issued (raise the note).
 *
 * The store records what was written, and the number comes from the same
 * advisory-locked series as everything else — asserted here because the
 * counting stopgap this replaced would happily hand two clerks the same
 * one.
 */

const store = vi.hoisted(() => ({
  /** The live invoice a shipment sits on, or null for "not invoiced". */
  invoiceStatus: null as string | null,
  invoiceNumber: "INV/2627/JAI/0007",
  isReverseCharge: false,
  permitted: true,
  /** Whether a named `shipmentId` resolves at all. */
  shipmentExists: true,
  /** The account that consignment is billed to — the invoice's, by default. */
  shipmentConsignor: "cust-acme",
  created: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  numbersIssued: [] as string[],
}));

vi.mock("@/lib/auth/session", () => ({
  can: () => store.permitted,
}));

vi.mock("@/server/services/audit", () => ({
  recordAudit: async (input: Record<string, unknown>) => {
    store.audits.push(input);
  },
}));

vi.mock("@/lib/numbering/number-series", () => ({
  nextNumber: async () => {
    const number = `DN/2627/${String(store.numbersIssued.length + 1).padStart(6, "0")}`;
    store.numbersIssued.push(number);
    return number;
  },
}));

vi.mock("@/lib/prisma", () => {
  const invoiceRow = () => ({
    id: "inv-1",
    orgId: "org-1",
    number: store.invoiceNumber,
    status: store.invoiceStatus ?? "ISSUED",
    branchId: "br-jai",
    customerId: "cust-acme",
    isReverseCharge: store.isReverseCharge,
    placeOfSupply: "Rajasthan",
    customerGstin: "08AAACR5055K1Z7",
    invoiceDate: new Date("2026-08-01"),
    customer: { creditDays: 30, gstin: "08AAACR5055K1Z7" },
    branch: { code: "JAI" },
  });

  const client = {
    invoiceLine: {
      findFirst: async () =>
        store.invoiceStatus === null
          ? null
          : { hsnSac: "996791", invoice: invoiceRow() },
    },
    /*
      The consignment a named `shipmentId` resolves to.

      `createDebitNote` now verifies it before writing it to the line, so
      the mock has to answer — `store.shipmentConsignor` is what decides
      whether it belongs to the account the invoice bills, and
      `store.shipmentExists` covers an id that resolves to nothing at all.
    */
    shipment: {
      findFirst: async () =>
        store.shipmentExists
          ? {
              id: "shp-1",
              lrNumber: "CL202608010001",
              consignorId: store.shipmentConsignor,
            }
          : null,
    },
    invoice: {
      findUnique: async () => (store.invoiceStatus === null ? null : invoiceRow()),
      create: async (args: { data: Record<string, unknown> }) => {
        store.created.push(args.data);
        return { id: `dn-${store.created.length}`, number: args.data.number };
      },
    },
  };

  return {
    prisma: client,
    // The real one resolves the tenant and sets it on the session before
    // running the callback; here the callback is all there is to run.
    tenantTransaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> =>
      callback(client),
  };
});

const { createDebitNote, raiseReweighDebitNote, isDebitNoteNumber } =
  await import("./debit-note");

/** Network scope — `coversBranch` lets a null `branchIds` through. */
const ACTOR = {
  id: "user-1",
  orgId: "org-1",
  branchIds: null,
} as unknown as Parameters<typeof createDebitNote>[1];

/** Scoped to a branch that is not the invoice's `br-jai`. */
const OTHER_BRANCH_ACTOR = {
  id: "user-2",
  orgId: "org-1",
  branchIds: ["br-del"],
} as unknown as Parameters<typeof createDebitNote>[1];

beforeEach(() => {
  store.invoiceStatus = "ISSUED";
  store.invoiceNumber = "INV/2627/JAI/0007";
  store.isReverseCharge = false;
  store.permitted = true;
  store.shipmentExists = true;
  store.shipmentConsignor = "cust-acme";
  store.created.length = 0;
  store.audits.length = 0;
  store.numbersIssued.length = 0;
});

describe("raiseReweighDebitNote", () => {
  it("bills the delta when the consignment is already invoiced", async () => {
    const outcome = await raiseReweighDebitNote(
      {
        shipmentId: "shp-1",
        delta: "400.00",
        taxDelta: "72.00",
        taxPercent: "18",
        previousChargeableWeight: "100",
        revisedChargeableWeight: "140",
      },
      ACTOR,
    );

    expect(outcome.raised).toBe(true);
    if (!outcome.raised) return;

    // 400 + 72 = 472, rounded to the rupee.
    expect(outcome.total.toFixed(2)).toBe("472.00");
    expect(isDebitNoteNumber(outcome.number)).toBe(true);

    const written = store.created[0];
    expect(written.status).toBe("DRAFT");
    expect(written.amountDue).toBe("472.00");
    // It names the document it corrects, and the weights that moved.
    expect(String(written.notes)).toContain("INV/2627/JAI/0007");
    expect(String(written.notes)).toContain("140.000 kg");
  });

  it("raises nothing when the consignment has not been invoiced", async () => {
    store.invoiceStatus = null;

    const outcome = await raiseReweighDebitNote(
      { shipmentId: "shp-1", delta: "400.00" },
      ACTOR,
    );

    expect(outcome.raised).toBe(false);
    expect(store.created).toHaveLength(0);
    if (outcome.raised) return;
    expect(outcome.reason).toContain("not on a live invoice");
  });

  it("sends a draft back to be regenerated rather than correcting it", async () => {
    store.invoiceStatus = "DRAFT";

    const outcome = await raiseReweighDebitNote(
      { shipmentId: "shp-1", delta: "400.00" },
      ACTOR,
    );

    expect(outcome.raised).toBe(false);
    expect(store.created).toHaveLength(0);
    if (outcome.raised) return;
    expect(outcome.reason).toContain("still a draft");
  });

  it("raises nothing when the reweigh went the other way", async () => {
    const outcome = await raiseReweighDebitNote(
      { shipmentId: "shp-1", delta: "-120.00" },
      ACTOR,
    );

    expect(outcome.raised).toBe(false);
    expect(store.created).toHaveLength(0);
  });
});

describe("createDebitNote", () => {
  it("states the tax and keeps it out of the total under reverse charge", async () => {
    store.isReverseCharge = true;

    const result = await createDebitNote(
      {
        againstInvoiceId: "inv-1",
        amount: "400.00",
        taxAmount: "72.00",
        taxPercent: "18",
        reason: "Reweighed at the hub.",
      },
      ACTOR,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The recipient owes ₹72; we are not collecting it.
    expect(result.taxAmount.toFixed(2)).toBe("72.00");
    expect(result.total.toFixed(2)).toBe("400.00");
    expect(store.created[0].taxAmount).toBe("0.00");
    expect(store.created[0].isReverseCharge).toBe(true);
  });

  it("refuses a note for nothing, and points at the credit note instead", async () => {
    const result = await createDebitNote(
      { againstInvoiceId: "inv-1", amount: "0", reason: "Reweighed." },
      ACTOR,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("credit note");
  });

  it("refuses without a reason — the customer will ask", async () => {
    const result = await createDebitNote(
      { againstInvoiceId: "inv-1", amount: "400", reason: "  " },
      ACTOR,
    );

    expect(result.ok).toBe(false);
    expect(store.created).toHaveLength(0);
  });

  it("refuses to debit a cancelled invoice", async () => {
    store.invoiceStatus = "CANCELLED";

    const result = await createDebitNote(
      { againstInvoiceId: "inv-1", amount: "400", reason: "Reweighed." },
      ACTOR,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("cancelled");
  });

  it("refuses without the permission to bill", async () => {
    store.permitted = false;

    const result = await createDebitNote(
      { againstInvoiceId: "inv-1", amount: "400", reason: "Reweighed." },
      ACTOR,
    );

    expect(result.ok).toBe(false);
    expect(store.created).toHaveLength(0);
  });

  /**
   * The invoice id arrives on a form, and a debit note is raised from the
   * original's branch and numbered from its series. The detail screen
   * already refuses another branch's invoice; a server action does not go
   * through the screen, so the service has to ask as well — and the refusal
   * has to leave the series and the ledger untouched.
   */
  it("refuses an invoice belonging to another branch, and writes nothing", async () => {
    const result = await createDebitNote(
      { againstInvoiceId: "inv-1", amount: "400", reason: "Reweighed." },
      OTHER_BRANCH_ACTOR,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("another branch");
    expect(store.created).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
    // A burnt number is a gap in a debit-note sequence, which every GST
    // audit asks about.
    expect(store.numbersIssued).toHaveLength(0);
  });

  it("audits the note with the reason it was raised for", async () => {
    await createDebitNote(
      {
        againstInvoiceId: "inv-1",
        amount: "400",
        taxAmount: "72",
        reason: "Chargeable weight revised at the Jaipur hub.",
      },
      ACTOR,
    );

    expect(store.audits).toHaveLength(1);
    expect(store.audits[0].reason).toBe("Chargeable weight revised at the Jaipur hub.");
    expect((store.audits[0].after as Record<string, unknown>).kind).toBe("DEBIT_NOTE");
  });

  /**
   * The consignment on the line is checked, not taken on trust.
   *
   * `shipmentId` went onto the invoice line unverified. The dialog never
   * renders the field, but a server action does not pass the dialog and
   * `createDebitNoteAction` reads it straight off the form — so another
   * account's consignment could be attached to this customer's correction.
   * `liveInvoiceForShipment` then resolves that consignment to *this*
   * invoice, and the next re-weigh of it bills the wrong customer.
   *
   * Both refusals must write nothing at all, and must not burn a number.
   */
  it("refuses a consignment billed to a different account", async () => {
    store.shipmentConsignor = "cust-somebody-else";

    const result = await createDebitNote(
      {
        againstInvoiceId: "inv-1",
        shipmentId: "shp-1",
        amount: "400",
        reason: "Probe — another account's consignment.",
      },
      ACTOR,
    );

    expect(result.ok).toBe(false);
    expect(store.created).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
    expect(store.numbersIssued).toHaveLength(0);
  });

  it("refuses a consignment id that resolves to nothing", async () => {
    store.shipmentExists = false;

    const result = await createDebitNote(
      {
        againstInvoiceId: "inv-1",
        shipmentId: "shp-does-not-exist",
        amount: "400",
        reason: "Probe — invented consignment.",
      },
      ACTOR,
    );

    expect(result.ok).toBe(false);
    expect(store.created).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
    expect(store.numbersIssued).toHaveLength(0);
  });

  it("still accepts the consignment the invoice actually bills", async () => {
    const result = await createDebitNote(
      {
        againstInvoiceId: "inv-1",
        shipmentId: "shp-1",
        amount: "400",
        taxAmount: "72",
        reason: "Chargeable weight revised at the hub.",
      },
      ACTOR,
    );

    expect(result.ok).toBe(true);
    expect(store.created).toHaveLength(1);
  });
});
