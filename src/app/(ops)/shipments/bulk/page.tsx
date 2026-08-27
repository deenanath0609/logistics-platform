import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { templateColumnHelp } from "@/lib/bulk/template";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { UploadCard } from "@/components/bulk/upload-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Bulk booking" };
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

export default async function BulkUploadPage() {
  const user = await requirePermission("shipment.bulk_upload");

  const [branches, batches] = await Promise.all([
    prisma.branch.findMany({
      where: { isActive: true, deletedAt: null, ...branchScope(user, "id") },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.bulkUploadBatch.findMany({
      where: branchScope(user, "branchId"),
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        fileName: true,
        status: true,
        totalRows: true,
        validRows: true,
        invalidRows: true,
        committedRows: true,
        createdAt: true,
        branch: { select: { code: true } },
      },
    }),
  ]);

  const columns = templateColumnHelp();

  return (
    <>
      <Link
        href="/shipments"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All shipments
      </Link>

      <PageHeader
        eyebrow="Operations"
        title="Bulk booking"
        description="Upload, check, fix in place, then confirm. Valid rows book and invalid rows stay here for correction — a file with seven bad rows still books the other hundred and ninety-three."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
            New batch
          </h2>
          <UploadCard
            branches={branches.map((branch) => ({
              value: branch.id,
              label: `${branch.code} — ${branch.name}`,
            }))}
            defaultBranchId={user.primaryBranch?.id ?? null}
          />
        </div>

        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
              Recent batches
            </h2>

            {batches.length === 0 ? (
              <TableFrame>
                <EmptyState
                  title="No batches yet"
                  description="Download the template, fill it in, and upload it here."
                />
              </TableFrame>
            ) : (
              <TableFrame>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>File</TableHead>
                      <TableHead>Branch</TableHead>
                      <TableHead className="text-right">Rows</TableHead>
                      <TableHead className="text-right">Booked</TableHead>
                      <TableHead className="text-right">To fix</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Uploaded</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {batches.map((batch) => (
                      <TableRow key={batch.id}>
                        <TableCell className="max-w-[16rem] truncate font-medium">
                          <Link
                            href={`/shipments/bulk/${batch.id}`}
                            className="hover:underline"
                          >
                            {batch.fileName}
                          </Link>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {batch.branch.code}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {batch.totalRows}
                        </TableCell>
                        <TableCell className="text-right tabular text-ok">
                          {batch.committedRows}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {batch.invalidRows > 0 ? (
                            <span className="text-bad">{batch.invalidRows}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              BATCH_TONE[batch.status] ?? "bg-muted"
                            }`}
                          >
                            {BATCH_LABEL[batch.status] ?? batch.status}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {format(batch.createdAt, "dd MMM yyyy, HH:mm")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableFrame>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
              Columns the file may carry
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              Headers are matched loosely — case, spacing and punctuation are
              ignored, and common alternatives (&ldquo;PCS&rdquo;,
              &ldquo;Gross Weight&rdquo;, &ldquo;Delivery Pincode&rdquo;) are
              accepted. This list and the downloadable template are generated
              from the same declaration the validator reads, so they cannot
              disagree.
            </p>

            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Column</TableHead>
                    <TableHead>Required</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead>Example</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {columns.map((column) => (
                    <TableRow key={column.header}>
                      <TableCell className="font-medium">{column.header}</TableCell>
                      <TableCell>
                        {column.required ? (
                          <span className="text-bad">Yes</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[24rem] whitespace-normal text-sm text-muted-foreground">
                        {column.help}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {column.example || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableFrame>
          </section>
        </div>
      </div>
    </>
  );
}
