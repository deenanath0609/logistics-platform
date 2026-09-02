"use server";

import { revalidatePath } from "next/cache";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  createSettlement,
  approveSettlement,
  markSettlementPaid,
  cancelSettlement,
} from "@/lib/billing/settlement";
import type { FinanceActionState } from "../action-state";

const PATH = "/finance/settlements";

function guard(error: unknown): FinanceActionState {
  if (error instanceof PermissionError) {
    return { error: "You do not have permission to do that." };
  }
  console.error("[finance/settlements]", error);
  return { error: "Something went wrong. Nothing was saved." };
}

export async function prepareSettlementAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("settlement.prepare");
    const tripId = String(formData.get("tripId") ?? "");
    if (!tripId) return { error: "Pick a trip." };

    /*
      The digits that were typed, not a double.

      `MoneyIn` takes a string and `dec()` reads it exactly; `Number()` is a
      lossy first step on figures that are subtracted from a driver's
      earning to produce the amount actually handed over. The rest of this
      module was moved off `Number` for exactly this reason — these two were
      missed, and a deduction is the one line on a settlement a driver
      argues about.
    */
    const deductionsRaw = String(formData.get("deductions") ?? "").trim();
    const deductions =
      deductionsRaw !== "" && Number.isFinite(Number(deductionsRaw)) ? deductionsRaw : "0";

    if (Number(deductions) < 0) {
      return {
        error: "A deduction cannot be negative.",
        fieldErrors: { deductions: "Zero or more" },
      };
    }

    const tripEarningRaw = String(formData.get("tripEarning") ?? "").trim();

    const result = await createSettlement(
      {
        tripId,
        deductions,
        deductionNote: (formData.get("deductionNote") as string) ?? null,
        // Still passed, and no longer trusted over the trip: the service
        // uses it only where the trip carries no `freightPayable` of its
        // own, and records in the audit row that it was typed. It used to
        // win outright, on any trip, for anyone holding `settlement.prepare`.
        tripEarning:
          tripEarningRaw !== "" && Number.isFinite(Number(tripEarningRaw))
            ? tripEarningRaw
            : undefined,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(PATH);
    return {
      ok: true,
      message: `${result.number} prepared — net payable ₹${result.netPayable.toFixed(2)}. It needs a second person to approve it.`,
    };
  } catch (error) {
    return guard(error);
  }
}

/** Sensitive: cash leaves the building on this. Audited with a reason. */
export async function approveSettlementAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("settlement.approve");
    const settlementId = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");

    if (!settlementId) return { error: "Nothing selected." };
    if (!reason.trim()) {
      return {
        error: "A reason is required.",
        fieldErrors: { reason: "Say what you checked before releasing the payout." },
      };
    }

    const result = await approveSettlement({ settlementId, reason }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH);
    return { ok: true, message: `${result.number} approved for payout.` };
  } catch (error) {
    return guard(error);
  }
}

export async function markSettlementPaidAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("payment.record");
    const settlementId = String(formData.get("id") ?? "");
    if (!settlementId) return { error: "Nothing selected." };

    const result = await markSettlementPaid(
      { settlementId, reference: (formData.get("reference") as string) ?? null },
      actor,
    );
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH);
    return { ok: true, message: "Marked as paid." };
  } catch (error) {
    return guard(error);
  }
}

export async function cancelSettlementAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("settlement.approve");
    const settlementId = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");

    if (!settlementId) return { error: "Nothing selected." };
    if (!reason.trim()) {
      return { error: "A reason is required.", fieldErrors: { reason: "Say why." } };
    }

    const result = await cancelSettlement({ settlementId, reason }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH);
    return { ok: true, message: "Settlement cancelled." };
  } catch (error) {
    return guard(error);
  }
}
