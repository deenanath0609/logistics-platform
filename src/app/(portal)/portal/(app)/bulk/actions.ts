"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  authorizeCustomer,
  canWrite,
  CustomerAuthError,
} from "@/lib/auth/customer-session";
import { COLUMN_BY_FIELD } from "@/lib/bulk/columns";
import {
  commitPortalBatch,
  createPortalBulkBatch,
  patchPortalBatchRow,
  revalidatePortalBatch,
} from "@/lib/portal/bulk";

/**
 * Bulk-upload actions for the portal.
 *
 * Every one resolves the account from the session and passes it to
 * `src/lib/portal/bulk.ts`, which proves ownership inside the query. No
 * action here reads an account, a branch or a consignor from the form —
 * there are no such fields, and adding one would be the bug.
 */

export type BulkState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  missingHeaders?: string[];
  ignoredColumns?: string[];
};

export type BulkCommitState = BulkState & {
  summary?: {
    committed: number;
    alreadyBooked: number;
    failed: number;
    stillInvalid: number;
    lrNumbers: string[];
    failures: Array<{ rowNumber: number; error: string }>;
  };
};

const PATH = "/portal/bulk";

function guard(error: unknown, fallback: string): BulkState {
  if (error instanceof CustomerAuthError) {
    return { error: "Your session has expired. Sign in again." };
  }
  console.error("[portal bulk]", error);
  return { error: fallback };
}

// ────────────────────────────────────────────────────────────
// Upload
// ────────────────────────────────────────────────────────────

export async function uploadPortalBulkFile(
  _prev: BulkState,
  formData: FormData,
): Promise<BulkState> {
  let destination: string;

  try {
    const session = await authorizeCustomer();
    if (!canWrite(session)) {
      return { error: "Your login can view batches but not book from them." };
    }

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { error: "Choose a CSV or XLSX file to upload." };
    }

    const result = await createPortalBulkBatch(session, {
      fileName: file.name,
      contentType: file.type || "text/csv",
      bytes: Buffer.from(await file.arrayBuffer()),
    });

    if (!result.ok) {
      return { error: result.error, missingHeaders: result.missingHeaders };
    }

    revalidatePath(PATH);
    destination = `${PATH}/${result.batchId}`;
  } catch (error) {
    return guard(error, "The file could not be read.");
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

export async function savePortalBulkRow(
  _prev: BulkState,
  formData: FormData,
): Promise<BulkState> {
  try {
    const session = await authorizeCustomer();
    if (!canWrite(session)) {
      return { error: "Your login cannot change this file." };
    }

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

    if (Object.keys(patch).length === 0) return { error: "Nothing was changed." };

    const result = await patchPortalBatchRow(session, {
      batchId: parsed.data.batchId,
      rowNumber: parsed.data.rowNumber,
      patch,
    });
    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${parsed.data.batchId}`);

    const remaining = Object.keys(result.stillInvalid).length;
    if (remaining > 0) {
      return {
        ok: false,
        error: `Row ${parsed.data.rowNumber} still has ${remaining} problem${remaining === 1 ? "" : "s"}.`,
        fieldErrors: result.stillInvalid,
      };
    }

    return { ok: true, message: `Row ${parsed.data.rowNumber} is ready to book.` };
  } catch (error) {
    return guard(error, "That correction could not be saved.");
  }
}

export async function recheckPortalBulkBatch(
  _prev: BulkState,
  formData: FormData,
): Promise<BulkState> {
  try {
    const session = await authorizeCustomer();
    // Re-checking rewrites every staged row's status and the batch's
    // tallies. It reads like a refresh and it is a write, which is how it
    // came to be the one action here with no role check while the Re-check
    // button beside it stayed enabled for a VIEWER.
    if (!canWrite(session)) {
      return { error: "Your login can view this file but not re-check it." };
    }

    const batchId = String(formData.get("batchId") ?? "");
    if (!batchId) return { error: "That batch could not be identified." };

    const result = await revalidatePortalBatch(session, batchId);
    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${batchId}`);
    return {
      ok: true,
      message: `${result.valid} ready, ${result.invalid} still to fix.`,
    };
  } catch (error) {
    return guard(error, "The file could not be re-checked.");
  }
}

// ────────────────────────────────────────────────────────────
// Commit
// ────────────────────────────────────────────────────────────

export async function commitPortalBulkBatch(
  _prev: BulkCommitState,
  formData: FormData,
): Promise<BulkCommitState> {
  try {
    const session = await authorizeCustomer();
    if (!canWrite(session)) {
      return { error: "Your login cannot book consignments." };
    }

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

    const result = await commitPortalBatch(session, { batchId, rowNumbers });
    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${batchId}`);
    revalidatePath("/portal/shipments");
    revalidatePath("/portal");

    const message =
      result.committed === 0 && result.alreadyBooked > 0
        ? `Nothing new to book — those ${result.alreadyBooked} rows were already booked.`
        : `Booked ${result.committed} of ${result.attempted}.` +
          (result.alreadyBooked > 0
            ? ` ${result.alreadyBooked} were already booked and were not repeated.`
            : "") +
          (result.stillInvalid > 0
            ? ` ${result.stillInvalid} still need fixing.`
            : "");

    return {
      ok: true,
      message,
      summary: {
        committed: result.committed,
        alreadyBooked: result.alreadyBooked,
        failed: result.failed,
        stillInvalid: result.stillInvalid,
        lrNumbers: result.outcomes
          .filter((outcome) => outcome.lrNumber)
          .map((outcome) => outcome.lrNumber!)
          .slice(0, 20),
        failures: result.outcomes
          .filter((outcome) => outcome.status === "failed")
          .map((outcome) => ({
            rowNumber: outcome.rowNumber,
            error: outcome.error ?? "Failed",
          })),
      },
    };
  } catch (error) {
    return guard(error, "The batch could not be booked.");
  }
}
