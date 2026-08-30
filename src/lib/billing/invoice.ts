import Decimal from "decimal.js";
import { prisma, tenantTransaction, type Db, type DbOrTx } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { recordAudit } from "@/server/services/audit";
import { nextNumber } from "@/lib/numbering/number-series";
import { dec, money, type MoneyIn } from "./ageing";
import { GTA_SAC } from "./gst";
import { totalInvoice } from "./totals";

/**
 * Invoicing.
 *
 * Bill runs are per customer for a period, or per shipment on delivery,
 * depending on the contract. Every line traces back to the consignment it
 * came from and to the stored calculation trace, so "why is this ₹4,280?"
 * is answerable from the invoice rather than from a spreadsheet.
 */

export type InvoiceResult<T = { invoiceId: string; number: string }> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/** Payment types that reach the consignor's account rather than the door. */
const BILLABLE_PAYMENT_TYPES = ["PAID", "TBB"] as const;

/** Statuses that still consume a shipment — a cancelled invoice releases it. */
const LIVE_INVOICE_STATUSES = [
  "DRAFT",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "CREDITED",
] as const;

// ────────────────────────────────────────────────────────────
// Selecting what to bill
// ────────────────────────────────────────────────────────────

export type BillableShipment = {
  id: string;
  lrNumber: string;
  bookedAt: Date;
  deliveredAt: Date | null;
  consigneeName: string;
  destination: string;
  /** Origin branch — what a branch-wise bill run groups on. */
  branchId: string;
  branchCode: string;
  packageCount: number;
  chargeableWeight: Decimal;
  subtotal: Decimal;
  taxAmount: Decimal;
  total: Decimal;
  isReverseCharge: boolean;
  chargeCount: number;
};

/**
 * Consignments a customer can be billed for in a window.
 *
 * A shipment already on a live invoice is excluded — double-billing is the
 * single complaint that costs an account, and the guard belongs here
 * rather than in the operator's memory.
 */
export async function billableShipments(
  options: {
    customerId: string;
    from: Date;
    to: Date;
    branchId?: string | null;
    /** Only bill what has actually been delivered. */
    deliveredOnly?: boolean;
    shipmentIds?: string[];
    /** Restrict to these origin branches. Used by a branch-wise bill run. */
    branchIds?: string[];
  },
  user: SessionUser,
): Promise<BillableShipment[]> {
  const taken = await prisma.invoiceLine.findMany({
    where: {
      shipmentId: { not: null },
      invoice: { status: { in: [...LIVE_INVOICE_STATUSES] } },
    },
    select: { shipmentId: true },
  });

  const alreadyBilled = new Set(
    taken.map((line) => line.shipmentId).filter((id): id is string => Boolean(id)),
  );

  const shipments = await prisma.shipment.findMany({
    where: {
      consignorId: options.customerId,
      deletedAt: null,
      cancelledAt: null,
      paymentType: { in: [...BILLABLE_PAYMENT_TYPES] },
      ...(options.shipmentIds && options.shipmentIds.length > 0
        ? { id: { in: options.shipmentIds } }
        : {}),
      ...(options.deliveredOnly
        ? { deliveredAt: { gte: options.from, lte: options.to } }
        : { bookedAt: { gte: options.from, lte: options.to } }),
      ...(options.branchId ? { originBranchId: options.branchId } : {}),
      ...(options.branchIds && options.branchIds.length > 0
        ? { originBranchId: { in: options.branchIds } }
        : {}),
      // A branch-scoped biller cannot pull another branch's consignments
      // into their bill run.
      ...branchScope(user, "originBranchId"),
    },
    orderBy: { bookedAt: "asc" },
    select: {
      id: true,
      lrNumber: true,
      bookedAt: true,
      deliveredAt: true,
      consigneeName: true,
      packageCount: true,
      chargeableWeight: true,
      chargesTotal: true,
      taxAmount: true,
      grandTotal: true,
      isReverseCharge: true,
      originBranchId: true,
      originBranch: { select: { code: true } },
      destinationBranch: { select: { code: true } },
      _count: { select: { charges: true } },
    },
  });

  return shipments
    .filter((shipment) => !alreadyBilled.has(shipment.id))
    .map((shipment) => ({
      id: shipment.id,
      lrNumber: shipment.lrNumber,
      bookedAt: shipment.bookedAt,
      deliveredAt: shipment.deliveredAt,
      consigneeName: shipment.consigneeName,
      destination: shipment.destinationBranch.code,
      branchId: shipment.originBranchId,
      branchCode: shipment.originBranch.code,
      packageCount: shipment.packageCount,
      chargeableWeight: dec(shipment.chargeableWeight.toString()),
      subtotal: money(dec(shipment.chargesTotal.toString())),
      taxAmount: money(dec(shipment.taxAmount.toString())),
      total: money(dec(shipment.grandTotal.toString())),
      isReverseCharge: shipment.isReverseCharge,
      chargeCount: shipment._count.charges,
    }));
}

