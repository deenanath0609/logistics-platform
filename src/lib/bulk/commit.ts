import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { createBooking, type BookingPackageInput } from "@/lib/shipment/booking";
import { recordAudit } from "@/server/services/audit";
import { batchStatus, revalidateBatch } from "./batch";
import { bulkIdempotencyKey } from "./idempotency";
import type { BulkRowValue } from "./validate";

/**
 * Commit.
 *
 * Partial commit is the point: valid rows book, invalid rows stay staged
 * for correction, and the clerk gets a summary they can act on rather than
 * an all-or-nothing failure on row 137.
 *
 * Re-committing the same batch cannot double-book, and it takes two
 * independent guards to say that honestly:
 *
 *  1. Each row is *claimed* with a conditional update, so two clerks
 *     pressing Confirm at the same moment cannot both take row 12.
 *  2. Each row books under `bulk:<batchId>:<rowNumber>`, a pure function
 *     of the row. Before booking, that key is looked up in the event log;
 *     if it is already there the existing consignment is adopted and no
 *     second one is created. This holds even if the row's status was reset
 *     by hand, and it is the guard that survives a crash between the
 *     booking committing and the row being marked.
 */

export type RowOutcome = {
  rowNumber: number;
  status: "committed" | "already-booked" | "failed" | "skipped";
  lrNumber?: string;
  shipmentId?: string;
  error?: string;
  field?: string;
};

export type CommitResult =
  | {
      ok: true;
      batchId: string;
      attempted: number;
      committed: number;
      alreadyBooked: number;
      failed: number;
      stillInvalid: number;
      outcomes: RowOutcome[];
    }
  | { ok: false; error: string };

function packagesFor(value: BulkRowValue): BookingPackageInput[] | undefined {
  if (value.lengthCm === null || value.breadthCm === null || value.heightCm === null) {
    return undefined;
  }

  // The file carries one set of dimensions for the consignment, so every
  // piece is assumed alike. Per-piece dimensions need per-piece rows,
  // which the single-booking screen does and a flat file cannot.
  return Array.from({ length: value.packageCount }, () => ({
    lengthCm: value.lengthCm,
    breadthCm: value.breadthCm,
    heightCm: value.heightCm,
  }));
}

