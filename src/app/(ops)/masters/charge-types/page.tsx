import type { Metadata } from "next";

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
import {
  createChargeType,
  updateChargeType,
  setChargeTypeActive,
} from "./actions";

export const metadata: Metadata = { title: "Charge heads" };
export const dynamic = "force-dynamic";

const BASIS_LABEL: Record<string, string> = {
  FLAT: "Flat",
  PER_KG: "Per kg",
  PER_PACKAGE: "Per package",
  PER_KM: "Per km",
  PER_HOUR: "Per hour",
  PERCENT_OF_FREIGHT: "% of freight",
  PERCENT_OF_DECLARED_VALUE: "% of declared value",
  PERCENT_OF_COD: "% of COD",
};

const NATURE_TONE: Record<string, string> = {
  FREIGHT: "bg-accent text-accent-foreground",
  SURCHARGE: "bg-info-muted text-info",
  HANDLING: "bg-muted text-muted-foreground",
  STATUTORY: "bg-warn-muted text-warn",
  PENALTY: "bg-bad-muted text-bad",
  DISCOUNT: "bg-ok-muted text-ok",
};

function buildFields(
  taxOptions: Array<{ value: string; label: string }>,
): FieldDef[] {
  return [
    { type: "text", name: "code", label: "Code", required: true, half: true, mono: true, placeholder: "FSC" },
    { type: "text", name: "name", label: "Name", required: true, half: true, placeholder: "Fuel Surcharge" },
    {
      type: "select",
      name: "nature",
      label: "Nature",
      required: true,
      half: true,
      options: [
        { value: "FREIGHT", label: "Freight" },
        { value: "SURCHARGE", label: "Surcharge" },
        { value: "HANDLING", label: "Handling" },
        { value: "STATUTORY", label: "Statutory" },
        { value: "PENALTY", label: "Penalty" },
        { value: "DISCOUNT", label: "Discount" },
      ],
    },
    {
      type: "select",
      name: "defaultBasis",
      label: "Default basis",
      required: true,
      half: true,
      options: Object.entries(BASIS_LABEL).map(([value, label]) => ({
        value,
        label,
      })),
    },
    {
      type: "select",
      name: "taxRateId",
      label: "Tax rate",
      options: taxOptions,
      placeholder: "No tax",
      help: "Rate cards can override this per customer.",
    },
    { type: "switch", name: "isTaxable", label: "Taxable", help: "Included in the taxable value of the consignment note." },
    {
      type: "switch",
      name: "isCustomerVisible",
      label: "Show to customer",
      help: "Off means the cost is absorbed internally, not printed on the invoice.",
    },
    { type: "switch", name: "isActive", label: "Active" },
  ];
}

export default async function ChargeTypesPage() {
  const user = await requirePermission("master.read");
  const writable = can(user, "master.manage");

  const [rows, taxRates] = await Promise.all([
    prisma.chargeType.findMany({
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }],
      include: { taxRate: { select: { code: true, ratePercent: true } } },
    }),
    prisma.taxRate.findMany({
      where: { isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  const fields = buildFields(
    taxRates.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` })),
  );

  return (
    <>
      <PageHeader
        eyebrow="Masters"
        title="Charge heads"
        description="Every billable line a shipment can carry. Rate cards attach amounts to these in Phase 6; the booking screen renders one row per applicable head."
        actions={
          writable && (
            <MasterFormDialog
              title="New charge head"
              fields={fields}
              action={createChargeType}
              submitLabel="Create"
              trigger={{ label: "New charge head", icon: "plus" }}
            />
          )
        }
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState title="No charge heads yet" />
        ) : (
          <Table className="min-w-[820px]">
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Nature</TableHead>
                <TableHead>Default basis</TableHead>
                <TableHead>Tax</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead>Status</TableHead>
                {writable && <TableHead className="w-24 text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className={row.isActive ? "" : "opacity-55"}>
                  <TableCell className="font-mono text-xs font-medium">{row.code}</TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>
                    <span
                      className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${NATURE_TONE[row.nature]}`}
                    >
                      {row.nature}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {BASIS_LABEL[row.defaultBasis] ?? row.defaultBasis}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.taxRate
                      ? `${row.taxRate.code} · ${Number(row.taxRate.ratePercent).toFixed(2)}%`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.isCustomerVisible ? "On invoice" : "Internal"}
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
                          fields={fields}
                          action={updateChargeType}
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
                          action={setChargeTypeActive}
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
