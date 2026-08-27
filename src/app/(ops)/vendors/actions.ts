"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { recordAudit, changedFields } from "@/server/services/audit";
import {
  createVendorBill,
  approveVendorBill,
  disputeVendorBill,
  recordVendorPayment,
} from "@/lib/billing/vendor";
import type { FinanceActionState } from "../finance/action-state";

const PATH = "/vendors";

function guard(error: unknown): FinanceActionState {
  if (error instanceof PermissionError) {
    return { error: "You do not have permission to do that." };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unique constraint")) {
    return { error: "Another vendor already uses that code." };
  }
  console.error("[vendors]", error);
  return { error: "Something went wrong. Nothing was saved." };
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
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

const vendorSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "At least 2 characters")
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, hyphen and underscore only")
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2, "Required").max(120),
  legalName: optionalText(160),
  kind: z.enum(["TRANSPORTER", "BROKER", "ATTACHED_OWNER", "SERVICE"]),
  phone: z.string().trim().regex(/^\d{10}$/, "Ten digits"),
  email: optionalText(120),
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
  address: optionalText(300),
  paymentTermDays: optionalNumber,
  tdsPercent: optionalNumber,
  notes: optionalText(500),
});

export async function createVendorAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("vendor.create");
    const parsed = vendorSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const created = await prisma.vendor.create({
      data: { orgId: actor.orgId, ...parsed.data },
      select: { id: true, code: true },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Vendor",
      entityId: created.id,
      entityRef: created.code,
      after: parsed.data,
    });

    revalidatePath(PATH);
    return { ok: true, message: "Vendor created.", redirectTo: `${PATH}/${created.id}` };
  } catch (error) {
    return guard(error);
  }
}

export async function updateVendorAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("vendor.update");
    const id = String(formData.get("id") ?? "");
    if (!id) return { error: "Nothing selected." };

    const parsed = vendorSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const before = await prisma.vendor.findUnique({ where: { id } });
    if (!before) return { error: "That vendor no longer exists." };

    const after = await prisma.vendor.update({ where: { id }, data: parsed.data });
    const diff = changedFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );

    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        user: actor,
        action: "UPDATE",
        entity: "Vendor",
        entityId: id,
        entityRef: before.code,
        before: diff.before,
        after: diff.after,
      });
    }

    revalidatePath(`${PATH}/${id}`);
    return { ok: true, message: "Vendor updated." };
  } catch (error) {
    return guard(error);
  }
}

const bankSchema = z.object({
  vendorId: z.string().min(1),
  accountName: z.string().trim().min(2, "Required").max(120),
  accountNumber: z.string().trim().min(6, "Too short").max(24),
  ifsc: z
    .string()
    .trim()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/i, "That is not a valid IFSC")
    .transform((v) => v.toUpperCase()),
  bankName: optionalText(120),
  isPrimary: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),
});

export async function saveBankAccountAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("vendor.update");
    const parsed = bankSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const created = await prisma.$transaction(async (tx) => {
      if (parsed.data.isPrimary) {
        await tx.vendorBankAccount.updateMany({
          where: { vendorId: parsed.data.vendorId },
          data: { isPrimary: false },
        });
      }
      return tx.vendorBankAccount.create({
        data: parsed.data,
        select: { id: true, accountNumber: true },
      });
    });

    // The account number is the payment instruction — the audit trail
    // records that it changed and who did it, with only the tail visible.
    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "VendorBankAccount",
      entityId: created.id,
      entityRef: `••••${created.accountNumber.slice(-4)}`,
      after: {
        accountName: parsed.data.accountName,
        ifsc: parsed.data.ifsc,
        bankName: parsed.data.bankName,
        isPrimary: parsed.data.isPrimary,
      },
      reason: "Vendor bank details added — payments will be sent here.",
    });

    revalidatePath(`${PATH}/${parsed.data.vendorId}`);
    return { ok: true, message: "Bank account saved." };
  } catch (error) {
    return guard(error);
  }
}

const contractSchema = z.object({
  vendorId: z.string().min(1),
  code: z.string().trim().min(2, "Required").max(20).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2, "Required").max(120),
  effectiveFrom: z.string().min(1, "Pick a start date"),
  effectiveTo: optionalText(20),
});

export async function createRateContractAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("vendor.update");
    const parsed = contractSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const created = await prisma.vendorRateContract.create({
      data: {
        vendorId: parsed.data.vendorId,
        code: parsed.data.code,
        name: parsed.data.name,
        effectiveFrom: new Date(parsed.data.effectiveFrom),
        effectiveTo: parsed.data.effectiveTo ? new Date(parsed.data.effectiveTo) : null,
      },
      select: { id: true, code: true },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "VendorRateContract",
      entityId: created.id,
      entityRef: created.code,
      after: parsed.data,
    });

    revalidatePath(`${PATH}/${parsed.data.vendorId}`);
    return { ok: true, message: "Rate contract created. Add lanes to it next." };
  } catch (error) {
    return guard(error);
  }
}

