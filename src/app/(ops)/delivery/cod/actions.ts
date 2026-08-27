"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import { createCodDeposit, verifyCodDeposit } from "@/lib/delivery/cod";
import { recordAudit } from "@/server/services/audit";

const PATH = "/delivery/cod";

export type CodActionState = {
  error?: string;
  message?: string;
};

function describe(error: unknown): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to do that.";
  }
  console.error("[delivery/cod]", error);
  return "Something went wrong. No money was moved.";
}

function localDay(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

const depositSchema = z.object({
  branchId: z.string().min(1),
  agentId: z.string().min(1),
  depositDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountDeclared: z.coerce.number().positive("Enter the amount handed over"),
  mode: z.enum(["CASH", "UPI", "CARD", "CHEQUE", "BANK_TRANSFER"]),
  reference: z.string().trim().max(120).optional(),
  remarks: z.string().trim().max(300).optional(),
});

/** The agent hands the cash in. */
export async function depositAction(
  _prev: CodActionState,
  formData: FormData,
): Promise<CodActionState> {
  try {
    const actor = await authorize("cod.deposit");
    const parsed = depositSchema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Check the amount." };
    }

    const result = await createCodDeposit(
      {
        branchId: parsed.data.branchId,
        agentId: parsed.data.agentId,
        depositDate: localDay(parsed.data.depositDate),
        amountDeclared: parsed.data.amountDeclared,
        mode: parsed.data.mode,
        reference: parsed.data.reference || null,
        remarks: parsed.data.remarks || null,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "CodDeposit",
      entityId: result.depositId,
      branchId: parsed.data.branchId,
      after: {
        agentId: parsed.data.agentId,
        amountDeclared: parsed.data.amountDeclared,
        shortfall: result.shortfall,
      },
      reason: Number(result.shortfall) !== 0 ? "Shortfall at day end" : undefined,
    });

    revalidatePath(PATH);

    return {
      message:
        Number(result.shortfall) === 0
          ? "Deposit recorded in full."
          : `Deposit recorded. ₹${result.shortfall} short of what was collected — an exception has been raised.`,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

const verifySchema = z.object({
  depositId: z.string().min(1),
  amountVerified: z.coerce.number().nonnegative("Enter the amount counted"),
  remarks: z.string().trim().max(300).optional(),
});

/** The branch counts what was handed in. */
export async function verifyDepositAction(
  _prev: CodActionState,
  formData: FormData,
): Promise<CodActionState> {
  try {
    const actor = await authorize("cod.reconcile");
    const parsed = verifySchema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Check the amount." };
    }

    const result = await verifyCodDeposit(
      parsed.data.depositId,
      parsed.data.amountVerified,
      actor,
      parsed.data.remarks || null,
    );

    if (!result.ok) return { error: result.error };

    await recordAudit({
      user: actor,
      action: result.disputed ? "OVERRIDE" : "APPROVE",
      entity: "CodDeposit",
      entityId: parsed.data.depositId,
      after: { amountVerified: parsed.data.amountVerified, shortfall: result.shortfall },
      reason: result.disputed ? `Counted ₹${result.shortfall} short` : undefined,
    });

    revalidatePath(PATH);

    return {
      message: result.disputed
        ? `Counted ₹${result.shortfall} short. The deposit is disputed and stays open.`
        : "Counted and reconciled.",
    };
  } catch (error) {
    return { error: describe(error) };
  }
}
