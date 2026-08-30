"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  createRateCard,
  createVersion,
  approveVersion,
  saveSlab,
  deleteSlab,
  saveChargeRule,
  deleteChargeRule,
  saveFuelRule,
  updateRateCard,
} from "@/lib/pricing/rate-cards";
import type { ChargeCondition } from "@/lib/pricing/engine";
import type { FinanceActionState } from "../action-state";
import type { ShipmentMode } from "@/generated/prisma/client";

const PATH = "/finance/rate-cards";

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

function guard(error: unknown): FinanceActionState {
  if (error instanceof PermissionError) {
    return { error: "You do not have permission to do that." };
  }
  console.error("[finance/rate-cards]", error);
  return { error: "Something went wrong. The change was not applied." };
}

const optionalText = (max = 200) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable(),
  );

const optionalNumber = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
  z.number().nullable(),
);

const cardSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "At least 2 characters")
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, hyphen and underscore only"),
  name: z.string().trim().min(2, "Required").max(120),
  customerId: optionalText(40),
  effectiveFrom: z.string().min(1, "Pick a start date"),
  notes: optionalText(500),
});

export async function createRateCardAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("ratecard.manage");
    const parsed = cardSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await createRateCard(
      {
        code: parsed.data.code,
        name: parsed.data.name,
        customerId: parsed.data.customerId,
        notes: parsed.data.notes,
        effectiveFrom: new Date(parsed.data.effectiveFrom),
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(PATH);
    return {
      ok: true,
      message: "Rate card created with a draft v1.",
      redirectTo: `${PATH}/${result.rateCardId}`,
    };
  } catch (error) {
    return guard(error);
  }
}

export async function updateRateCardAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("ratecard.manage");
    const rateCardId = String(formData.get("rateCardId") ?? "");
    if (!rateCardId) return { error: "Nothing selected." };

    const result = await updateRateCard(
      {
        rateCardId,
        name: String(formData.get("name") ?? "") || undefined,
        notes: (formData.get("notes") as string) ?? undefined,
        isActive: formData.get("isActive") === "true",
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${rateCardId}`);
    return { ok: true, message: "Rate card updated." };
  } catch (error) {
    return guard(error);
  }
}

const versionSchema = z.object({
  rateCardId: z.string().min(1),
  effectiveFrom: z.string().min(1, "Pick a start date"),
  effectiveTo: optionalText(20),
  copyFromVersionId: optionalText(40),
  notes: optionalText(500),
});

export async function createVersionAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("ratecard.manage");
    const parsed = versionSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await createVersion(
      {
        rateCardId: parsed.data.rateCardId,
        effectiveFrom: new Date(parsed.data.effectiveFrom),
        effectiveTo: parsed.data.effectiveTo ? new Date(parsed.data.effectiveTo) : null,
        copyFromVersionId: parsed.data.copyFromVersionId,
        notes: parsed.data.notes,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${parsed.data.rateCardId}`);
    return {
      ok: true,
      message:
        result.copiedSlabs > 0
          ? `Draft v${result.version} opened with ${result.copiedSlabs} slab(s) copied forward.`
          : `Draft v${result.version} opened.`,
    };
  } catch (error) {
    return guard(error);
  }
}

/** Sensitive: freezes the version, and is audited with the reason given. */
export async function approveVersionAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("ratecard.manage");
    const versionId = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");

    if (!versionId) return { error: "Nothing selected." };
    if (!reason.trim()) {
      return {
        error: "A reason is required.",
        fieldErrors: { reason: "Say what changed and who agreed it." },
      };
    }

    const result = await approveVersion({ versionId, reason }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH);
    return {
      ok: true,
      message: `${result.label} approved. It is now frozen — invoices will reference it.`,
    };
  } catch (error) {
    return guard(error);
  }
}

const slabSchema = z.object({
  id: optionalText(40),
  versionId: z.string().min(1),
  serviceTypeId: optionalText(40),
  mode: optionalText(20),
  originZoneId: optionalText(40),
  destinationZoneId: optionalText(40),
  originCityId: optionalText(40),
  destinationCityId: optionalText(40),
  vehicleTypeId: optionalText(40),
  weightFromKg: optionalNumber,
  weightToKg: optionalNumber,
  basis: z.enum(["PER_KG", "PER_PACKAGE", "FLAT", "PER_KM", "PER_TRIP", "PER_VEHICLE"]),
  rate: z.preprocess((v) => Number(v), z.number().min(0, "Rate cannot be negative")),
  minimumCharge: optionalNumber,
  minimumChargeableKg: optionalNumber,
  transitHours: optionalNumber,
  priority: z.preprocess((v) => (v === "" || v == null ? 0 : Number(v)), z.number().int()),
});