export async function commitBatch(
  input: { batchId: string; rowNumbers?: number[] },
  actor: SessionUser,
): Promise<CommitResult> {
  const batch = await prisma.bulkUploadBatch.findUnique({
    where: { id: input.batchId },
    select: { id: true, branchId: true, fileName: true, status: true },
  });

  if (!batch) return { ok: false, error: "That batch no longer exists." };
  if (batch.status === "ABANDONED") {
    return { ok: false, error: "That batch was abandoned." };
  }

  // Validate again against the network as it is *now*. A PIN suspended
  // between upload and confirm must not slip through on a stale verdict.
  const revalidated = await revalidateBatch(input.batchId, actor);
  if (!revalidated.ok) return revalidated;

  const wanted = input.rowNumbers ? new Set(input.rowNumbers) : null;
  const candidates = revalidated.summary.rows.filter(
    (row) => row.value !== null && (!wanted || wanted.has(row.rowNumber)),
  );

  const outcomes: RowOutcome[] = [];

  for (const row of candidates) {
    const value = row.value!;
    const idempotencyKey = bulkIdempotencyKey(input.batchId, row.rowNumber);

    // ── Guard 1: claim the row ────────────────────────────
    const claimed = await prisma.bulkUploadRow.updateMany({
      where: {
        batchId: input.batchId,
        rowNumber: row.rowNumber,
        status: "VALID",
      },
      data: { status: "PENDING" },
    });

    if (claimed.count === 0) {
      outcomes.push({ rowNumber: row.rowNumber, status: "skipped" });
      continue;
    }

    // ── Guard 2: has this row already booked? ─────────────
    const existing = await prisma.shipmentEvent.findUnique({
      where: { idempotencyKey },
      select: { shipment: { select: { id: true, lrNumber: true } } },
    });

    if (existing) {
      await prisma.bulkUploadRow.update({
        where: {
          batchId_rowNumber: { batchId: input.batchId, rowNumber: row.rowNumber },
        },
        data: {
          status: "COMMITTED",
          shipmentId: existing.shipment.id,
          lrNumber: existing.shipment.lrNumber,
          errors: {},
        },
      });

      outcomes.push({
        rowNumber: row.rowNumber,
        status: "already-booked",
        lrNumber: existing.shipment.lrNumber,
        shipmentId: existing.shipment.id,
      });
      continue;
    }

    const result = await createBooking(
      {
        mode: value.mode,
        serviceTypeId: value.serviceTypeId,
        bookingBranchId: batch.branchId,
        originBranchId: value.originBranchId,
        destinationBranchId: value.destinationBranchId,

        consignorName: value.consignorName,
        consignorCompany: value.consignorCompany,
        consignorPhone: value.consignorPhone,
        consignorEmail: value.consignorEmail,
        consignorAddress: value.consignorAddress,
        consignorCityId: value.consignorCityId,
        consignorPincode: value.consignorPincode,
        consignorGstin: value.consignorGstin,

        consigneeName: value.consigneeName,
        consigneeCompany: value.consigneeCompany,
        consigneePhone: value.consigneePhone,
        consigneeEmail: value.consigneeEmail,
        consigneeAddress: value.consigneeAddress,
        consigneeCityId: value.consigneeCityId,
        consigneePincode: value.consigneePincode,
        consigneeLandmark: value.consigneeLandmark,
        consigneeGstin: value.consigneeGstin,

        packageCount: value.packageCount,
        actualWeight: value.actualWeight,
        packages: packagesFor(value),
        declaredValue: value.declaredValue,
        goodsDescription: value.goodsDescription,
        specialInstructions: value.specialInstructions,
        isFragile: value.isFragile,

        paymentType: value.paymentType,
        codAmount: value.codAmount,

        customerReference: value.customerReference,
        ewayBillNumber: value.ewayBillNumber,
        invoiceNumber: value.invoiceNumber,
        invoiceValue: value.invoiceValue,
        pickupRequired: value.pickupRequired,

        idempotencyKey,
        source: "IMPORT",
      },
      actor,
    );

    if (result.ok) {
      await prisma.bulkUploadRow.update({
        where: {
          batchId_rowNumber: { batchId: input.batchId, rowNumber: row.rowNumber },
        },
        data: {
          status: "COMMITTED",
          shipmentId: result.shipmentId,
          lrNumber: result.lrNumber,
          errors: {},
        },
      });

      outcomes.push({
        rowNumber: row.rowNumber,
        status: "committed",
        lrNumber: result.lrNumber,
        shipmentId: result.shipmentId,
      });
      continue;
    }

    // A booking that failed at the database rather than at validation:
    // the reason goes back onto the row so the clerk sees it in the grid.
    await prisma.bulkUploadRow.update({
      where: {
        batchId_rowNumber: { batchId: input.batchId, rowNumber: row.rowNumber },
      },
      data: {
        status: "INVALID",
        errors: {
          errors: { [result.field ?? "_row"]: result.error },
          warnings: {},
        },
      },
    });

    outcomes.push({
      rowNumber: row.rowNumber,
      status: "failed",
      error: result.error,
      field: result.field,
    });
  }

  // ── Tallies ───────────────────────────────────────────────
  const [totalRows, committedRows, invalidRows, validRows] = await Promise.all([
    prisma.bulkUploadRow.count({ where: { batchId: input.batchId } }),
    prisma.bulkUploadRow.count({
      where: { batchId: input.batchId, status: "COMMITTED" },
    }),
    prisma.bulkUploadRow.count({
      where: { batchId: input.batchId, status: "INVALID" },
    }),
    prisma.bulkUploadRow.count({
      where: { batchId: input.batchId, status: "VALID" },
    }),
  ]);

  await prisma.bulkUploadBatch.update({
    where: { id: input.batchId },
    data: {
      totalRows,
      validRows,
      invalidRows,
      committedRows,
      status: batchStatus(totalRows, committedRows),
    },
  });

  const committed = outcomes.filter((o) => o.status === "committed").length;
  const alreadyBooked = outcomes.filter((o) => o.status === "already-booked").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;

  await recordAudit({
    user: actor,
    action: "CREATE",
    entity: "BulkUploadBatch",
    entityId: input.batchId,
    entityRef: batch.fileName,
    branchId: batch.branchId,
    after: {
      committed,
      alreadyBooked,
      failed,
      totalRows,
      committedRows,
      lrNumbers: outcomes
        .filter((o) => o.status === "committed")
        .map((o) => o.lrNumber),
    },
  });

  return {
    ok: true,
    batchId: input.batchId,
    attempted: candidates.length,
    committed,
    alreadyBooked,
    failed,
    stillInvalid: invalidRows,
    outcomes,
  };
}
