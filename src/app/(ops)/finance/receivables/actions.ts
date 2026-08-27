"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { recordAudit } from "@/server/services/audit";
import { recordPayment, allocateOnAccount } from "@/lib/billing/receivables";
import type { FinanceActionState } from "../action-state";

const PATH = "/finance/receivables";

function guard(error: unknown): FinanceActionState {
  if (error instanceof PermissionError) {
    return { error: "You do not have permission to do that." };
  }
  console.error("[finance/receivables]", error);
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

const paymentSchema = z.object({
  customerId: z.string().min(1),
  amount: z.preprocess((v) => Number(v), z.number().positive("Enter the amount received")),
  tdsAmount: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? 0 : Number(v)),
    z.number().min(0),
  ),
  mode: z.enum(["CASH", "CHEQUE", "NEFT", "RTGS", "UPI", "CARD", "ADJUSTMENT"]),
  reference: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(80).nullable(),
  ),
  receivedOn: z.string().min(1, "Pick the date it was received"),
  /** Blank means settle oldest-first, which is what a round figure means. */
  invoiceId: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().nullable(),
  ),
  notes: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(300).nullable(),
  ),
});

export async function recordPaymentAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("payment.record");
    const parsed = paymentSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await recordPayment(
      {
        customerId: parsed.data.customerId,
        amount: parsed.data.amount,
        tdsAmount: parsed.data.tdsAmount,
        mode: parsed.data.mode,
        reference: parsed.data.reference,
        receivedOn: new Date(parsed.data.receivedOn),
        notes: parsed.data.notes,
        allocations: parsed.data.invoiceId
          ? [
              {
                invoiceId: parsed.data.invoiceId,
                amount: parsed.data.amount + parsed.data.tdsAmount,
              },
            ]
          : undefined,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    revalidatePath("/finance/invoices", "layout");

    return {
      ok: true,
      message: result.unallocated.greaterThan(0)
        ? `${result.number} recorded. ₹${result.unallocated.toFixed(2)} is sitting on account.`
        : `${result.number} recorded and fully applied.`,
    };
  } catch (error) {
    return guard(error);
  }
}

export async function allocateOnAccountAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("payment.record");
    const paymentId = String(formData.get("id") ?? "");
    const invoiceId = String(formData.get("invoiceId") ?? "");
    const amount = Number(formData.get("amount") ?? 0);

    if (!paymentId || !invoiceId) return { error: "Pick a payment and an invoice." };
    if (!Number.isFinite(amount) || amount <= 0) {
      return { error: "Enter an amount.", fieldErrors: { amount: "More than zero" } };
    }

    const result = await allocateOnAccount(
      { paymentId, allocations: [{ invoiceId, amount }] },
      actor,
    );
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return { ok: true, message: "Applied." };
  } catch (error) {
    return guard(error);
  }
}

const creditSchema = z.object({
  customerId: z.string().min(1),
  creditLimit: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().min(0).nullable(),
  ),
  creditDays: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().int().min(0).max(365).nullable(),
  ),
  isBlocked: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),
  blockReason: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(200).nullable(),
  ),
});

/**
 * Sets the limit that blocks bookings.
 *
 * Separately permissioned from editing the account, because this is the
 * control that decides how much of the company's money a customer may be
 * holding at any moment.
 */
export async function setCreditTermsAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("customer.manage_credit");
    const parsed = creditSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    if (parsed.data.isBlocked && !parsed.data.blockReason) {
      return {
        error: "Say why the account is being blocked.",
        fieldErrors: { blockReason: "A blocked account needs a reason on it." },
      };
    }

    const before = await prisma.customer.findUnique({
      where: { id: parsed.data.customerId },
      select: {
        code: true,
        creditLimit: true,
        creditDays: true,
        isBlocked: true,
        blockReason: true,
        branchId: true,
      },
    });
    if (!before) return { error: "That customer no longer exists." };

    await prisma.customer.update({
      where: { id: parsed.data.customerId },
      data: {
        creditLimit: parsed.data.creditLimit,
        creditDays: parsed.data.creditDays,
        isBlocked: parsed.data.isBlocked,
        blockReason: parsed.data.isBlocked ? parsed.data.blockReason : null,
      },
    });

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "Customer",
      entityId: parsed.data.customerId,
      entityRef: before.code,
      branchId: before.branchId,
      before: {
        creditLimit: before.creditLimit?.toString() ?? null,
        creditDays: before.creditDays,
        isBlocked: before.isBlocked,
        blockReason: before.blockReason,
      },
      after: {
        creditLimit: parsed.data.creditLimit,
        creditDays: parsed.data.creditDays,
        isBlocked: parsed.data.isBlocked,
        blockReason: parsed.data.blockReason,
      },
      reason: "Credit terms revised.",
    });

    revalidatePath(PATH, "layout");
    revalidatePath("/customers", "layout");

    return { ok: true, message: "Credit terms updated." };
  } catch (error) {
    return guard(error);
  }
}
