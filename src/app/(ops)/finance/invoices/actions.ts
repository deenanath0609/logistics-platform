"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  billableShipments,
  generateInvoice,
  issueInvoice,
  cancelInvoice,
  createCreditNote,
  runConsolidatedBilling,
} from "@/lib/billing/invoice";
import { createDebitNote } from "@/lib/billing/debit-note";
import type { FinanceActionState } from "../action-state";

const PATH = "/finance/invoices";

function guard(error: unknown): FinanceActionState {
  if (error instanceof PermissionError) {
    return { error: "You do not have permission to do that." };
  }
  console.error("[finance/invoices]", error);
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

/** End of the chosen day, so a shipment booked at 18:40 is included. */
function endOfDay(value: string): Date {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

const generateSchema = z.object({
  customerId: z.string().min(1, "Pick a customer"),
  branchId: z.string().min(1, "Pick a billing branch"),
  periodFrom: z.string().min(1, "Pick a start date"),
  periodTo: z.string().min(1, "Pick an end date"),
  deliveredOnly: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),
  notes: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(500).nullable(),
  ),
});

/**
 * Bills one customer for a window.
 *
 * The action re-selects the billable consignments rather than trusting a
 * list posted from the browser: between opening the dialog and submitting
 * it, another clerk may have billed half of them.
 */
export async function generateInvoiceAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("invoice.create");
    const parsed = generateSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const from = new Date(parsed.data.periodFrom);
    const to = endOfDay(parsed.data.periodTo);

    if (to < from) {
      return { error: "The period ends before it starts.", fieldErrors: { periodTo: "After the start date" } };
    }

    const shipments = await billableShipments(
      {
        customerId: parsed.data.customerId,
        from,
        to,
        deliveredOnly: parsed.data.deliveredOnly,
      },
      actor,
    );

    if (shipments.length === 0) {
      return {
        error:
          "Nothing billable for that customer in that window — either it is all billed already, " +
          "or the consignments are COD and To-Pay.",
      };
    }

    const result = await generateInvoice(
      {
        customerId: parsed.data.customerId,
        branchId: parsed.data.branchId,
        periodFrom: from,
        periodTo: to,
        shipmentIds: shipments.map((s) => s.id),
        notes: parsed.data.notes,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(PATH);
    return {
      ok: true,
      message: `${result.number} drafted from ${shipments.length} consignment(s).`,
      redirectTo: `${PATH}/${result.invoiceId}`,
    };
  } catch (error) {
    return guard(error);
  }
}

const runSchema = z.object({
  branchId: z.string().min(1, "Pick a billing branch"),
  periodFrom: z.string().min(1),
  periodTo: z.string().min(1),
  deliveredOnly: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),
  /**
   * On: one invoice per customer per originating branch. Off: everything a
   * customer moved goes on one document, raised from the branch above.
   */
  perBranch: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),
});

/** Consolidated monthly billing for every credit account. */
export async function runBillingAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("invoice.create");
    const parsed = runSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await runConsolidatedBilling(
      {
        from: new Date(parsed.data.periodFrom),
        to: endOfDay(parsed.data.periodTo),
        branchId: parsed.data.branchId,
        deliveredOnly: parsed.data.deliveredOnly,
        groupBy: parsed.data.perBranch ? "CUSTOMER_BRANCH" : "CUSTOMER",
      },
      actor,
    );

    revalidatePath(PATH);

    if (result.created.length === 0) {
      return {
        error: `No invoices raised. ${result.skipped.length} account(s) had nothing billable.`,
      };
    }

    const accounts = new Set(result.created.map((row) => row.customerId)).size;
    const branches = new Set(result.created.map((row) => row.branchId)).size;

    return {
      ok: true,
      message:
        `${result.created.length} draft invoice(s) raised across ${accounts} account(s)` +
        (parsed.data.perBranch ? ` and ${branches} branch(es)` : "") +
        (result.skipped.length > 0 ? `, ${result.skipped.length} skipped.` : "."),
    };
  } catch (error) {
    return guard(error);
  }
}

export async function issueInvoiceAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("invoice.approve");
    const invoiceId = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");

    if (!invoiceId) return { error: "Nothing selected." };
    if (!reason.trim()) {
      return {
        error: "A reason is required.",
        fieldErrors: { reason: "Approving an invoice is audited — say what you checked." },
      };
    }

    const result = await issueInvoice({ invoiceId, reason }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return { ok: true, message: `${result.number} issued.` };
  } catch (error) {
    return guard(error);
  }
}

export async function cancelInvoiceAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("invoice.cancel");
    const invoiceId = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");

    if (!invoiceId) return { error: "Nothing selected." };
    if (!reason.trim()) {
      return {
        error: "A reason is required.",
        fieldErrors: { reason: "Cancelling an invoice is audited." },
      };
    }

    const result = await cancelInvoice({ invoiceId, reason }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return { ok: true, message: `${result.number} cancelled.` };
  } catch (error) {
    return guard(error);
  }
}

export async function createCreditNoteAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("invoice.cancel");
    const invoiceId = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");
    const amount = Number(formData.get("amount") ?? 0);
    const taxAmount = Number(formData.get("taxAmount") ?? 0);

    if (!invoiceId) return { error: "Nothing selected." };
    if (!Number.isFinite(amount) || amount <= 0) {
      return { error: "Enter the amount to credit.", fieldErrors: { amount: "More than zero" } };
    }
    if (!reason.trim()) {
      return { error: "A reason is required.", fieldErrors: { reason: "Say why." } };
    }

    const result = await createCreditNote(
      { invoiceId, amount, taxAmount: Number.isFinite(taxAmount) ? taxAmount : 0, reason },
      actor,
    );
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return { ok: true, message: `Credit note ${result.number} raised.` };
  } catch (error) {
    return guard(error);
  }
}

/**
 * Raises a debit note against an issued invoice.
 *
 * The counterpart to the credit note above, and the correction an upward
 * weight revision calls for: an invoice that has left the building cannot
 * be edited, so the extra is billed on a supplementary document of its own.
 */
export async function createDebitNoteAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("invoice.create");
    const invoiceId = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");
    const amount = Number(formData.get("amount") ?? 0);
    const taxAmount = Number(formData.get("taxAmount") ?? 0);
    const shipmentId = String(formData.get("shipmentId") ?? "").trim();

    if (!invoiceId) return { error: "Nothing selected." };
    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        error: "Enter the additional taxable value.",
        fieldErrors: { amount: "More than zero — a reduction is a credit note." },
      };
    }
    if (!reason.trim()) {
      return {
        error: "A reason is required.",
        fieldErrors: { reason: "Say what moved — the customer will query it." },
      };
    }

    const result = await createDebitNote(
      {
        againstInvoiceId: invoiceId,
        shipmentId: shipmentId || null,
        amount,
        taxAmount: Number.isFinite(taxAmount) ? taxAmount : 0,
        reason,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return {
      ok: true,
      message: `Debit note ${result.number} raised.`,
      redirectTo: `${PATH}/${result.debitNoteId}`,
    };
  } catch (error) {
    return guard(error);
  }
}
