import Decimal from "decimal.js";
import { prisma, tenantTransaction, type Db } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { recordAudit } from "@/server/services/audit";
import { addDays, businessDay } from "@/lib/time/business-day";
import { nextNumber } from "@/lib/numbering/number-series";
import { dec, money, type MoneyIn } from "./ageing";
import { DEBIT_NOTE_PREFIX, isDebitNoteNumber } from "./default-series";
import { GTA_SAC } from "./gst";
import { totalInvoice } from "./totals";

/**
 * Debit notes.
 *
 * The counterpart to a credit note: the hub reweighs, the number goes up,
 * and an invoice that has already left the building cannot be edited. GST
 * §34(3) calls the correction a supplementary tax invoice, and that is
 * exactly what this writes — an `Invoice` row numbered from the
 * `DEBIT_NOTE` series, carrying the delta and nothing else.
 *
 * There is no `DebitNote` table, and this is not a workaround: a debit
 * note is due, ages, and is paid like any other invoice, so modelling it
 * as one means the receivables ledger, the ageing buckets and the payment
 * allocator all handle it without knowing it exists. It is told apart from
 * an ordinary invoice by its number — see `isDebitNoteNumber`.
 */

export { DEBIT_NOTE_PREFIX, isDebitNoteNumber };

export type DebitNoteResult =
  | {
      ok: true;
      debitNoteId: string;
      number: string;
      amount: Decimal;
      taxAmount: Decimal;
      total: Decimal;
    }
  | { ok: false; error: string };

/** Invoice statuses that still hold a shipment. A cancelled one does not. */
const LIVE_INVOICE_STATUSES = [
  "DRAFT",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "CREDITED",
] as const;

export type ShipmentInvoiceLink = {
  invoiceId: string;
  number: string;
  status: string;
  branchId: string;
  customerId: string;
  isReverseCharge: boolean;
  placeOfSupply: string | null;
  hsnSac: string | null;
  /** True once the document has left the building — no longer editable. */
  isIssued: boolean;
};

/**
 * The live invoice a consignment sits on, if any.
 *
 * A reweigh before invoicing needs no debit note — the invoice has not
 * been raised, so it picks up the revised figure by itself. This is the
 * question that decides which of the two happens.
 */
export async function liveInvoiceForShipment(
  shipmentId: string,
  client: Pick<Db, "invoiceLine"> = prisma,
): Promise<ShipmentInvoiceLink | null> {
  const line = await client.invoiceLine.findFirst({
    where: {
      shipmentId,
      invoice: { status: { in: [...LIVE_INVOICE_STATUSES] } },
    },
    orderBy: { invoice: { invoiceDate: "desc" } },
    select: {
      hsnSac: true,
      invoice: {
        select: {
          id: true,
          number: true,
          status: true,
          branchId: true,
          customerId: true,
          isReverseCharge: true,
          placeOfSupply: true,
        },
      },
    },
  });

  if (!line) return null;

  // A debit note against a debit note is a second correction on the same
  // consignment, which is legitimate — but it must reference the original
  // invoice, not the previous correction.
  if (isDebitNoteNumber(line.invoice.number)) {
    const original = await client.invoiceLine.findFirst({
      where: {
        shipmentId,
        invoice: {
          status: { in: [...LIVE_INVOICE_STATUSES] },
          number: { not: { startsWith: DEBIT_NOTE_PREFIX } },
        },
      },
      orderBy: { invoice: { invoiceDate: "asc" } },
      select: {
        hsnSac: true,
        invoice: {
          select: {
            id: true,
            number: true,
            status: true,
            branchId: true,
            customerId: true,
            isReverseCharge: true,
            placeOfSupply: true,
          },
        },
      },
    });

    if (original) {
      return {
        invoiceId: original.invoice.id,
        number: original.invoice.number,
        status: original.invoice.status,
        branchId: original.invoice.branchId,
        customerId: original.invoice.customerId,
        isReverseCharge: original.invoice.isReverseCharge,
        placeOfSupply: original.invoice.placeOfSupply,
        hsnSac: original.hsnSac,
        isIssued: original.invoice.status !== "DRAFT",
      };
    }
  }

  return {
    invoiceId: line.invoice.id,
    number: line.invoice.number,
    status: line.invoice.status,
    branchId: line.invoice.branchId,
    customerId: line.invoice.customerId,
    isReverseCharge: line.invoice.isReverseCharge,
    placeOfSupply: line.invoice.placeOfSupply,
    hsnSac: line.hsnSac,
    isIssued: line.invoice.status !== "DRAFT",
  };
}

export type CreateDebitNoteInput = {
  /** The invoice being corrected. Its customer and branch are inherited. */
  againstInvoiceId: string;
  /** The consignment the correction is about, so the line still traces. */
  shipmentId?: string | null;
  /** The additional taxable value. Must be more than nothing. */
  amount: MoneyIn;
  /** The GST on that value. Stated but not collected under reverse charge. */
  taxAmount?: MoneyIn;
  taxPercent?: MoneyIn;
  hsnSac?: string | null;
  description?: string;
  reason: string;
  issuedOn?: Date;
};

