import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft } from "lucide-react";
import { canWrite, requireCustomerUser } from "@/lib/auth/customer-session";
import { getPortalBatch, ROUTED_FIELDS } from "@/lib/portal/bulk";
import { COLUMNS } from "@/lib/bulk/columns";
import { PageHeader } from "@/components/shell/page-header";
import { PortalCommitBar } from "@/components/portal/bulk-commit-bar";
import { PortalBulkGrid } from "@/components/portal/bulk-grid";

export const metadata: Metadata = {
  title: "Bulk batch",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function Tally({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "bad";
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2.5 sm:px-4 sm:py-3">
      <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
        {label}
      </span>
      <span
        className={
          tone === "ok"
            ? "text-2xl font-semibold tabular text-ok"
            : tone === "bad"
              ? "text-2xl font-semibold tabular text-bad"
              : "text-2xl font-semibold tabular"
        }
      >
        {value}
      </span>
    </div>
  );
}

export default async function PortalBulkBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const session = await requireCustomerUser();
  const { batchId } = await params;

  // Scoped inside the query. Another account's batch id is a 404 here.
  const batch = await getPortalBatch(session, batchId);
  if (!batch) notFound();

  const mayBook = canWrite(session);

  return (
    <>
      <Link
        href="/portal/bulk"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All files
      </Link>

      <PageHeader
        eyebrow={format(batch.createdAt, "dd MMM yyyy, HH:mm")}
        title={batch.fileName}
        description="Your file exactly as you sent it, with our reasons against the cells we could not accept."
      />

      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
          <Tally label="Rows" value={batch.rows.length} />
          <Tally label="Ready" value={batch.readyRows} />
          <Tally label="Booked" value={batch.committedRows} tone="ok" />
          <Tally
            label="To fix"
            value={batch.invalidRows}
            tone={batch.invalidRows > 0 ? "bad" : undefined}
          />
        </div>

        {batch.topReasons.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
              Why rows were held back
            </h2>
            <ul className="flex flex-wrap gap-2">
              {batch.topReasons.map((reason) => (
                <li
                  key={reason.message}
                  className="inline-flex items-center gap-2 rounded-full bg-bad-muted px-3 py-1 text-xs text-bad"
                >
                  {reason.message}
                  <span className="font-mono">{reason.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!mayBook && (
          <p className="rounded-lg border border-warn/30 bg-warn-muted px-3 py-2 text-sm text-warn">
            Your login can look at this file but not book from it. Your account
            owner can.
          </p>
        )}

        <PortalCommitBar
          batchId={batch.id}
          readyRows={batch.readyRows}
          invalidRows={batch.invalidRows}
          committedRows={batch.committedRows}
          canCommit={mayBook && batch.editable}
        />

        <PortalBulkGrid
          batchId={batch.id}
          editable={batch.editable && mayBook}
          // The two routing columns are not shown: the portal writes them
          // from the PIN codes, so offering them for editing would invite a
          // correction that the next re-check silently overwrites.
          columns={COLUMNS.filter((column) => !ROUTED_FIELDS.has(column.field)).map(
            (column) => ({
              field: column.field,
              header: column.header,
              required: column.required,
              kind: column.kind,
              values: column.values,
            }),
          )}
          rows={batch.rows}
        />
      </div>
    </>
  );
}
