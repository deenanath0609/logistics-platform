import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { COLUMNS } from "@/lib/bulk/columns";
import { readRowNotes } from "@/lib/bulk/batch";
import { PageHeader } from "@/components/shell/page-header";
import { CommitBar } from "@/components/bulk/commit-bar";
import { ErrorGrid, type GridRow } from "@/components/bulk/error-grid";

export const metadata: Metadata = { title: "Bulk batch" };
export const dynamic = "force-dynamic";

function Tally({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "bad" | "muted";
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-card px-4 py-3">
      <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <span
        className={
          tone === "ok"
            ? "text-2xl font-semibold text-ok tabular"
            : tone === "bad"
              ? "text-2xl font-semibold text-bad tabular"
              : "text-2xl font-semibold tabular"
        }
      >
        {value}
      </span>
    </div>
  );
}

export default async function BulkBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const user = await requirePermission("shipment.bulk_upload");
  const { batchId } = await params;

  const batch = await prisma.bulkUploadBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      fileName: true,
      fileAssetId: true,
      status: true,
      totalRows: true,
      validRows: true,
      invalidRows: true,
      committedRows: true,
      createdAt: true,
      branch: { select: { id: true, code: true, name: true } },
      rows: {
        orderBy: { rowNumber: "asc" },
        select: {
          rowNumber: true,
          raw: true,
          status: true,
          errors: true,
          lrNumber: true,
          shipmentId: true,
        },
      },
    },
  });

  if (!batch) notFound();
  if (!coversBranch(user, batch.branch.id)) notFound();

  const rows: GridRow[] = batch.rows.map((row) => {
    const notes = readRowNotes(row.errors);
    const raw = (row.raw ?? {}) as Record<string, unknown>;

    return {
      rowNumber: row.rowNumber,
      status: row.status,
      cells: Object.fromEntries(
        COLUMNS.map((column) => [
          column.field,
          raw[column.field] === null || raw[column.field] === undefined
            ? ""
            : String(raw[column.field]),
        ]),
      ),
      errors: notes.errors,
      warnings: notes.warnings,
      lrNumber: row.lrNumber,
      shipmentId: row.shipmentId,
    };
  });

  // Counted from the rows themselves rather than from the batch tallies,
  // so a stale tally can never hide work from the clerk.
  const readyRows = rows.filter((row) => row.status === "VALID").length;
  const invalidRows = rows.filter((row) => row.status === "INVALID").length;
  const committedRows = rows.filter((row) => row.status === "COMMITTED").length;

  const reasons = new Map<string, number>();
  for (const row of rows) {
    for (const message of Object.values(row.errors)) {
      reasons.set(message, (reasons.get(message) ?? 0) + 1);
    }
  }
  const topReasons = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const canCommit = can(user, "shipment.create");
  const editable = batch.status !== "ABANDONED";

  return (
    <>
      <Link
        href="/shipments/bulk"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All batches
      </Link>

      <PageHeader
        eyebrow={`${batch.branch.code} · ${format(batch.createdAt, "dd MMM yyyy, HH:mm")}`}
        title={batch.fileName}
        description={
          batch.fileAssetId
            ? "The uploaded file is kept against this batch, so what the customer sent can always be produced."
            : "The uploaded file could not be stored — the staged rows below are the record of what was sent."
        }
      />

      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tally label="Rows" value={rows.length} />
          <Tally label="Ready" value={readyRows} />
          <Tally label="Booked" value={committedRows} tone="ok" />
          <Tally
            label="Needs fixing"
            value={invalidRows}
            tone={invalidRows > 0 ? "bad" : "muted"}
          />
        </div>

        {topReasons.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
              Why rows were rejected
            </h2>
            <ul className="flex flex-wrap gap-2">
              {topReasons.map(([message, count]) => (
                <li
                  key={message}
                  className="inline-flex items-center gap-2 rounded-full bg-bad-muted px-3 py-1 text-xs text-bad"
                >
                  {message}
                  <span className="font-mono">{count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!canCommit && (
          <p className="rounded-lg border border-warn/30 bg-warn-muted px-3 py-2 text-sm text-warn">
            You can upload and correct this file, but booking needs the
            &ldquo;Book a shipment&rdquo; permission.
          </p>
        )}

        <CommitBar
          batchId={batch.id}
          readyRows={readyRows}
          invalidRows={invalidRows}
          committedRows={committedRows}
          canCommit={canCommit && editable}
        />

        <ErrorGrid
          batchId={batch.id}
          editable={editable}
          columns={COLUMNS.map((column) => ({
            field: column.field,
            header: column.header,
            required: column.required,
            kind: column.kind,
            values: column.values,
          }))}
          rows={rows}
        />
      </div>
    </>
  );
}