type LineDraft = {
  shipmentId: string | null;
  chargeTypeId: string | null;
  description: string;
  quantity: Decimal;
  rate: Decimal;
  amount: Decimal;
  taxPercent: Decimal | null;
  taxAmount: Decimal;
  hsnSac: string | null;
};

/** One line per charge head per consignment, so every figure has a source. */
async function draftLines(
  shipmentIds: string[],
  client: Pick<Db, "shipment">,
): Promise<{ lines: LineDraft[]; anyReverseCharge: boolean; allReverseCharge: boolean }> {
  const shipments = await client.shipment.findMany({
    where: { id: { in: shipmentIds } },
    orderBy: { bookedAt: "asc" },
    select: {
      id: true,
      lrNumber: true,
      bookedAt: true,
      chargeableWeight: true,
      grandTotal: true,
      chargesTotal: true,
      taxAmount: true,
      isReverseCharge: true,
      consigneeName: true,
      destinationBranch: { select: { code: true } },
      charges: {
        orderBy: { sortOrder: "asc" },
        select: {
          chargeTypeId: true,
          quantity: true,
          rate: true,
          amount: true,
          taxPercent: true,
          taxAmount: true,
          chargeType: {
            select: {
              code: true,
              name: true,
              isCustomerVisible: true,
              // The code the line is filed under. A tax invoice without one
              // is not a tax invoice.
              taxRate: { select: { hsnSac: true } },
            },
          },
        },
      },
    },
  });

  const lines: LineDraft[] = [];
  let anyReverseCharge = false;
  let allReverseCharge = shipments.length > 0;

  for (const shipment of shipments) {
    if (shipment.isReverseCharge) anyReverseCharge = true;
    else allReverseCharge = false;

    const label =
      `${shipment.lrNumber} · ${shipment.destinationBranch.code} · ` +
      `${shipment.consigneeName} · ${dec(shipment.chargeableWeight.toString()).toFixed(3)} kg`;

    const visible = shipment.charges.filter(
      (charge) => charge.chargeType.isCustomerVisible,
    );

    if (visible.length === 0) {
      // No charge rows — bill the consignment as one line rather than
      // dropping it, which would quietly under-bill the run.
      lines.push({
        shipmentId: shipment.id,
        chargeTypeId: null,
        description: `Freight — ${label}`,
        quantity: new Decimal(1),
        rate: money(dec(shipment.chargesTotal.toString())),
        amount: money(dec(shipment.chargesTotal.toString())),
        taxPercent: null,
        taxAmount: money(dec(shipment.taxAmount.toString())),
        hsnSac: GTA_SAC,
      });
      continue;
    }

    for (const charge of visible) {
      lines.push({
        shipmentId: shipment.id,
        chargeTypeId: charge.chargeTypeId,
        description: `${charge.chargeType.name} — ${label}`,
        quantity: dec(charge.quantity.toString()),
        rate: dec(charge.rate.toString()),
        amount: money(dec(charge.amount.toString())),
        taxPercent: charge.taxPercent ? dec(charge.taxPercent.toString()) : null,
        taxAmount: money(dec(charge.taxAmount.toString())),
        // The charge head's own code where the tax master carries one;
        // otherwise the GTA default, which is what road freight files under.
        hsnSac: charge.chargeType.taxRate?.hsnSac ?? GTA_SAC,
      });
    }
  }

  return { lines, anyReverseCharge, allReverseCharge };
}

// ────────────────────────────────────────────────────────────
// Generation
// ────────────────────────────────────────────────────────────

export type GenerateInvoiceInput = {
  customerId: string;
  branchId: string;
  invoiceDate?: Date;
  periodFrom?: Date | null;
  periodTo?: Date | null;
  shipmentIds: string[];
  notes?: string | null;
  /** Override the shipment-derived reverse-charge decision. */
  isReverseCharge?: boolean;
  placeOfSupply?: string | null;
};

