"use server";

import { revalidatePath } from "next/cache";
import { authorize, PermissionError } from "@/lib/auth/session";
import { rerateShipment } from "@/lib/pricing/rerate";
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

    const direction = result.delta.greaterThanOrEqualTo(0) ? "up" : "down";

    return {
      ok: true,
      message:
        `Re-rated to ₹${result.newTotal.toFixed(2)} — ${direction} ` +
        `₹${result.delta.abs().toFixed(2)} (${result.deltaPercent.toFixed(2)}%).` +
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
