import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { storeAsset } from "@/lib/delivery/assets";
import { recordAudit } from "@/server/services/audit";
import { COLUMN_BY_FIELD } from "./columns";
import { parseUpload, type ParsedRow, type ParseResult } from "./parse";
import { loadValidationContext } from "./context";
import { validateRows, type ValidationSummary } from "./validate";

/**
 * The staging table.
 *
 * A bulk file is never booked straight from the upload. It lands in
 * `BulkUploadBatch` / `BulkUploadRow` first, where every row keeps the
 * text exactly as it was sent alongside the reasons it was rejected —
 * which is what lets a clerk correct three cells and commit, instead of
 * re-exporting the whole file from their own system.
 */

/** A CSV this large is a data-migration, not a day's bookings. */
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;

export type UploadResult =
  | {
      ok: true;
      batchId: string;
      totalRows: number;
      validRows: number;
      invalidRows: number;
      unknownHeaders: string[];
      encoding: ParseResult["encoding"];
    }
  | { ok: false; error: string; missingHeaders?: string[] };

export type UploadInput = {
  fileName: string;
  contentType: string;
  bytes: Buffer;
  /** Branch the batch is booked against. Defaults to the clerk's own. */
  branchId: string;
};

/**
 * Parses, stages and validates an uploaded file.
 *
 * The source file itself is stored and pointed at from the batch: when a
 * customer disputes what they sent six months later, the answer has to be
 * the bytes they sent, not our reading of them.
 */
export async function createBulkBatch(
  input: UploadInput,
  actor: SessionUser,
): Promise<UploadResult> {
  if (input.bytes.byteLength === 0) {
    return { ok: false, error: "That file is empty." };
  }
  if (input.bytes.byteLength > MAX_BYTES) {
    return {
      ok: false,
      error: `That file is ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_BYTES / 1024 / 1024} MB — split it.`,
    };
  }

  const parsed = parseUpload({
    fileName: input.fileName,
    bytes: new Uint8Array(input.bytes),
  });

  // A file with no header row, no rows at all, or a missing required
  // column is refused before it is staged. Staging it would produce a
  // batch of uniformly broken rows and tell the clerk nothing they could
  // act on.
  if (!parsed.ok && parsed.rows.length === 0) {
    return { ok: false, error: parsed.error ?? "That file could not be read." };
  }
  if (parsed.missingHeaders.length > 0) {
    return {
      ok: false,
      error: parsed.error ?? "The file is missing required columns.",
      missingHeaders: parsed.missingHeaders,
    };
  }
  if (parsed.rows.length > MAX_ROWS) {
    return {
      ok: false,
      error: `That file has ${parsed.rows.length.toLocaleString("en-IN")} rows. The limit for one batch is ${MAX_ROWS.toLocaleString("en-IN")}.`,
    };
  }

  const context = await loadValidationContext(parsed.rows, actor);
  const summary = validateRows(parsed.rows, context);

  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.bulkUploadBatch.create({
      data: {
        orgId: actor.orgId,
        branchId: input.branchId,
        fileName: input.fileName,
        totalRows: summary.rows.length,
        validRows: summary.validCount,
        invalidRows: summary.invalidCount,
        status: "VALIDATED",
        uploadedById: actor.id,
      },
      select: { id: true },
    });

    await tx.bulkUploadRow.createMany({
      data: summary.rows.map((row) => ({
        batchId: created.id,
        rowNumber: row.rowNumber,
        raw: row.raw as Prisma.InputJsonValue,
        status: row.value ? ("VALID" as const) : ("INVALID" as const),
        errors: rowNotes(row.errors, row.warnings),
      })),
    });

    return created;
  });

  // Storage is a side effect, not part of the batch's correctness: a file
  // that fails to store must not lose the clerk their parsed rows.
  try {
    const asset = await storeAsset({
      kind: "BULK_UPLOAD_SOURCE",
      bytes: input.bytes,
      contentType: input.contentType || "text/csv",
      fileName: input.fileName,
      ownerEntity: "BulkUploadBatch",
      ownerId: batch.id,
      orgId: actor.orgId,
      uploadedById: actor.id,
    });

    await prisma.bulkUploadBatch.update({
      where: { id: batch.id },
      data: { fileAssetId: asset.id },
    });
  } catch (error) {
    console.error("[bulk] source file could not be stored", error);
  }

  await recordAudit({
    user: actor,
    action: "CREATE",
    entity: "BulkUploadBatch",
    entityId: batch.id,
    entityRef: input.fileName,
    branchId: input.branchId,
    after: {
      fileName: input.fileName,
      sizeBytes: input.bytes.byteLength,
      encoding: parsed.encoding,
      totalRows: summary.rows.length,
      validRows: summary.validCount,
      invalidRows: summary.invalidCount,
      unknownHeaders: parsed.unknownHeaders,
    },
  });

  return {
    ok: true,
    batchId: batch.id,
    totalRows: summary.rows.length,
    validRows: summary.validCount,
    invalidRows: summary.invalidCount,
    unknownHeaders: parsed.unknownHeaders,
    encoding: parsed.encoding,
  };
}