/**
 * Creates a draft invoice.
 *
 * The number is issued inside the transaction alongside the row, so a
 * failed bill run does not burn a number out of the series — a gap in an
 * invoice sequence is a question every tax audit asks.
 */
export async function generateInvoice(
  input: GenerateInvoiceInput,
  actor: SessionUser,
): Promise<InvoiceResult> {
  if (!can(actor, "invoice.create")) {
    return { ok: false, error: "You do not have permission to raise invoices." };
  }
  if (input.shipmentIds.length === 0) {
    return { ok: false, error: "Pick at least one consignment to bill." };
  }

  const [customer, branch] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: input.customerId },
      select: {
        id: true,
        code: true,
        name: true,
        gstin: true,
        creditDays: true,
        isActive: true,
        deletedAt: true,
        billingCity: { select: { state: { select: { name: true, gstCode: true } } } },
      },
    }),
    // The billing branch's code goes into the number: the seeded INVOICE
    // pattern is `INV/{FY}/{BRANCH}/{SEQ}`, and without a code it renders
    // `INV/2627//0001` — a branch-wise series that does not name a branch.
    prisma.branch.findUnique({
      where: { id: input.branchId },
      select: { id: true, code: true, gstin: true },
    }),
  ]);

  if (!customer || customer.deletedAt || !customer.isActive) {
    return { ok: false, error: "That customer account is not available for billing." };
  }
  if (!branch) {
    return { ok: false, error: "That billing branch does not exist." };
  }

  const { lines, anyReverseCharge, allReverseCharge } = await draftLines(
    input.shipmentIds,
    prisma,
  );

  if (lines.length === 0) {
    return { ok: false, error: "Those consignments have nothing billable on them." };
  }

  // Mixing forward-charge and reverse-charge consignments on one invoice
  // produces a document that cannot be filed. Refuse rather than guess.
  if (input.isReverseCharge === undefined && anyReverseCharge && !allReverseCharge) {
    return {
      ok: false,
      error:
        "These consignments mix reverse-charge and forward-charge supplies. " +
        "Bill them on separate invoices.",
    };
  }

  const isReverseCharge = input.isReverseCharge ?? allReverseCharge;
  const totals = totalInvoice(lines, isReverseCharge);

  const invoiceDate = input.invoiceDate ?? new Date();
  const dueDate = new Date(invoiceDate);
  dueDate.setDate(dueDate.getDate() + (customer.creditDays ?? 0));

  // A tax invoice has to state a place of supply, and the customer's
  // billing state is the answer whenever nobody has typed a different one.
  const placeOfSupply =
    input.placeOfSupply?.trim() || customer.billingCity?.state.name || null;

  try {
    const created = await tenantTransaction(async (tx) => {
      const number = await nextNumber(
        { document: "INVOICE", at: invoiceDate, branchCode: branch.code },
        tx,
      );

      const invoice = await tx.invoice.create({
        data: {
          orgId: actor.orgId,
          number,
          status: "DRAFT",
          customerId: customer.id,
          branchId: input.branchId,
          invoiceDate,
          dueDate,
          periodFrom: input.periodFrom ?? undefined,
          periodTo: input.periodTo ?? undefined,
          subtotal: totals.subtotal.toFixed(2),
          taxAmount: totals.taxAmount.toFixed(2),
          roundOff: totals.roundOff.toFixed(2),
          total: totals.total.toFixed(2),
          amountPaid: "0",
          amountDue: totals.total.toFixed(2),
          isReverseCharge,
          placeOfSupply: placeOfSupply ?? undefined,
          customerGstin: customer.gstin ?? undefined,
          notes: input.notes ?? undefined,
          createdById: actor.id,
          lines: {
            createMany: {
              data: lines.map((line, index) => ({
                orgId: actor.orgId,
                shipmentId: line.shipmentId,
                chargeTypeId: line.chargeTypeId,
                description: line.description,
                quantity: line.quantity.toFixed(3),
                rate: line.rate.toFixed(4),
                amount: line.amount.toFixed(2),
                taxPercent: line.taxPercent?.toFixed(3) ?? null,
                taxAmount: line.taxAmount.toFixed(2),
                hsnSac: line.hsnSac,
                sortOrder: index * 10,
              })),
            },
          },
        },
        select: { id: true, number: true },
      });

      return invoice;
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Invoice",
      entityId: created.id,
      entityRef: created.number,
      branchId: input.branchId,
      after: {
        customer: customer.code,
        shipments: input.shipmentIds.length,
        lines: lines.length,
        subtotal: totals.subtotal.toFixed(2),
        tax: totals.taxAmount.toFixed(2),
        statedTaxUnderRcm: isReverseCharge ? totals.statedTax.toFixed(2) : undefined,
        total: totals.total.toFixed(2),
        isReverseCharge,
      },
    });

    return { ok: true, invoiceId: created.id, number: created.number };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

/**
 * How a bill run is cut.
 *
 * `CUSTOMER` puts everything a customer moved in the period on one
 * document, whoever booked it. `CUSTOMER_BRANCH` cuts a separate invoice
 * per originating branch — which is what a group with branch P&L asks for,
 * and what the GST registration of a multi-state operator requires, since
 * the supply is made from the branch that booked it (BRD §A.12).
 */
export type BillingGrouping = "CUSTOMER" | "CUSTOMER_BRANCH";

export type BillingRunOptions = {
  from: Date;
  to: Date;
  /**
   * The branch the invoice is raised from under `CUSTOMER` grouping.
   * Ignored under `CUSTOMER_BRANCH`, where each invoice is raised from the
   * branch whose consignments it bills.
   */
  branchId: string;
  customerIds?: string[];
  /** Restrict a branch-wise run to these origin branches. */
  branchIds?: string[];
  deliveredOnly?: boolean;
  invoiceDate?: Date;
  groupBy?: BillingGrouping;
};

export type BillingRunResult = {
  created: Array<{
    customerId: string;
    branchId: string;
    branchCode: string;
    invoiceId: string;
    number: string;
    shipments: number;
  }>;
  skipped: Array<{ customerId: string; branchId?: string; reason: string }>;
};

/**
 * The monthly bill run.
 *
 * Each invoice is generated on its own: a single unbillable account must
 * not take down a run of two hundred that were fine, and the skip list is
 * what the operator works through afterwards.
 */
export async function runConsolidatedBilling(
  options: BillingRunOptions,
  actor: SessionUser,
): Promise<BillingRunResult> {
  const created: BillingRunResult["created"] = [];
  const skipped: BillingRunResult["skipped"] = [];
  const groupBy = options.groupBy ?? "CUSTOMER";

  const customers = await prisma.customer.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      paymentTerm: "CREDIT",
      ...(options.customerIds && options.customerIds.length > 0
        ? { id: { in: options.customerIds } }
        : {}),
      ...branchScope(actor, "branchId"),
    },
    select: { id: true, code: true, name: true },
    orderBy: { name: "asc" },
  });

  const billingBranch = await prisma.branch.findUnique({
    where: { id: options.branchId },
    select: { id: true, code: true },
  });

  if (!billingBranch && groupBy === "CUSTOMER") {
    return {
      created,
      skipped: [{ customerId: "", reason: "That billing branch does not exist." }],
    };
  }

  for (const customer of customers) {
    const shipments = await billableShipments(
      {
        customerId: customer.id,
        from: options.from,
        to: options.to,
        deliveredOnly: options.deliveredOnly,
        branchIds: options.branchIds,
      },
      actor,
    );

    if (shipments.length === 0) {
      skipped.push({ customerId: customer.id, reason: "nothing billable in the period" });
      continue;
    }

    // One group under `CUSTOMER`; one per originating branch otherwise.
    const groups = new Map<string, { branchCode: string; shipmentIds: string[] }>();

    for (const shipment of shipments) {
      const key =
        groupBy === "CUSTOMER_BRANCH" ? shipment.branchId : billingBranch!.id;
      const code =
        groupBy === "CUSTOMER_BRANCH" ? shipment.branchCode : billingBranch!.code;

      const group = groups.get(key) ?? { branchCode: code, shipmentIds: [] };
      group.shipmentIds.push(shipment.id);
      groups.set(key, group);
    }

    for (const [branchId, group] of groups) {
      const result = await generateInvoice(
        {
          customerId: customer.id,
          branchId,
          invoiceDate: options.invoiceDate,
          periodFrom: options.from,
          periodTo: options.to,
          shipmentIds: group.shipmentIds,
        },
        actor,
      );

      if (result.ok) {
        created.push({
          customerId: customer.id,
          branchId,
          branchCode: group.branchCode,
          invoiceId: result.invoiceId,
          number: result.number,
          shipments: group.shipmentIds.length,
        });
      } else {
        skipped.push({ customerId: customer.id, branchId, reason: result.error });
      }
    }
  }

  return { created, skipped };
}

