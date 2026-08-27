"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { COLUMN_BY_FIELD } from "@/lib/bulk/columns";
import {
  abandonBatch,
  createBulkBatch,
  revalidateBatch,
  updateBatchRow,
} from "@/lib/bulk/batch";
import { commitBatch } from "@/lib/bulk/commit";
import type { ActionState } from "@/server/services/master-crud";

const PATH = "/shipments/bulk";

export type UploadState = ActionState & {
  missingHeaders?: string[];
};

export type CommitState = ActionState & {
  summary?: {
    committed: number;
    alreadyBooked: number;
    failed: number;
    stillInvalid: number;
    lrNumbers: string[];
    failures: Array<{ rowNumber: number; error: string }>;
  };
};

function describe(error: unknown, fallback: string): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to do that.";
  }
  console.error("[bulk]", error);
  return fallback;
}

// ────────────────────────────────────────────────────────────
// Upload
// ────────────────────────────────────────────────────────────

export async function uploadBulkFile(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  let destination: string;

  try {
    const actor = await authorize("shipment.bulk_upload");

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { error: "Choose a CSV or XLSX file to upload." };
    }

    const branchId = String(formData.get("branchId") ?? "").trim();
    if (!branchId) return { error: "Choose the branch to book against." };
    if (!coversBranch(actor, branchId)) {
      return { error: "That branch is outside the branches you cover." };
    }

    const result = await createBulkBatch(
      {
        fileName: file.name,
        contentType: file.type || "text/csv",
        bytes: Buffer.from(await file.arrayBuffer()),
        branchId,
      },
      actor,
    );

    if (!result.ok) {
      return { error: result.error, missingHeaders: result.missingHeaders };
    }

    revalidatePath(PATH);
    destination = `${PATH}/${result.batchId}`;
  } catch (error) {
    return { error: describe(error, "The file could not be read.") };
  }

  // Outside the try: `redirect` signals by throwing, and catching it here
  // would turn a successful upload into an error message.
  redirect(destination);
}

// ────────────────────────────────────────────────────────────
// Inline correction
// ────────────────────────────────────────────────────────────

const rowSchema = z.object({
  batchId: z.string().min(1),
  rowNumber: z.coerce.number().int().positive(),
});

export async function saveBulkRow(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("shipment.bulk_upload");

    const parsed = rowSchema.safeParse({
      batchId: formData.get("batchId"),
      rowNumber: formData.get("rowNumber"),
    });
    if (!parsed.success) return { error: "That row could not be identified." };

    // Only declared columns are writable. Anything else in the form is a
    // control field, not data.
    const patch: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("cell:")) continue;
      const field = key.slice("cell:".length);
      if (!COLUMN_BY_FIELD.has(field)) continue;
      patch[field] = typeof value === "string" ? value : "";
    }

    if (Object.keys(patch).length === 0) {
      return { error: "Nothing was changed." };
    }

    const updated = await updateBatchRow(
      { batchId: parsed.data.batchId, rowNumber: parsed.data.rowNumber, patch },
      actor,
    );
    if (!updated.ok) return { error: updated.error };

    const revalidated = await revalidateBatch(parsed.data.batchId, actor);
    if (!revalidated.ok) return { error: revalidated.error };

    const row = revalidated.summary.rows.find(
      (r) => r.rowNumber === parsed.data.rowNumber,
    );

    revalidatePath(`${PATH}/${parsed.data.batchId}`);

    if (row && Object.keys(row.errors).length > 0) {
      return {
        ok: false,
        error: `Row ${parsed.data.rowNumber} still has ${Object.keys(row.errors).length} problem(s).`,
        fieldErrors: row.errors,
      };
    }

    return { ok: true, message: `Row ${parsed.data.rowNumber} is ready to book.` };
  } catch (error) {
    return { error: describe(error, "That correction could not be saved.") };
  }
}

export async function revalidateBulkBatch(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("shipment.bulk_upload");
    const batchId = String(formData.get("batchId") ?? "");
    if (!batchId) return { error: "That batch could not be identified." };

    const result = await revalidateBatch(batchId, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${batchId}`);
    return {
      ok: true,
      message: `${result.summary.validCount} ready, ${result.summary.invalidCount} still to fix.`,
    };
  } catch (error) {
    return { error: describe(error, "The batch could not be re-checked.") };
  }
}

// ────────────────────────────────────────────────────────────
// Commit
// ────────────────────────────────────────────────────────────

export async function commitBulkBatch(
  _prev: CommitState,
  formData: FormData,
): Promise<CommitState> {
  try {
    // Booking is the act being performed, so it is the permission that
    // matters — uploading a file is not authority to create consignments.
    const actor = await authorize("shipment.bulk_upload");
    await authorize("shipment.create");

    const batchId = String(formData.get("batchId") ?? "");
    if (!batchId) return { error: "That batch could not be identified." };

    const only = String(formData.get("rowNumbers") ?? "").trim();
    const rowNumbers =
      only === ""
        ? undefined
        : only
            .split(",")
            .map((n) => Number(n.trim()))
            .filter((n) => Number.isInteger(n) && n > 0);

    const result = await commitBatch({ batchId, rowNumbers }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${batchId}`);
    revalidatePath("/shipments");

    const message =
      result.committed === 0 && result.alreadyBooked > 0
        ? `Nothing new to book — those ${result.alreadyBooked} rows were already booked.`
        : `Booked ${result.committed} of ${result.attempted}.` +
          (result.alreadyBooked > 0
            ? ` ${result.alreadyBooked} were already booked and were not repeated.`
            : "") +
          (result.stillInvalid > 0 ? ` ${result.stillInvalid} still need fixing.` : "");

    return {
      ok: true,
      message,
      summary: {
        committed: result.committed,
        alreadyBooked: result.alreadyBooked,
        failed: result.failed,
        stillInvalid: result.stillInvalid,
        lrNumbers: result.outcomes
          .filter((o) => o.lrNumber)
          .map((o) => o.lrNumber!)
          .slice(0, 20),
        failures: result.outcomes
          .filter((o) => o.status === "failed")
          .map((o) => ({ rowNumber: o.rowNumber, error: o.error ?? "Failed" })),
      },
    };
  } catch (error) {
    return { error: describe(error, "The batch could not be committed.") };
  }
}

export async function abandonBulkBatch(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("shipment.bulk_upload");
    const batchId = String(formData.get("batchId") ?? "");
    if (!batchId) return { error: "That batch could not be identified." };

    await abandonBatch(batchId, actor);
    revalidatePath(PATH);
    revalidatePath(`${PATH}/${batchId}`);
    return { ok: true, message: "Batch abandoned. The file and its rows are kept." };
  } catch (error) {
    return { error: describe(error, "The batch could not be abandoned.") };
  }
}