export async function saveSlabAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("ratecard.manage");
    const parsed = slabSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await saveSlab(
      {
        ...parsed.data,
        mode: (parsed.data.mode as ShipmentMode | null) ?? null,
        transitHours: parsed.data.transitHours ?? null,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return { ok: true, message: parsed.data.id ? "Slab updated." : "Slab added." };
  } catch (error) {
    return guard(error);
  }
}

export async function deleteSlabAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("ratecard.manage");
    const slabId = String(formData.get("id") ?? "");
    if (!slabId) return { error: "Nothing selected." };

    const result = await deleteSlab({ slabId }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return { ok: true, message: "Slab removed." };
  } catch (error) {
    return guard(error);
  }
}

const ruleSchema = z.object({
  id: optionalText(40),
  versionId: z.string().min(1),
  chargeTypeId: z.string().min(1, "Pick a charge head"),
  basis: z.enum([
    "FLAT",
    "PER_KG",
    "PER_PACKAGE",
    "PER_KM",
    "PER_HOUR",
    "PERCENT_OF_FREIGHT",
    "PERCENT_OF_DECLARED_VALUE",
    "PERCENT_OF_COD",
  ]),
  rate: z.preprocess((v) => Number(v), z.number().min(0)),
  minimumAmount: optionalNumber,
  maximumAmount: optionalNumber,
  sortOrder: z.preprocess((v) => (v === "" || v == null ? 0 : Number(v)), z.number().int()),
  isAutomatic: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),
  // The condition vocabulary the engine understands, posted as flags.
  odaOnly: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),
  codOnly: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),
  requiresDeclaredValue: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),
  fragileOnly: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),
});

export async function saveChargeRuleAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("ratecard.manage");
    const parsed = ruleSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    // Only the flags actually set are stored, so the trace names a real
    // condition rather than reciting four "false"s on every rule.
    const appliesWhen: ChargeCondition = {};
    if (parsed.data.odaOnly) appliesWhen.odaOnly = true;
    if (parsed.data.codOnly) appliesWhen.codOnly = true;
    if (parsed.data.requiresDeclaredValue) appliesWhen.requiresDeclaredValue = true;
    if (parsed.data.fragileOnly) appliesWhen.fragileOnly = true;

    const result = await saveChargeRule(
      {
        id: parsed.data.id,
        versionId: parsed.data.versionId,
        chargeTypeId: parsed.data.chargeTypeId,
        basis: parsed.data.basis,
        rate: parsed.data.rate,
        minimumAmount: parsed.data.minimumAmount,
        maximumAmount: parsed.data.maximumAmount,
        sortOrder: parsed.data.sortOrder,
        isAutomatic: parsed.data.isAutomatic,
        appliesWhen: Object.keys(appliesWhen).length > 0 ? appliesWhen : null,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return { ok: true, message: parsed.data.id ? "Charge rule updated." : "Charge rule added." };
  } catch (error) {
    return guard(error);
  }
}

export async function deleteChargeRuleAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("ratecard.manage");
    const ruleId = String(formData.get("id") ?? "");
    if (!ruleId) return { error: "Nothing selected." };

    const result = await deleteChargeRule({ ruleId }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return { ok: true, message: "Charge rule removed." };
  } catch (error) {
    return guard(error);
  }
}

const fuelSchema = z.object({
  percent: z.preprocess((v) => Number(v), z.number().min(0).max(100)),
  effectiveFrom: z.string().min(1, "Pick a start date"),
  effectiveTo: optionalText(20),
  notes: optionalText(300),
});

export async function saveFuelRuleAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("ratecard.manage");
    const parsed = fuelSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await saveFuelRule(
      {
        percent: parsed.data.percent,
        effectiveFrom: new Date(parsed.data.effectiveFrom),
        effectiveTo: parsed.data.effectiveTo ? new Date(parsed.data.effectiveTo) : null,
        notes: parsed.data.notes,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(PATH);
    return {
      ok: true,
      message: "Fuel surcharge saved. Every shipment priced from that date moves.",
    };
  } catch (error) {
    return guard(error);
  }
}