// ────────────────────────────────────────────────────────────
// Approve, cancel, credit
// ────────────────────────────────────────────────────────────

/**
 * Issues a draft.
 *
 * Sensitive, and audited with a reason: once issued, the document has left
 * the building and the only correction is a credit note.
 */
export async function issueInvoice(
  input: { invoiceId: string; reason: string },
  actor: SessionUser,
): Promise<InvoiceResult<{ invoiceId: string; number: string }>> {
  if (!can(actor, "invoice.approve")) {
    return { ok: false, error: "You do not have permission to approve invoices." };
  }
  if (!input.reason?.trim()) {
    return { ok: false, error: "Give a reason — approving an invoice is audited." };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: input.invoiceId },
    select: { id: true, number: true, status: true, branchId: true, total: true },
  });

  if (!invoice) return { ok: false, error: "That invoice no longer exists." };
  if (invoice.status !== "DRAFT") {
    return { ok: false, error: `This invoice is already ${invoice.status.toLowerCase()}.` };
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: "ISSUED", issuedAt: new Date(), issuedById: actor.id },
  });

  await recordAudit({
    user: actor,
    action: "APPROVE",
    entity: "Invoice",
    entityId: invoice.id,
    entityRef: invoice.number,
    branchId: invoice.branchId,
    before: { status: "DRAFT" },
    after: { status: "ISSUED", total: invoice.total.toString() },
    reason: input.reason.trim(),
  });

  return { ok: true, invoiceId: invoice.id, number: invoice.number };
}