/**
 * Raises a debit note against an invoice.
 *
 * Numbered inside the transaction like every other document, so a failed
 * write does not burn a number — a gap in a debit-note sequence is a
 * question every GST audit asks.
 */
export async function createDebitNote(
  input: CreateDebitNoteInput,
  actor: SessionUser,
): Promise<DebitNoteResult> {
  // Raising one increases what the customer owes, which is the same
  // authority as raising an invoice in the first place.
  if (!can(actor, "invoice.create")) {
    return { ok: false, error: "You do not have permission to raise debit notes." };
  }
  if (!input.reason?.trim()) {
    return { ok: false, error: "A debit note needs a reason — the customer will ask." };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: input.againstInvoiceId },
    select: {
      id: true,
      orgId: true,
      number: true,
      status: true,
      branchId: true,
      customerId: true,
      isReverseCharge: true,
      placeOfSupply: true,
      customerGstin: true,
      invoiceDate: true,
      customer: { select: { creditDays: true, gstin: true } },
      branch: { select: { code: true } },
    },
  });

  if (!invoice) return { ok: false, error: "That invoice no longer exists." };
  // A debit note is raised from the original's branch and inherits its
  // number series. The screen that offers the control already refuses
  // another branch's invoice; the server action does not pass that screen.
  if (!coversBranch(actor, invoice.branchId)) {
    return { ok: false, error: "That invoice belongs to another branch." };
  }
  if (invoice.status === "CANCELLED") {
    return {
      ok: false,
      error:
        `${invoice.number} is cancelled. Bill the revised weight on a fresh invoice ` +
        `rather than debiting a document that was withdrawn.`,
    };
  }

  /**
   * The consignment the note is attributed to, if one was named.
   *
   * ── The loophole this closes ─────────────────────────────────────────
   *
   * `input.shipmentId` went straight onto `invoiceLine.shipmentId` with
   * nothing checked — not that the shipment existed, not that it was this
   * organisation's, not that it had any connection to the account being
   * billed. The invoice dialog never renders the field, but a server action
   * does not pass the dialog, and this one reads `shipmentId` off the form.
   *
   * Attaching a stranger's consignment to a debit note is not a cosmetic
   * error. `liveInvoiceForShipment` resolves a shipment to the invoice it
   * sits on, so the next re-weigh of that consignment would raise its
   * correction against *this* customer's invoice — and `staleAgainstConsignments`
   * would block issuing over a consignment that was never billed here.
   * One forged field quietly re-points another account's money.
   *
   * The consignment must belong to the customer the invoice bills. That is
   * exactly what the re-weigh path passes — `liveInvoiceForShipment` found
   * the shipment *on* this invoice — so the legitimate caller is unaffected,
   * and a consignment left out of a bill run can still be added.
   * ────────────────────────────────────────────────────────────────────
   */
  if (input.shipmentId) {
    const shipment = await prisma.shipment.findFirst({
      where: { id: input.shipmentId, orgId: invoice.orgId, deletedAt: null },
      select: { id: true, lrNumber: true, consignorId: true },
    });

    if (!shipment) {
      return { ok: false, error: "That consignment no longer exists." };
    }
    if (shipment.consignorId !== invoice.customerId) {
      return {
        ok: false,
        error:
          `${shipment.lrNumber} is not billed to the account on ${invoice.number}. ` +
          `A debit note corrects one account's invoice and cannot carry another's consignment.`,
      };
    }
  }

  const amount = money(dec(input.amount));
  if (amount.lessThanOrEqualTo(0)) {
    return {
      ok: false,
      error:
        "A debit note must be for more than nothing. A downward revision is a credit note.",
    };
  }

  // Under reverse charge the recipient pays the tax, so it is stated on
  // the line and kept out of the total — the same rule the invoice itself
  // follows, and `totalInvoice` is what enforces it.
  const statedTax = money(dec(input.taxAmount));

  const line = {
    amount,
    taxAmount: statedTax,
  };
  const totals = totalInvoice([line], invoice.isReverseCharge);

  // `invoiceDate` and `dueDate` are `@db.Date`, which keeps the UTC day of
  // whatever it is handed, and `{FY}` in the DEBIT_NOTE pattern is read off
  // the same value. See `businessDay` — a bare `new Date()` back-dated
  // every document raised before 05:30 IST by one day.
  const issuedOn = businessDay(input.issuedOn ?? new Date());
  const dueDate = addDays(issuedOn, invoice.customer.creditDays ?? 0);

  const description =
    input.description?.trim() ||
    `Revised chargeable weight — supplementary charge against ${invoice.number}`;

  try {
    const created = await tenantTransaction(async (tx) => {
      const number = await nextNumber(
        { document: "DEBIT_NOTE", at: issuedOn, branchCode: invoice.branch.code },
        tx,
      );

      return tx.invoice.create({
        data: {
          orgId: invoice.orgId,
          number,
          status: "DRAFT",
          customerId: invoice.customerId,
          branchId: invoice.branchId,
          invoiceDate: issuedOn,
          dueDate,
          subtotal: totals.subtotal.toFixed(2),
          taxAmount: totals.taxAmount.toFixed(2),
          roundOff: totals.roundOff.toFixed(2),
          total: totals.total.toFixed(2),
          amountPaid: "0",
          amountDue: totals.total.toFixed(2),
          isReverseCharge: invoice.isReverseCharge,
          placeOfSupply: invoice.placeOfSupply ?? undefined,
          customerGstin: invoice.customerGstin ?? invoice.customer.gstin ?? undefined,
          notes:
            `Debit note against ${invoice.number} dated ` +
            `${invoice.invoiceDate.toISOString().slice(0, 10)}. ${input.reason.trim()}`,
          createdById: actor.id,
          lines: {
            createMany: {
              data: [
                {
                  // The note belongs to the invoice it corrects, not to
                  // whoever raised it — see the `orgId` on the parent above.
                  orgId: invoice.orgId,
                  shipmentId: input.shipmentId ?? null,
                  description,
                  quantity: "1.000",
                  rate: amount.toFixed(4),
                  amount: amount.toFixed(2),
                  taxPercent: input.taxPercent
                    ? dec(input.taxPercent).toFixed(3)
                    : null,
                  taxAmount: statedTax.toFixed(2),
                  hsnSac: input.hsnSac ?? GTA_SAC,
                  sortOrder: 0,
                } satisfies Omit<Prisma.InvoiceLineCreateManyInvoiceInput, "id">,
              ],
            },
          },
        },
        select: { id: true, number: true },
      });
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Invoice",
      entityId: created.id,
      entityRef: created.number,
      branchId: invoice.branchId,
      after: {
        kind: "DEBIT_NOTE",
        against: invoice.number,
        shipmentId: input.shipmentId ?? null,
        amount: amount.toFixed(2),
        statedTax: statedTax.toFixed(2),
        taxAdded: totals.taxAmount.toFixed(2),
        total: totals.total.toFixed(2),
        isReverseCharge: invoice.isReverseCharge,
      },
      reason: input.reason.trim(),
    });

    return {
      ok: true,
      debitNoteId: created.id,
      number: created.number,
      amount,
      taxAmount: statedTax,
      total: totals.total,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No active number series")) {
      return {
        ok: false,
        error:
          "No debit note number series is configured. Set one up under Masters → Number series.",
      };
    }
    console.error("[billing/debit-note]", error);
    return { ok: false, error: "Could not raise that debit note. Nothing was saved." };
  }
}

