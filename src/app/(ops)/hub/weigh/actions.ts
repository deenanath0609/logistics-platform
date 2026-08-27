"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import { captureRevisedWeight } from "@/lib/hub/weight";

export type WeighState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  ok?: boolean;
  message?: string;
  /** What actually changed, so the clerk sees the consequence of the reading. */
  delta?: {
    lrNumber: string;
    fromKg: string;
    toKg: string;
    fromAmount: string;
    toAmount: string;
    deltaAmount: string;
    deltaPercent: string;
    exceedsTolerance: boolean;
    debitNoteNumber: string | null;
    exceptionNumber: string | null;
  };
  warnings?: string[];
};

const optionalNumber = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,3})?$/, "Enter a weight in kilograms")
    .nullable(),
);

const schema = z.object({
  shipmentId: z.string().min(1, "Choose a consignment"),
  branchId: z.string().min(1, "No branch to weigh at"),
  actualWeight: optionalNumber,
  chargeableWeight: optionalNumber,
  reference: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(80).nullable(),
  ),
});

const inr = (value: string) => Number(value).toLocaleString("en-IN");

/**
 * Records what the weighbridge actually read.
 *
 * This is the call site `captureRevisedWeight` was written for and never
 * had: weight was only ever captured at booking, so a consignment declared
 * at 12 kg and weighing 70 kg was invoiced at 12. The re-rate, the second
 * freight calculation, the debit note, the tolerance exception and the
 * customer notification all already existed with nothing calling them.
 */
export async function captureWeight(
  _prev: WeighState,
  formData: FormData,
): Promise<WeighState> {
  try {
    return await capture(formData);
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to capture weight." };
    }
    console.error("[hub/weigh]", error);
    return { error: "The weight could not be recorded. Nothing was changed." };
  }
}

async function capture(formData: FormData): Promise<WeighState> {
  const actor = await authorize("weight.capture");

  const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { error: "Check the highlighted fields.", fieldErrors };
  }

  const result = await captureRevisedWeight(
    {
      shipmentId: parsed.data.shipmentId,
      branchId: parsed.data.branchId,
      actualWeight: parsed.data.actualWeight,
      chargeableWeight: parsed.data.chargeableWeight,
      reference: parsed.data.reference,
    },
    actor,
  );

  if (!result.ok) return { error: result.error };

  revalidatePath("/hub/weigh");
  revalidatePath(`/shipments/${parsed.data.shipmentId}`);

  return {
    ok: true,
    message: result.exceedsTolerance
      ? "Weight recorded. The change is past tolerance, so it has been raised and the consignor told."
      : "Weight recorded and the consignment repriced.",
    delta: {
      lrNumber: result.lrNumber,
      fromKg: result.previousChargeableWeight.toFixed(3),
      toKg: result.revisedChargeableWeight.toFixed(3),
      fromAmount: inr(result.previousTotal.toFixed(2)),
      toAmount: inr(result.revisedTotal.toFixed(2)),
      deltaAmount: inr(result.delta.toFixed(2)),
      deltaPercent: result.deltaPercent.toFixed(2),
      exceedsTolerance: result.exceedsTolerance,
      debitNoteNumber: result.debitNote.raised ? result.debitNote.number : null,
      exceptionNumber: result.exceptionNumber,
    },
    warnings: result.warnings,
  };
}