/**
 * Cancels an invoice.
 *
 * Only ever before money has been received against it — once a payment is
 * allocated the correction is a credit note, because cancelling would
 * leave the receipt pointing at nothing.
 */
export async function cancelInvoice(
  input: { invoiceId: string; reason: string },
  actor: SessionUser,
): Promise<InvoiceResult<{ invoiceId: string; number: string }>> {
  if (!can(actor, "invoice.cancel")) {
    return { ok: false, error: "You do not have permission to cancel invoices." };
  }
  if (!input.reason?.trim()) {
    return { ok: false, error: "Give a reason — cancelling an invoice is audited." };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: input.invoiceId },
    select: {
      id: true,
      number: true,
      status: true,
      branchId: true,
      total: true,
      amountPaid: true,
      _count: { select: { allocations: true, creditNotes: true } },
    },
  });

  if (!invoice) return { ok: false, error: "That invoice no longer exists." };
  if (invoice.status === "CANCELLED") {
    return { ok: false, error: "That invoice is already cancelled." };
  }
  if (invoice._count.allocations > 0 || dec(invoice.amountPaid.toString()).greaterThan(0)) {
    return {
      ok: false,
      error:
        "Money has been received against this invoice. Raise a credit note instead — " +
        "cancelling would orphan the receipt.",
    };
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelReason: input.reason.trim(),
      amountDue: "0",
    },
  });

  await recordAudit({
    user: actor,
    action: "CANCEL",
    entity: "Invoice",
    entityId: invoice.id,
    entityRef: invoice.number,
    branchId: invoice.branchId,
    before: { status: invoice.status, total: invoice.total.toString() },
    after: { status: "CANCELLED" },
    reason: input.reason.trim(),
  });

  return { ok: true, invoiceId: invoice.id, number: invoice.number };
}

/**
 * Raises a credit note against an issued invoice.
 *
 * The invoice itself is left exactly as it was issued — the credit note is
 * the correction, and the pair together is the trail.
 */