/** Errors and warnings, stored together so the grid can render both. */
function rowNotes(
  errors: Record<string, string>,
  warnings: Record<string, string>,
): Prisma.InputJsonValue {
  const hasErrors = Object.keys(errors).length > 0;
  const hasWarnings = Object.keys(warnings).length > 0;
  if (!hasErrors && !hasWarnings) return {};
  return { errors, warnings } as Prisma.InputJsonValue;
}

export type StoredNotes = {
  errors: Record<string, string>;
  warnings: Record<string, string>;
};

/** Reads back what `rowNotes` wrote, tolerating rows written before it. */
export function readRowNotes(value: unknown): StoredNotes {
  if (!value || typeof value !== "object") return { errors: {}, warnings: {} };
  const record = value as Record<string, unknown>;

  const errors =
    record.errors && typeof record.errors === "object"
      ? (record.errors as Record<string, string>)
      : {};
  const warnings =
    record.warnings && typeof record.warnings === "object"
      ? (record.warnings as Record<string, string>)
      : {};

  return { errors, warnings };
}

function asRaw(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, cell]) => [
      key,
      cell === null || cell === undefined ? "" : String(cell),
    ]),
  );
}

/**
 * Re-runs validation over the staged rows.
 *
 * Called after an inline correction and again just before a commit, so a
 * PIN that stopped being serviceable between upload and confirm is caught
 * rather than booked.
 */
export async function revalidateBatch(
  batchId: string,
  actor: SessionUser,
): Promise<{ ok: true; summary: ValidationSummary } | { ok: false; error: string }> {
  const batch = await prisma.bulkUploadBatch.findUnique({
    where: { id: batchId },
    select: { id: true, rows: { orderBy: { rowNumber: "asc" } } },
  });

  if (!batch) return { ok: false, error: "That batch no longer exists." };

  // Committed rows are history. Re-validating them would either be a
  // no-op or, worse, mark a booked consignment invalid.
  const pending = batch.rows.filter((row) => row.status !== "COMMITTED");

  const parsedRows: ParsedRow[] = pending.map((row) => ({
    rowNumber: row.rowNumber,
    sourceLine: row.rowNumber + 1,
    raw: asRaw(row.raw),
  }));

  const context = await loadValidationContext(parsedRows, actor);
  const summary = validateRows(parsedRows, context);
  const byRowNumber = new Map(summary.rows.map((row) => [row.rowNumber, row]));

  await prisma.$transaction(async (tx) => {
    for (const row of pending) {
      const validated = byRowNumber.get(row.rowNumber);
      if (!validated) continue;

      await tx.bulkUploadRow.update({
        where: { id: row.id },
        data: {
          status: validated.value ? "VALID" : "INVALID",
          errors: rowNotes(validated.errors, validated.warnings),
        },
      });
    }

    const committed = batch.rows.length - pending.length;
    await tx.bulkUploadBatch.update({
      where: { id: batchId },
      data: {
        totalRows: batch.rows.length,
        validRows: summary.validCount,
        invalidRows: summary.invalidCount,
        committedRows: committed,
        status: batchStatus(batch.rows.length, committed),
      },
    });
  });

  return { ok: true, summary };
}

export function batchStatus(
  totalRows: number,
  committedRows: number,
): "VALIDATED" | "PARTIALLY_COMMITTED" | "COMMITTED" {
  if (committedRows === 0) return "VALIDATED";
  if (committedRows >= totalRows) return "COMMITTED";
  return "PARTIALLY_COMMITTED";
}

/**
 * Applies an inline correction to one staged row.
 *
 * Only declared columns are writable, and a committed row is immutable —
 * the consignment exists by then, and amending it is a booking amendment,
 * not a spreadsheet edit.
 */
export async function updateBatchRow(
  input: { batchId: string; rowNumber: number; patch: Record<string, string> },
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await prisma.bulkUploadRow.findUnique({
    where: {
      batchId_rowNumber: { batchId: input.batchId, rowNumber: input.rowNumber },
    },
    select: { id: true, raw: true, status: true, batch: { select: { branchId: true } } },
  });

  if (!row) return { ok: false, error: "That row is not in this batch." };
  if (row.status === "COMMITTED") {
    return {
      ok: false,
      error: "That row is already booked. Amend the shipment instead.",
    };
  }

  const before = asRaw(row.raw);
  const after = { ...before };

  for (const [field, value] of Object.entries(input.patch)) {
    if (!COLUMN_BY_FIELD.has(field)) continue;
    after[field] = String(value ?? "").trim();
  }

  await prisma.bulkUploadRow.update({
    where: { id: row.id },
    data: { raw: after as Prisma.InputJsonValue },
  });

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "BulkUploadRow",
    entityId: row.id,
    entityRef: `${input.batchId}#${input.rowNumber}`,
    branchId: row.batch.branchId,
    before,
    after,
  });

  return { ok: true };
}

/** Marks a batch abandoned. The rows stay, because the file was real. */
export async function abandonBatch(
  batchId: string,
  actor: SessionUser,
): Promise<void> {
  await prisma.bulkUploadBatch.update({
    where: { id: batchId },
    data: { status: "ABANDONED" },
  });

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "BulkUploadBatch",
    entityId: batchId,
    after: { status: "ABANDONED" },
  });
}
