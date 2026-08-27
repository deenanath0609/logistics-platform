import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { previewNext } from "@/lib/numbering/number-series";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Number series" };
export const dynamic = "force-dynamic";

const DOCUMENT_LABEL: Record<string, string> = {
  LR: "Lorry receipt / AWB",
  MANIFEST: "Manifest",
  TRIP: "Trip",
  PICKUP: "Pickup request",
  DELIVERY_RUN: "Delivery run",
  INVOICE: "Invoice",
  CREDIT_NOTE: "Credit note",
  DEBIT_NOTE: "Debit note",
  PAYMENT: "Customer receipt",
  VENDOR_PAYMENT: "Vendor payment",
  SETTLEMENT: "Vendor settlement",
  EXCEPTION: "Exception",
  COMPLAINT: "Complaint",
  VENDOR_BILL: "Vendor bill",
};

const RESET_LABEL: Record<string, string> = {
  NEVER: "Never",
  DAILY: "Daily",
  MONTHLY: "Monthly",
  FINANCIAL_YEAR: "Financial year",
};

export default async function NumberSeriesPage() {
  await requirePermission("master.read");

  const rows = await prisma.numberSeries.findMany({
    orderBy: [{ document: "asc" }],
    include: { branch: { select: { code: true } } },
  });

  return (
    <>
      <PageHeader
        eyebrow="Masters"
        title="Number series"
        description="Counters are issued under a database lock inside the transaction that creates the record, so two clerks booking at the same second never receive the same number."
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title="No series configured"
            description="Run the seed to create the standard set."
          />
        ) : (
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Pattern</TableHead>
                <TableHead>Resets</TableHead>
                <TableHead className="text-right">Issued</TableHead>
                <TableHead>Next number</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className={row.isActive ? "" : "opacity-55"}>
                  <TableCell className="font-medium">
                    {DOCUMENT_LABEL[row.document] ?? row.document}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.branch?.code ?? "Network"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.pattern}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {RESET_LABEL[row.resetPolicy] ?? row.resetPolicy}
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">
                    {row.currentValue}
                  </TableCell>
                  <TableCell className="font-mono text-xs font-medium text-primary">
                    {previewNext(row, row.branch?.code)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.isActive ? "secondary" : "outline"}>
                      {row.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      <p className="mt-4 max-w-prose text-sm text-muted-foreground">
        Patterns are read-only in this release. Changing one mid-year risks
        re-issuing a number that is already printed on a document, so edits
        need the migration path being built with invoicing in Phase 6.
      </p>
    </>
  );
}
