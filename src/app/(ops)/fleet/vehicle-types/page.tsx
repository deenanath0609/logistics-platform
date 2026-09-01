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
  createVehicleType,
  updateVehicleType,
  setVehicleTypeActive,
} from "./actions";

export const metadata: Metadata = { title: "Vehicle types" };
export const dynamic = "force-dynamic";

const FIELDS: FieldDef[] = [
  {
    type: "text",
    name: "code",
    label: "Code",
    required: true,
    half: true,
    mono: true,
    placeholder: "TATA-407",
  },
  {
    type: "text",
    name: "name",
    label: "Name",
    required: true,
    half: true,
    placeholder: "Tata 407 — 2.5T",
  },
  {
    type: "number",
    name: "capacityKg",
    label: "Payload (kg)",
    required: true,
    half: true,
    step: "0.01",
    help: "Drives manifest utilisation, so keep it honest rather than optimistic.",
  },
  {
    type: "number",
    name: "capacityCft",
    label: "Volume (CFT)",
    half: true,
    step: "0.01",
    help: "For bulky, light freight that cubes out before it weighs out.",
  },
  { type: "number", name: "lengthFt", label: "Length (ft)", half: true, step: "0.01" },
  { type: "number", name: "widthFt", label: "Width (ft)", half: true, step: "0.01" },
  { type: "number", name: "heightFt", label: "Height (ft)", half: true, step: "0.01" },
  {
    type: "number",
    name: "axles",
    label: "Axles",
    half: true,
    step: "1",
    help: "Decides toll class and permitted gross weight.",
  },
  {
    type: "number",
    name: "maxSpeedKmph",
    label: "Overspeed above (km/h)",
    half: true,
    step: "1",
    help: "Raises an overspeed alert on this class. Blank switches the check off for it.",
  },
  {
    type: "number",
    name: "sortOrder",
    label: "Sort order",
    half: true,
    step: "1",
    help: "Lowest first in every vehicle picker.",
  },
  { type: "switch", name: "isActive", label: "Active" },
];

/** Renders a Prisma Decimal without dragging decimal.js into the view. */
function num(value: unknown, suffix = ""): string {
  if (value === null || value === undefined) return "—";
  const asNumber = Number(value);
  if (Number.isNaN(asNumber)) return "—";
  return `${asNumber.toLocaleString("en-IN")}${suffix}`;
}

export default async function VehicleTypesPage() {
  const user = await requirePermission("vehicle.read");
  const writable = can(user, "vehicle.create");

  const rows = await prisma.vehicleType.findMany({
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { code: "asc" }],
    include: { _count: { select: { vehicles: true } } },
  });

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Vehicle types"
        description="The capacity classes the fleet is built from. Payload here is what manifest utilisation is measured against."
        actions={
          writable && (
            <MasterFormDialog
              title="New vehicle type"
              fields={FIELDS}
              action={createVehicleType}
              submitLabel="Create"
              trigger={{ label: "New type", icon: "plus" }}
            />
          )
        }
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title="No vehicle types yet"
            description="Add the classes you run — a 407, a 32-ft multi-axle — before adding vehicles."
          />
        ) : (
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Payload</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead>Body (L × W × H)</TableHead>
                <TableHead className="text-right">Axles</TableHead>
                <TableHead className="text-right">Vehicles</TableHead>
                <TableHead>Status</TableHead>
                {writable && (
                  <TableHead className="w-24 text-right">Actions</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className={row.isActive ? "" : "opacity-55"}>
                  <TableCell className="font-mono text-xs font-medium">
                    {row.code}
                  </TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-right tabular">
                    {num(row.capacityKg, " kg")}
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">
                    {num(row.capacityCft, " cft")}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.lengthFt && row.widthFt && row.heightFt
                      ? `${num(row.lengthFt)} × ${num(row.widthFt)} × ${num(row.heightFt)} ft`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">
                    {row.axles ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {row._count.vehicles}
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
                          action={updateVehicleType}
                          record={row as unknown as Record<string, unknown>}
                          trigger={{
                            label: `Edit ${row.code}`,
                            icon: "pencil",
                            variant: "ghost",
                            size: "icon-sm",
                            iconOnly: true,
                          }}
                        />
                        {/* Turning a class off removes it from the
                            rate-line picker, which filters on
                            `isActive: true` — so a class with forty
                            lorries still running it could be switched off
                            in silence and no payable rate could then be
                            expressed for any of them. The count is
                            already on the row; the button now reads it. */}
                        <ToggleActive
                          id={row.id}
                          isActive={row.isActive}
                          label={row.code}
                          action={setVehicleTypeActive}
                          disabled={row.isActive && row._count.vehicles > 0}
                          disabledReason={
                            row.isActive && row._count.vehicles > 0
                              ? `${row._count.vehicles} vehicle${row._count.vehicles === 1 ? " is" : "s are"} still on ${row.code}. Move or retire ${row._count.vehicles === 1 ? "it" : "them"} first — deactivating now would leave no rate expressible for a class the fleet is running.`
                              : undefined
                          }
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
