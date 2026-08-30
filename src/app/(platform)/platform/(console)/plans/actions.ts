"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ConsoleFormState } from "@/components/platform/form-bits";
import {
  authorizeOperator,
  PlatformAuthError,
  PlatformPermissionError,
} from "@/lib/platform/session";
import {
  createPlan,
  deletePlan,
  updatePlan,
  type PlanInput,
} from "@/lib/platform/plans";

function describe(error: unknown): string {
  if (error instanceof PlatformPermissionError) {
    return "Only an owner or a billing operator may change plans.";
  }
  if (error instanceof PlatformAuthError) return error.message;
  console.error("[platform:plans]", error);
  return "Something went wrong. The change was not applied.";
}

/**
 * Blank is not zero here, and the distinction is the whole point of the
 * column: null means unlimited, zero means the feature is switched off.
 * `Number("")` is 0, which would quietly turn "unlimited users" into "no
 * users at all" for every plan somebody saved without touching that field.
 */
function limit(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
}

function readPlan(formData: FormData): PlanInput {
  const price = String(formData.get("monthlyPrice") ?? "").trim();
  return {
    code: String(formData.get("code") ?? ""),
    name: String(formData.get("name") ?? ""),
    maxUsers: limit(formData.get("maxUsers")),
    maxBranches: limit(formData.get("maxBranches")),
    maxShipmentsPerMonth: limit(formData.get("maxShipmentsPerMonth")),
    maxPortalUsers: limit(formData.get("maxPortalUsers")),
    // One entry per ticked module, not one comma-separated string. The
    // values are still validated in the service: a hand-crafted POST is as
    // capable of naming a module that does not exist as a typist was.
    features: formData
      .getAll("features")
      .map((feature) => String(feature).trim())
      .filter(Boolean),
    monthlyPrice: price === "" ? null : price,
    currency: String(formData.get("currency") ?? "INR").toUpperCase(),
    isActive: formData.get("isActive") === "on",
    sortOrder: Number(formData.get("sortOrder") ?? 0) || 0,
  };
}

export async function createPlanAction(
  _prev: ConsoleFormState,
  formData: FormData,
): Promise<ConsoleFormState> {
  let planId: string;
  try {
    const actor = await authorizeOperator("plan.write");
    const result = await createPlan(readPlan(formData), actor);
    if (!result.ok) return { error: result.error };
    planId = result.data.id;
  } catch (error) {
    return { error: describe(error) };
  }

  revalidatePath("/platform/plans");
  // Outside the try: `redirect` signals by throwing, and catching it here
  // would turn a successful save into "something went wrong".
  redirect(`/platform/plans/${planId}`);
}

export async function updatePlanAction(
  planId: string,
  _prev: ConsoleFormState,
  formData: FormData,
): Promise<ConsoleFormState> {
  try {
    const actor = await authorizeOperator("plan.write");
    const result = await updatePlan(planId, readPlan(formData), actor);
    if (!result.ok) return { error: result.error };

    revalidatePath("/platform/plans");
    revalidatePath(`/platform/plans/${planId}`);
    return { ok: true, message: "Plan saved." };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function deletePlanAction(
  planId: string,
  _prev: ConsoleFormState,
  _formData: FormData,
): Promise<ConsoleFormState> {
  try {
    const actor = await authorizeOperator("plan.write");
    const result = await deletePlan(planId, actor);
    if (!result.ok) return { error: result.error };
  } catch (error) {
    return { error: describe(error) };
  }

  revalidatePath("/platform/plans");
  redirect("/platform/plans");
}
