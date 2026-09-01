"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  openReceipt,
  scanIntoReceipt,
  closeReceipt,
  resolveDiscrepancy,
} from "@/lib/hub/receipt";
import type { ScanOutcome } from "@/lib/hub/scan";

/**
 * Inbound receipt actions.
 *
 * The scan action returns everything the screen needs and revalidates
 * nothing; the close action revalidates, because closing changes the
 * shape of the page entirely.
 */

export type OpenReceiptState = { error?: string };

const openSchema = z.object({
  manifestId: z.string().min(1),
  branchId: z.string().min(1),
  sealIntact: z.enum(["yes", "no", "unknown"]).default("unknown"),
});

export async function openInboundReceipt(
  _prev: OpenReceiptState,
  formData: FormData,
): Promise<OpenReceiptState> {
  let destination: string;

  try {
    const actor = await authorize("scan.inbound");

    const parsed = openSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) return { error: "Choose a manifest to receive." };

    const result = await openReceipt(
      {
        manifestId: parsed.data.manifestId,
        branchId: parsed.data.branchId,
        sealIntact:
          parsed.data.sealIntact === "unknown"
            ? null
            : parsed.data.sealIntact === "yes",
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath("/hub/inbound");
    destination = `/hub/inbound/${result.receiptId}`;
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to receive inbound freight." };
    }
    console.error("[hub/inbound open]", error);
    return { error: "Could not open the receipt." };
  }

  // Outside the try: redirect signals by throwing, and catching it here
  // would report a successful open as a failure.
  redirect(destination);
}

const scanSchema = z.object({
  receiptId: z.string().min(1),
  barcode: z.string().trim().min(1).max(120),
  idempotencyKey: z.string().uuid(),
  deviceId: z.string().nullish(),
  scannedAt: z.string().datetime().nullish(),
});

export type ReceiptScanActionResult =
  | {
      ok: true;
      outcome: ScanOutcome;
      line: { shipmentId: string; scannedPackages: number; expectedPackages: number } | null;
      scannedPackages: number;
    }
  | { ok: false; error: string };

export async function scanIntoInboundReceipt(
  input: z.input<typeof scanSchema>,
): Promise<ReceiptScanActionResult> {
  const parsed = scanSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Bad scan." };
  }

  try {
    const actor = await authorize("scan.inbound");

    const result = await scanIntoReceipt(
      {
        receiptId: parsed.data.receiptId,
        barcode: parsed.data.barcode,
        idempotencyKey: parsed.data.idempotencyKey,
        deviceId: parsed.data.deviceId ?? null,
        scannedAt: parsed.data.scannedAt ? new Date(parsed.data.scannedAt) : undefined,
      },
      actor,
    );

    if (!result.ok) return { ok: false, error: result.error };

    return {
      ok: true,
      outcome: result.result.outcome,
      line: result.result.line,
      scannedPackages: result.result.scannedPackages,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { ok: false, error: "You do not have permission to scan inbound." };
    }
    console.error("[hub/inbound scan]", error);
    return { ok: false, error: "The scan could not be recorded. Try again." };
  }
}

const closeSchema = z.object({
  receiptId: z.string().min(1),
  sealIntact: z.enum(["yes", "no", "unknown"]).default("unknown"),
  remarks: z.string().trim().max(500).optional(),
});

export type CloseReceiptState = {
  ok?: boolean;
  error?: string;
  summary?: string;
  warnings?: string[];
};

export async function closeInboundReceipt(
  _prev: CloseReceiptState,
  formData: FormData,
): Promise<CloseReceiptState> {
  try {
    const actor = await authorize("receipt.close");

    const parsed = closeSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) return { error: "Check the form." };

    const result = await closeReceipt(
      {
        receiptId: parsed.data.receiptId,
        sealIntact:
          parsed.data.sealIntact === "unknown"
            ? null
            : parsed.data.sealIntact === "yes",
        remarks: parsed.data.remarks ?? null,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    const { totals, isClean } = result.reconciliation;

    revalidatePath(`/hub/inbound/${parsed.data.receiptId}`);
    revalidatePath("/hub/inbound");
    revalidatePath("/hub");
    revalidatePath("/exceptions");

    const raised =
      result.exceptionNumbers.length > 0
        ? ` Exception${result.exceptionNumbers.length === 1 ? "" : "s"} ${result.exceptionNumbers.join(", ")} ${result.exceptionNumbers.length === 1 ? "is" : "are"} open in the control tower.`
        : "";

    return {
      ok: true,
      summary: isClean
        ? `Closed clean — all ${totals.expectedPackages} packages accounted for.${raised}`
        : `Closed with ${totals.shortPackages} short and ${totals.excessPackages} excess. ${result.discrepanciesRaised} discrepancy row${result.discrepanciesRaised === 1 ? "" : "s"} raised against the dispatching branch.${raised}`,
      warnings: result.warnings,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to close a receipt." };
    }
    console.error("[hub/inbound close]", error);
    return { error: "Could not close the receipt. Nothing was changed." };
  }
}

const resolveSchema = z.object({
  discrepancyId: z.string().min(1),
  resolution: z.string().trim().min(4, "Say what the outcome was").max(500),
});

export type ResolveState = { ok?: boolean; error?: string };

export async function resolveReceiptDiscrepancy(
  _prev: ResolveState,
  formData: FormData,
): Promise<ResolveState> {
  try {
    const actor = await authorize("discrepancy.resolve");

    const parsed = resolveSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Check the form." };
    }

    const result = await resolveDiscrepancy(parsed.data, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath("/hub");
    revalidatePath("/hub/inbound");
    // The Resolve control lives on the receipt page, and that page is the
    // one thing this used not to revalidate: the row went on saying "Open"
    // until somebody reloaded by hand, so the same discrepancy got settled
    // twice. Revalidated by route pattern, because the action is given a
    // discrepancy and not the receipt it belongs to.
    revalidatePath("/hub/inbound/[id]", "page");
    return { ok: true };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to resolve discrepancies." };
    }
    console.error("[hub/inbound resolve]", error);
    return { error: "Could not resolve that discrepancy." };
  }
}