export async function createCreditNote(
  input: {
    invoiceId: string;
    amount: MoneyIn;
    taxAmount?: MoneyIn;
    reason: string;
  },
  actor: SessionUser,
): Promise<InvoiceResult<{ invoiceId: string; number: string }>> {
  if (!can(actor, "invoice.cancel")) {
    return { ok: false, error: "You do not have permission to raise credit notes." };
  }
  if (!input.reason?.trim()) {
    return { ok: false, error: "A credit note needs a reason." };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: input.invoiceId },
    select: {
      id: true,
      number: true,
      orgId: true,
      status: true,
      branchId: true,
      customerId: true,
      total: true,
      amountDue: true,
      isReverseCharge: true,
      creditNotes: { select: { total: true } },
    },
  });

  if (!invoice) return { ok: false, error: "That invoice no longer exists." };
  if (invoice.status === "CANCELLED") {
    return { ok: false, error: "That invoice is cancelled; there is nothing to credit." };
  }

  const amount = money(dec(input.amount));
  const taxAmount = invoice.isReverseCharge
    ? new Decimal(0)
    : money(dec(input.taxAmount));
  const total = money(amount.plus(taxAmount));

  if (total.lessThanOrEqualTo(0)) {
    return { ok: false, error: "A credit note must be for more than nothing." };
  }

  const alreadyCredited = invoice.creditNotes.reduce(
    (sum, note) => sum.plus(dec(note.total.toString())),
    new Decimal(0),
  );
  const invoiceTotal = dec(invoice.total.toString());

  if (alreadyCredited.plus(total).greaterThan(invoiceTotal)) {
    return {
      ok: false,
      error:
        `Credits already raised come to ₹${alreadyCredited.toFixed(2)}. This one would ` +
        `take the total past the invoice's ₹${invoiceTotal.toFixed(2)}.`,
    };
  }

  try {
    const created = await tenantTransaction(async (tx) => {
      const number = await nextNumber(
        { document: "CREDIT_NOTE" },
        tx,
      );

      const note = await tx.creditNote.create({
        data: {
          orgId: invoice.orgId,
          number,
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          reason: input.reason.trim(),
          amount: amount.toFixed(2),
          taxAmount: taxAmount.toFixed(2),
          total: total.toFixed(2),
          issuedById: actor.id,
        },
        select: { id: true, number: true },
      });

      const creditedInFull = alreadyCredited.plus(total).greaterThanOrEqualTo(invoiceTotal);
      const amountDue = money(
        dec(invoice.amountDue.toString()).minus(total),
      );

      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          amountDue: (amountDue.lessThan(0) ? new Decimal(0) : amountDue).toFixed(2),
          status: creditedInFull ? "CREDITED" : invoice.status,
        },
      });

      return note;
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "CreditNote",
      entityId: created.id,
      entityRef: created.number,
      branchId: invoice.branchId,
      after: {
        invoice: invoice.number,
        amount: amount.toFixed(2),
        taxAmount: taxAmount.toFixed(2),
        total: total.toFixed(2),
      },
      reason: input.reason.trim(),
    });

    return { ok: true, invoiceId: invoice.id, number: created.number };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

/**
 * Recomputes what is owed on an invoice.
 *
 * Called after every allocation and credit note rather than trusting an
 * incremental update — `amountDue` drives the ageing report, and a drift
 * there is invisible until a customer disputes a statement.
 */
export async function recomputeInvoiceBalance(
  invoiceId: string,
  client: DbOrTx = prisma,
): Promise<void> {
  const invoice = await client.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      status: true,
      total: true,
      allocations: { select: { amount: true } },
      creditNotes: { select: { total: true } },
    },
  });

  if (!invoice) return;

  const paid = invoice.allocations.reduce(
    (sum, a) => sum.plus(dec(a.amount.toString())),
    new Decimal(0),
  );
  const credited = invoice.creditNotes.reduce(
    (sum, n) => sum.plus(dec(n.total.toString())),
    new Decimal(0),
  );

  const total = dec(invoice.total.toString());
  const due = money(total.minus(paid).minus(credited));
  const settled = due.lessThanOrEqualTo(0);

  // Cancelled stays cancelled; a credited invoice that is also fully paid
  // is still credited, because that is the document that was issued.
  const status =
    invoice.status === "CANCELLED" || invoice.status === "CREDITED"
      ? invoice.status
      : settled
        ? "PAID"
        : paid.greaterThan(0)
          ? "PARTIALLY_PAID"
          : invoice.status === "DRAFT"
            ? "DRAFT"
            : "ISSUED";

  await client.invoice.update({
    where: { id: invoice.id },
    data: {
      amountPaid: money(paid).toFixed(2),
      amountDue: (due.lessThan(0) ? new Decimal(0) : due).toFixed(2),
      status,
    },
  });
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No active number series")) {
    return "No invoice number series is configured. Set one up under Masters → Number series.";
  }
  if (message.includes("Unique constraint")) {
    return "That invoice appears to have been saved already. Refresh before retrying.";
  }
  console.error("[billing/invoice]", error);
  return "Something went wrong. Nothing was saved.";
}

export { totalInvoice, type InvoiceTotals } from "./totals";