export type ReweighDebitNoteInput = {
  shipmentId: string;
  /** What the re-rate found. Only a positive delta raises a note. */
  delta: MoneyIn;
  /** The tax on the delta, at the same rate the invoice carried. */
  taxDelta?: MoneyIn;
  taxPercent?: MoneyIn;
  previousChargeableWeight?: MoneyIn;
  revisedChargeableWeight?: MoneyIn;
  reason?: string;
};

export type ReweighDebitNoteOutcome =
  | ({ raised: true } & Extract<DebitNoteResult, { ok: true }>)
  /** Nothing to correct: not yet invoiced, or the number did not go up. */
  | { raised: false; reason: string; error?: string };

/**
 * The debit note a reweigh calls for, if it calls for one at all.
 *
 * Three outcomes, and the two that raise nothing are the common ones: the
 * consignment has not been invoiced yet, so the invoice will simply bill
 * the revised figure; or the invoice is still a draft, and re-generating
 * it is cleaner than correcting it.
 */
export async function raiseReweighDebitNote(
  input: ReweighDebitNoteInput,
  actor: SessionUser,
): Promise<ReweighDebitNoteOutcome> {
  const delta = money(dec(input.delta));

  if (delta.lessThanOrEqualTo(0)) {
    return {
      raised: false,
      reason: "The revision did not increase the price, so there is nothing to debit.",
    };
  }

  const link = await liveInvoiceForShipment(input.shipmentId);

  if (!link) {
    return {
      raised: false,
      reason:
        "This consignment is not on a live invoice yet — the revised weight will be billed when it is.",
    };
  }

  if (!link.isIssued) {
    return {
      raised: false,
      reason:
        `${link.number} is still a draft. Regenerate it rather than debiting a document ` +
        `that has not left the building.`,
    };
  }

  const weightNote =
    input.previousChargeableWeight !== undefined &&
    input.revisedChargeableWeight !== undefined
      ? ` Chargeable weight revised from ${dec(input.previousChargeableWeight).toFixed(3)} kg ` +
        `to ${dec(input.revisedChargeableWeight).toFixed(3)} kg at the hub.`
      : "";

  const result = await createDebitNote(
    {
      againstInvoiceId: link.invoiceId,
      shipmentId: input.shipmentId,
      amount: delta,
      taxAmount: input.taxDelta,
      taxPercent: input.taxPercent,
      hsnSac: link.hsnSac,
      description: `Revised chargeable weight — supplementary charge against ${link.number}`,
      reason: (input.reason ?? "Chargeable weight revised at the hub.") + weightNote,
    },
    actor,
  );

  if (!result.ok) {
    return { raised: false, reason: result.error, error: result.error };
  }

  return { raised: true, ...result };
}
