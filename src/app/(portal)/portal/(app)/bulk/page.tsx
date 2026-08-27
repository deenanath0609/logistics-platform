import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { format } from "date-fns";
import { canWrite, requireCustomerUser } from "@/lib/auth/customer-session";
import { listPortalBatches } from "@/lib/portal/bulk";
import { templateColumnHelp } from "@/lib/bulk/template";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, TableFrame } from "@/components/data/data-shell";
import { PortalBulkUploadCard } from "@/components/portal/bulk-upload-card";

export const metadata: Metadata = {
  title: "Bulk upload",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const BATCH_TONE: Record<string, string> = {
  UPLOADED: "bg-muted text-muted-foreground",
  VALIDATED: "bg-accent text-accent-foreground",
  PARTIALLY_COMMITTED: "bg-warn-muted text-warn",
  COMMITTED: "bg-ok-muted text-ok",
  ABANDONED: "bg-muted text-muted-foreground",
};

const BATCH_LABEL: Record<string, string> = {
  UPLOADED: "Uploaded",
  VALIDATED: "Checked",
  PARTIALLY_COMMITTED: "Part booked",
  COMMITTED: "Booked",
  ABANDONED: "Abandoned",
};

/**
 * Bulk booking, from the customer's side.
 *
 * The columns the file may carry are listed from `templateColumnHelp()`,
 * which is generated from the same declaration the validator reads —
 * there is no second list to go stale. The two branch columns are shown
 * as "we fill this in", because routing is the network's decision and the
 * portal derives both from the PIN codes.
 */
export default async function PortalBulkPage() {
  const session = await requireCustomerUser();
  if (!canWrite(session)) redirect("/portal/shipments");

  const [batches, columns] = await Promise.all([
    listPortalBatches(session),
    Promise.resolve(templateColumnHelp()),
  ]);

  const ROUTED = new Set(["Origin Branch", "Destination Branch"]);

  return (
    <>
      <PageHeader
        title="Bulk upload"
        description="Upload a file, see exactly which cells we could not accept, fix them here, then confirm. Valid rows book and the rest wait for you — a file with seven bad rows still books the other hundred and ninety-three."
      />

      <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:gap-6">
        <div className="flex flex-col gap-4 rounded-lg border bg-card p-4 sm:p-5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
            New file
          </h2>
          <PortalBulkUploadCard />
          <p className="text-xs text-muted-foreground">
            Everything in the file books under {session.customerName}. There is
            no account column, and if your export has one we ignore it.
          </p>
        </div>

        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
              Your files
            </h2>

            {batches.length === 0 ? (
              <TableFrame>
                <EmptyState
                  title="Nothing uploaded yet"
                  description="Download the template, fill it in, and upload it here."
                />
              </TableFrame>
            ) : (
              <ul className="flex flex-col gap-2">
                {batches.map((batch) => (
                  <li key={batch.id}>
                    <Link
                      href={`/portal/bulk/${batch.id}`}
                      className="flex flex-col gap-2 rounded-lg border bg-card p-4 transition-colors hover:border-primary/50"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider ${
                            BATCH_TONE[batch.status] ?? "bg-muted"
                          }`}
                        >
                          {BATCH_LABEL[batch.status] ?? batch.status}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {batch.fileName}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span className="tabular">{batch.totalRows} rows</span>
                        <span className="tabular text-ok">
                          {batch.committedRows} booked
                        </span>
                        {batch.invalidRows > 0 && (
                          <span className="tabular text-bad">
                            {batch.invalidRows} to fix
                          </span>
                        )}
                        <span>
                          {format(batch.createdAt, "dd MMM yyyy, HH:mm")}
                        </span>
                        {batch.uploadedBy && <span>{batch.uploadedBy}</span>}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
              What the file may carry
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              Headers are matched loosely — case, spacing and punctuation are
              ignored, and common alternatives (&ldquo;PCS&rdquo;, &ldquo;Gross
              Weight&rdquo;, &ldquo;Delivery Pincode&rdquo;) are accepted. This
              list and the template you download are generated from the same
              declaration our validator reads, so they cannot disagree.
            </p>

            <ul className="flex flex-col divide-y rounded-lg border bg-card">
              {columns.map((column) => {
                const routed = ROUTED.has(column.header);

                return (
                  <li
                    key={column.header}
                    className="flex flex-col gap-1 px-4 py-3"
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{column.header}</span>
                      {routed ? (
                        <span className="rounded-sm bg-info-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-info">
                          We fill this in
                        </span>
                      ) : column.required ? (
                        <span className="rounded-sm bg-bad-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-bad">
                          Required
                        </span>
                      ) : (
                        <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                          Optional
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {routed
                        ? "Leave it blank. Which branch handles a consignment follows from the PIN codes, so we work it out rather than asking you to know our network."
                        : column.help}
                    </p>
                    {column.example && !routed && (
                      <p className="font-mono text-xs text-muted-foreground">
                        e.g. {column.example}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
