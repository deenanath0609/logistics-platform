"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { recordAudit, changedFields } from "@/server/services/audit";
import type { ActionState } from "@/server/services/master-crud";

const PATH = "/customers";

const optionalText = (max = 200) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable(),
  );

const schema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "At least 2 characters")
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, hyphen and underscore only")
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2, "Required").max(120),
  legalName: optionalText(160),
  type: z.enum(["CORPORATE", "RETAIL", "WALK_IN"]),
  branchId: optionalText(40),
  phone: z.string().trim().regex(/^\d{10}$/, "Ten digits"),
  altPhone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().regex(/^\d{10}$/, "Ten digits").nullable(),
  ),
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().email("Enter a valid email").nullable(),
  ),
  // 15 characters: 2 state + 10 PAN + 1 entity + 1 'Z' + 1 check digit.
  gstin: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : String(v).toUpperCase()),
    z
      .string()
      .regex(
        /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/,
        "That is not a valid GSTIN",
      )
      .nullable(),
  ),
  pan: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : String(v).toUpperCase()),
    z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, "That is not a valid PAN").nullable(),
  ),
  billingAddress: optionalText(300),
  billingCityId: optionalText(40),
  billingPincode: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().regex(/^\d{6}$/, "Six digits").nullable(),
  ),
  paymentTerm: z.enum(["PREPAID", "CREDIT", "CASH"]),
  creditLimit: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().min(0).nullable(),
  ),
  creditDays: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().int().min(0).max(365).nullable(),
  ),
  notes: optionalText(500),
  isActive: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),
});

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

function describe(error: unknown): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to manage customers.";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unique constraint")) {
    return "Another customer already uses that code.";
  }
  console.error("[customers]", error);
  return "Something went wrong. The change was not applied.";
}

export async function createCustomer(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("customer.create");

    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const data = parsed.data;

    // Credit terms are a money decision, gated separately from creating
    // the account itself.
    if (
      (data.paymentTerm === "CREDIT" || data.creditLimit) &&
      !actor.permissions.has("customer.manage_credit")
    ) {
      return {
        error: "Setting credit terms needs the credit permission. Save the customer as Cash and ask accounts to set the limit.",
        fieldErrors: { paymentTerm: "Not permitted" },
      };
    }

    const branchId = data.branchId ?? actor.primaryBranch?.id ?? null;
    if (branchId && !coversBranch(actor, branchId)) {
      return { error: "That branch is outside your scope.", fieldErrors: { branchId: "Out of scope" } };
    }

    const created = await prisma.customer.create({
      data: { ...data, branchId, orgId: actor.orgId, createdById: actor.id },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Customer",
      entityId: created.id,
      entityRef: created.code,
      branchId: created.branchId,
      after: created,
    });

    revalidatePath(PATH);
    return { ok: true, message: `${created.name} added.` };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function updateCustomer(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("customer.update");

    const id = String(formData.get("id") ?? "");
    if (!id) return { error: "Nothing selected to update." };

    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const before = await prisma.customer.findUnique({ where: { id } });
    if (!before) return { error: "That customer no longer exists." };
    if (before.branchId && !coversBranch(actor, before.branchId)) {
      return { error: "That customer is outside your scope." };
    }

    const data = parsed.data;
    const creditChanged =
      String(before.creditLimit ?? "") !== String(data.creditLimit ?? "") ||
      before.creditDays !== data.creditDays ||
      before.paymentTerm !== data.paymentTerm;

    if (creditChanged && !actor.permissions.has("customer.manage_credit")) {
      return {
        error: "Changing credit terms needs the credit permission.",
        fieldErrors: { paymentTerm: "Not permitted" },
      };
    }

    const after = await prisma.customer.update({ where: { id }, data });
    const diff = changedFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );

    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        user: actor,
        action: "UPDATE",
        entity: "Customer",
        entityId: id,
        entityRef: after.code,
        branchId: after.branchId,
        before: diff.before,
        after: diff.after,
      });
    }

    revalidatePath(PATH);
    return { ok: true, message: `${after.name} updated.` };
  } catch (error) {
    return { error: describe(error) };
  }
}

const addressSchema = z.object({
  customerId: z.string().min(1),
  label: z.string().trim().min(1, "Required").max(60),
  kind: z.enum(["PICKUP", "DELIVERY", "BILLING"]),
  contactName: optionalText(120),
  phone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().regex(/^\d{10}$/, "Ten digits").nullable(),
  ),
  address: z.string().trim().min(4, "Required").max(300),
  cityId: z.string().min(1, "Choose a city"),
  pincode: z.string().trim().regex(/^\d{6}$/, "Six digits"),
  landmark: optionalText(120),
  isDefault: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),
});

export async function saveCustomerAddress(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("customer.update");

    const parsed = addressSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const id = String(formData.get("id") ?? "");
    const data = parsed.data;

    const saved = id
      ? await prisma.customerAddress.update({ where: { id }, data })
      : await prisma.customerAddress.create({ data });

    // Only one default per kind, or the booking screen has to guess.
    if (data.isDefault) {
      await prisma.customerAddress.updateMany({
        where: {
          customerId: data.customerId,
          kind: data.kind,
          id: { not: saved.id },
        },
        data: { isDefault: false },
      });
    }

    await recordAudit({
      user: actor,
      action: id ? "UPDATE" : "CREATE",
      entity: "CustomerAddress",
      entityId: saved.id,
      entityRef: saved.label,
      after: saved,
    });

    revalidatePath(`${PATH}/${data.customerId}`);
    return { ok: true, message: id ? "Address updated." : "Address added." };
  } catch (error) {
    return { error: describe(error) };
  }
}