const rateLineSchema = z.object({
  contractId: z.string().min(1),
  vendorId: z.string().min(1),
  originBranchId: optionalText(40),
  destinationBranchId: optionalText(40),
  vehicleTypeId: optionalText(40),
  basis: z.enum(["PER_TRIP", "PER_KM", "PER_KG", "PER_PACKAGE", "FLAT", "PER_VEHICLE"]),
  rate: z.preprocess((v) => Number(v), z.number().min(0)),
  minimumAmount: optionalNumber,
});

export async function saveRateLineAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("vendor.update");
    const parsed = rateLineSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const created = await prisma.vendorRateLine.create({
      data: {
        contractId: parsed.data.contractId,
        originBranchId: parsed.data.originBranchId,
        destinationBranchId: parsed.data.destinationBranchId,
        vehicleTypeId: parsed.data.vehicleTypeId,
        basis: parsed.data.basis,
        rate: String(parsed.data.rate),
        minimumAmount:
          parsed.data.minimumAmount === null ? null : String(parsed.data.minimumAmount),
      },
      select: { id: true },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "VendorRateLine",
      entityId: created.id,
      entityRef: `${parsed.data.basis} @ ${parsed.data.rate}`,
      after: parsed.data,
    });

    revalidatePath(`${PATH}/${parsed.data.vendorId}`);
    return { ok: true, message: "Lane rate added." };
  } catch (error) {
    return guard(error);
  }
}

const billSchema = z.object({
  vendorId: z.string().min(1),
  billDate: z.string().min(1, "Pick the bill date"),
  tripId: optionalText(40),
  description: z.string().trim().min(2, "Say what is being billed").max(200),
  amount: z.preprocess((v) => Number(v), z.number().positive("Enter the amount")),
  taxPercent: optionalNumber,
  deductions: optionalNumber,
  advanceAdjusted: optionalNumber,
  notes: optionalText(400),
});

export async function createVendorBillAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("expense.record");
    const parsed = billSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await createVendorBill(
      {
        vendorId: parsed.data.vendorId,
        billDate: new Date(parsed.data.billDate),
        lines: [
          {
            tripId: parsed.data.tripId,
            description: parsed.data.description,
            amount: parsed.data.amount,
            taxPercent: parsed.data.taxPercent,
          },
        ],
        deductions: parsed.data.deductions,
        advanceAdjusted: parsed.data.advanceAdjusted,
        notes: parsed.data.notes,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${parsed.data.vendorId}`);
    return {
      ok: true,
      message:
        result.variance && !result.variance.isZero()
          ? `${result.number} raised — it differs from the contract by ₹${result.variance.toFixed(2)}. Check before approving.`
          : `${result.number} raised.`,
    };
  } catch (error) {
    return guard(error);
  }
}

export async function approveVendorBillAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("settlement.approve");
    const billId = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");

    if (!billId) return { error: "Nothing selected." };
    if (!reason.trim()) {
      return {
        error: "A reason is required.",
        fieldErrors: { reason: "Say what you checked, and how any variance was settled." },
      };
    }

    // A variance is accepted explicitly, in the same act that records why.
    const result = await approveVendorBill(
      { billId, reason, acceptVariance: true },
      actor,
    );
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return { ok: true, message: `${result.number} approved for payment.` };
  } catch (error) {
    return guard(error);
  }
}

export async function disputeVendorBillAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("expense.approve");
    const billId = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");

    if (!billId) return { error: "Nothing selected." };
    if (!reason.trim()) {
      return { error: "Say what is disputed.", fieldErrors: { reason: "Required." } };
    }

    const result = await disputeVendorBill({ billId, reason }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return { ok: true, message: "Bill parked as disputed." };
  } catch (error) {
    return guard(error);
  }
}

const vendorPaymentSchema = z.object({
  vendorId: z.string().min(1),
  amount: z.preprocess((v) => Number(v), z.number().positive("Enter the amount")),
  mode: z.enum(["CASH", "CHEQUE", "NEFT", "RTGS", "UPI", "CARD", "ADJUSTMENT"]),
  reference: optionalText(80),
  paidOn: z.string().min(1, "Pick the date"),
  notes: optionalText(300),
});

export async function recordVendorPaymentAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("payment.record");
    const parsed = vendorPaymentSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await recordVendorPayment(
      {
        vendorId: parsed.data.vendorId,
        amount: parsed.data.amount,
        mode: parsed.data.mode,
        reference: parsed.data.reference,
        paidOn: new Date(parsed.data.paidOn),
        notes: parsed.data.notes,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${parsed.data.vendorId}`);
    return { ok: true, message: `${result.number} recorded and applied to the oldest bills.` };
  } catch (error) {
    return guard(error);
  }
}
