"use server";

import { revalidatePath } from "next/cache";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import { authorize, can, PermissionError } from "@/lib/auth/session";
import { rerateShipment } from "@/lib/pricing/rerate";
import {
  liveInvoiceForShipment,
  raiseReweighDebitNote,
} from "@/lib/billing/debit-note";
import type { FinanceActionState } from "../action-state";

/**
 * Re-rates a consignment from the coverage-gap list.
 *
 * This is the pricing-desk path: a lane that booked unrated now has a
 * slab, so the consignment is priced again. The original calculation is
 * left alone and a second one is stored at the INVOICE stage, so the delta
 * is a record rather than a recollection.
 *
 * It is *not* the reweigh path. A hub revising chargeable weight goes
 * through `captureRevisedWeight` in `src/lib/hub/weight.ts`, which does
 * this and then raises the debit note, opens the exception and notifies
 * the customer when the increase is past tolerance. Re-rating from here
 * with a revised weight does the arithmetic but none of the rest, which
 * is why the weight field is for correcting a figure, not for recording
 * a weighing.
 */
export async function rerateShipmentAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    // Re-rating changes what a customer is charged, so it sits behind the
    // same permission as managing the card that decides the price.
    const actor = await authorize("ratecard.manage");

    const shipmentId = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");
    if (!shipmentId) return { error: "Nothing selected." };
    if (!reason.trim()) {
      return {
        error: "A reason is required.",
        fieldErrors: { reason: "Say why this is being re-priced." },
      };
    }

    const revisedWeight = formData.get("revisedChargeableWeight");

    /**
     * What the consignment was charged before, and where that figure has
     * already gone.
     *
     * Read *before* the re-rate, because `rerateShipment` applies the new
     * figures to the shipment and afterwards there is nothing to compare
     * to. `chargesTotal` rather than `grandTotal`: a debit note bills the
     * taxable value, with the tax stated beside it.
     */
    const before = await prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { id: true, lrNumber: true, chargesTotal: true },
    });
    if (!before) return { error: "That consignment no longer exists." };

    const linkBefore = await liveInvoiceForShipment(shipmentId);

    // A document that has left the building cannot be edited, and repricing
    // the consignment underneath it is the same thing done quietly. Raising
    // one needs the authority to raise an invoice, which `ratecard.manage`
    // is not — so the re-rate is refused rather than half-done.
    if (linkBefore?.isIssued && !can(actor, "invoice.create")) {
      return {
        error:
          `${before.lrNumber} is already billed on ${linkBefore.number}. Re-pricing it now ` +
          `raises a debit note against that invoice, which needs the permission to raise ` +
          `invoices. Nothing was changed.`,
      };
    }

    const result = await rerateShipment(
      {
        shipmentId,
        revisedChargeableWeight:
          revisedWeight && String(revisedWeight).trim() !== ""
            ? String(revisedWeight)
            : null,
        stage: "INVOICE",
        reason: reason.trim(),
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath("/finance/coverage-gaps");
    revalidatePath(`/shipments/${shipmentId}`);

    if (result.result.unrated) {
      return {
        error:
          "Still unrated — no slab on any applicable card covers this lane. " +
          "Add one and try again.",
      };
    }

    /**
     * The correction, when the consignment was already on a live invoice.
     *
     * Without this the pricing desk's re-rate moved `shipment.grandTotal`
     * and left the issued invoice stating the old figure, with nothing
     * billed for the difference and nothing on the account to say the
     * consignment had been repriced. The hub's reweigh path has raised the
     * note since it was written; this one is the same event arriving from
     * a different desk, and owes the customer the same document.
     *
     * `raiseReweighDebitNote` decides for itself: nothing on an uninvoiced
     * consignment, nothing on a draft — regenerate that instead — and
     * nothing when the price went down, which is a credit note and a
     * conversation.
     */
    const taxableDelta = result.result.chargesTotal.minus(
      new Decimal(before.chargesTotal.toString()),
    );

    const statedTax = result.result.taxes.reduce(
      (sum, tax) => sum.plus(tax.amount),
      new Decimal(0),
    );
    const taxableBase = result.result.taxes.reduce(
      (sum, tax) => sum.plus(tax.taxableValue),
      new Decimal(0),
    );
    const effectiveTaxPercent = taxableBase.greaterThan(0)
      ? statedTax.times(100).dividedBy(taxableBase)
      : new Decimal(0);

    const debitNote = await raiseReweighDebitNote(
      {
        shipmentId,
        delta: taxableDelta.toDecimalPlaces(2),
        taxDelta: taxableDelta
          .times(effectiveTaxPercent)
          .dividedBy(100)
          .toDecimalPlaces(2),
        taxPercent: effectiveTaxPercent,
        reason: `Re-priced from the coverage-gap report. ${reason.trim()}`,
      },
      actor,
    );

    const direction = result.delta.greaterThanOrEqualTo(0) ? "up" : "down";

    return {
      ok: true,
      message:
        `Re-rated to ₹${result.newTotal.toFixed(2)} — ${direction} ` +
        `₹${result.delta.abs().toFixed(2)} (${result.deltaPercent.toFixed(2)}%).` +
        (debitNote.raised
          ? ` Debit note ${debitNote.number} raised against ${linkBefore?.number ?? "the invoice"}.`
          : linkBefore
            ? ` ${debitNote.reason}`
            : "") +
        (result.exceedsTolerance
          ? ` That is beyond the ${result.tolerancePercent.toFixed(2)}% tolerance — tell the customer before billing.`
          : ""),
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to re-rate consignments." };
    }
    console.error("[finance/coverage-gaps] rerate", error);
    return { error: "Could not re-rate that. Nothing was saved." };
  }
}
