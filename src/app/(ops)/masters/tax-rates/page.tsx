import type { Metadata } from "next";
import { format } from "date-fns";

import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { MasterFormDialog, type FieldDef } from "@/components/data/master-form";
import { ToggleActive } from "@/components/data/toggle-active";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createTaxRate, updateTaxRate, setTaxRateActive } from "./actions";

export const metadata: Metadata = { title: "Tax rates" };
export const dynamic = "force-dynamic";

const FIELDS: FieldDef[] = [
  { type: "text", name: "code", label: "Code", required: true, half: true, mono: true, placeholder: "GST5-RCM" },
  {
    type: "select",
    name: "kind",
    label: "Kind",
    required: true,
    half: true,
    options: [
      { value: "GST", label: "GST" },
      { value: "IGST", label: "IGST — inter-state" },
      { value: "CGST", label: "CGST" },
      { value: "SGST", label: "SGST" },
      { value: "CESS", label: "Cess" },
      { value: "TDS", label: "TDS" },
    ],
  },
  { type: "text", name: "name", label: "Name", required: true, placeholder: "GST 5% — GTA reverse charge" },
  { type: "number", name: "ratePercent", label: "Rate %", required: true, half: true, step: "0.001" },
  {
    type: "text",
    name: "hsnSac",
    label: "HSN / SAC",
    half: true,
    mono: true,
    placeholder: "996511",
    help: "996511 is road transport of goods.",
  },
  {
    type: "date",
    name: "effectiveFrom",
    label: "Effective from",
    required: true,
    half: true,
    help: "Historical invoices reprice at the rate in force on their date.",
  },
  {
    type: "switch",
    name: "isReverseCharge",
    label: "Reverse charge",
    help: "GTA services usually are — the recipient pays the tax, and the invoice must say so.",
  },
  { type: "switch", name: "isActive", label: "Active" },
];

export default async function TaxRatesPage() {
  const user = await requirePermission("master.read");
  const writable = can(user, "master.manage");

  const rows = await prisma.taxRate.findMany({
    orderBy: [{ isActive: "desc" }, { kind: "asc" }, { ratePercent: "asc" }],
  });

  return (
    <>
      <PageHeader
        eyebrow="Masters"
        title="Tax rates"
        description="Rates are versioned by effective date, so an invoice raised last quarter always reprices at the rate that applied then."
        actions={
          writable && (
            <MasterFormDialog
              title="New tax rate"
              fields={FIELDS}
              action={createTaxRate}
              submitLabel="Create"
              trigger={{ label: "New tax rate", icon: "plus" }}
            />
          )
        }
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState title="No tax rates yet" />
        ) : (
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead>Charge</TableHead>
                <TableHead>HSN / SAC</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>Status</TableHead>
                {writable && <TableHead className="w-24 text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className={row.isActive ? "" : "opacity-55"}>
                  <TableCell className="font-mono text-xs font-medium">{row.code}</TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.kind}</TableCell>
                  <TableCell className="text-right tabular">
                    {Number(row.ratePercent).toFixed(2)}%
                  </TableCell>
                  <TableCell>
                    {row.isReverseCharge ? (
                      <span className="rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-warn">
                        Reverse
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Forward</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.hsnSac ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular">
                    {format(row.effectiveFrom, "dd MMM yyyy")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.isActive ? "secondary" : "outline"}>
                      {row.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  {writable && (
                    <TableCell>
                      <div className="flex items-center justify-end gap-0.5">
                        <MasterFormDialog
                          title={`Edit ${row.code}`}
                          fields={FIELDS}
                          action={updateTaxRate}
                          record={row as unknown as Record<string, unknown>}
                          trigger={{
                            label: `Edit ${row.code}`,
                            icon: "pencil",
                            variant: "ghost",
                            size: "icon-sm",
                            iconOnly: true,
                          }}
                        />
                        <ToggleActive
                          id={row.id}
                          isActive={row.isActive}
                          label={row.code}
                          action={setTaxRateActive}
                        />
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>
    </>
  );
}
