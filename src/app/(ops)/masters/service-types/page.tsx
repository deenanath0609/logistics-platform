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
  SHIPMENT_MODE_OPTIONS,
  SHIPMENT_MODE_TONE,
} from "@/lib/shipment/modes";
import {
  createServiceType,
  updateServiceType,
  setServiceTypeActive,
} from "./actions";

export const metadata: Metadata = { title: "Service types" };
export const dynamic = "force-dynamic";

const FIELDS: FieldDef[] = [
  {
    type: "text",
    name: "code",
    label: "Code",
    required: true,
    half: true,
    mono: true,
    placeholder: "PTL-EXP",
  },
  {
    type: "select",
    name: "mode",
    label: "Mode",
    required: true,
    half: true,
    options: SHIPMENT_MODE_OPTIONS,
  },
  { type: "text", name: "name", label: "Name", required: true, placeholder: "Part Load — Express" },
  { type: "textarea", name: "description", label: "Description" },
  {
    type: "number",
    name: "volumetricDivisor",
    label: "Volumetric divisor",
    required: true,
    half: true,
    help: "(L×B×H cm) ÷ divisor. Road freight uses 4500 or 5000.",
  },
  {
    type: "number",
    name: "defaultTransitHours",
    label: "Default transit (hrs)",
    half: true,
    help: "Used when no lane SLA is set.",
  },
  {
    type: "number",
    name: "maxDeliveryAttempts",
    label: "Max delivery attempts",
    required: true,
    half: true,
    help: "RTO is proposed after this many.",
  },
  { type: "switch", name: "allowsCod", label: "Allow COD", help: "Cash collected on delivery." },
  { type: "switch", name: "allowsToPay", label: "Allow To-Pay", help: "Freight billed to the consignee." },
  { type: "switch", name: "isActive", label: "Active", help: "Inactive types cannot be booked." },
];

const MODE_TONE = SHIPMENT_MODE_TONE;

export default async function ServiceTypesPage() {
  const user = await requirePermission("master.read");
  const writable = can(user, "master.manage");

  const rows = await prisma.serviceType.findMany({
    orderBy: [{ isActive: "desc" }, { mode: "asc" }, { code: "asc" }],
  });

  return (
    <>
      <PageHeader
        eyebrow="Masters"
        title="Service types"
        description="What you sell. Each one sets its own volumetric divisor, transit expectation, and delivery-attempt policy."
        actions={
          writable && (
            <MasterFormDialog
              title="New service type"
              description="Codes appear on the LR and cannot be changed casually — pick one you can live with."
              fields={FIELDS}
              action={createServiceType}
              submitLabel="Create"
              trigger={{ label: "New service type", icon: "plus" }}
            />
          )
        }
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title="No service types yet"
            description="Add at least one before Phase 2, since every booking must name a service."
          />
        ) : (
          <Table className="min-w-[880px]">
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead className="text-right">Divisor</TableHead>
                <TableHead className="text-right">Transit</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Status</TableHead>
                {writable && <TableHead className="w-24 text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className={row.isActive ? "" : "opacity-55"}>
                  <TableCell className="font-mono text-xs font-medium">
                    {row.code}
                  </TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>
                    <span
                      className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${MODE_TONE[row.mode]}`}
                    >
                      {row.mode}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {row.volumetricDivisor}
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">
                    {row.defaultTransitHours ? `${row.defaultTransitHours} h` : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {row.maxDeliveryAttempts}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {[row.allowsCod && "COD", row.allowsToPay && "To-Pay"]
                      .filter(Boolean)
                      .join(" · ") || "Paid only"}
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
                          action={updateServiceType}
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
                          action={setServiceTypeActive}
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
