import type { Metadata } from "next";
import { MapPin } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
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
import { createBranch, updateBranch, setBranchActive } from "./actions";

export const metadata: Metadata = { title: "Branches & hubs" };
export const dynamic = "force-dynamic";

const TYPE_TONE: Record<string, string> = {
  HEAD_OFFICE: "bg-accent text-accent-foreground",
  HUB: "bg-info-muted text-info",
  BRANCH: "bg-muted text-muted-foreground",
  WAREHOUSE: "bg-warn-muted text-warn",
  FRANCHISE: "bg-ok-muted text-ok",
};

function buildFields(
  cities: Array<{ value: string; label: string }>,
  parents: Array<{ value: string; label: string }>,
): FieldDef[] {
  return [
    { type: "text", name: "code", label: "Code", required: true, half: true, mono: true, placeholder: "HUB-DEL" },
    {
      type: "select",
      name: "type",
      label: "Type",
      required: true,
      half: true,
      options: [
        { value: "HEAD_OFFICE", label: "Head office" },
        { value: "HUB", label: "Hub" },
        { value: "BRANCH", label: "Branch" },
        { value: "WAREHOUSE", label: "Warehouse" },
        { value: "FRANCHISE", label: "Franchise" },
      ],
    },
    { type: "text", name: "name", label: "Name", required: true, placeholder: "Delhi Hub" },
    {
      type: "select",
      name: "parentId",
      label: "Reports to",
      options: parents,
      placeholder: "No parent",
      half: true,
      help: "A branch rolls up to its hub; a hub to head office.",
    },
    { type: "select", name: "cityId", label: "City", required: true, half: true, options: cities },
    { type: "textarea", name: "address", label: "Address", required: true },
    { type: "text", name: "pincode", label: "PIN code", required: true, half: true, mono: true, placeholder: "110037" },
    { type: "text", name: "gstin", label: "GSTIN", half: true, mono: true },
    { type: "text", name: "phone", label: "Phone", half: true },
    { type: "text", name: "email", label: "Email", half: true },
    {
      type: "number",
      name: "latitude",
      label: "Latitude",
      half: true,
      step: "0.0000001",
      help: "Needed for the site geofence in Phase 7.",
    },
    { type: "number", name: "longitude", label: "Longitude", half: true, step: "0.0000001" },
    {
      type: "text",
      name: "bookingCutoff",
      label: "Booking cut-off",
      half: true,
      mono: true,
      placeholder: "18:00",
      help: "Bookings after this start their SLA clock next working day.",
    },
    { type: "text", name: "openingTime", label: "Opens", half: true, mono: true, placeholder: "09:00" },
    { type: "text", name: "closingTime", label: "Closes", half: true, mono: true, placeholder: "19:00" },
    { type: "switch", name: "isActive", label: "Active" },
  ];
}

export default async function BranchesPage() {
  const user = await requirePermission("branch.read");
  const writable = can(user, "branch.manage");

  const [rows, cities, allBranches] = await Promise.all([
    prisma.branch.findMany({
      where: { deletedAt: null, ...branchScope(user, "id") },
      orderBy: [{ isActive: "desc" }, { type: "asc" }, { code: "asc" }],
      include: {
        city: { select: { name: true, code: true } },
        parent: { select: { code: true } },
        _count: { select: { primaryUsers: true } },
      },
    }),
    prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true },
    }),
    prisma.branch.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  const fields = buildFields(
    cities.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` })),
    allBranches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })),
  );

  return (
    <>
      <PageHeader
        eyebrow="Network"
        title="Branches & hubs"
        description={
          user.branchIds === null
            ? "Every physical node in the network. Coordinates here become the site geofence that auto-generates vehicle arrivals."
            : "Nodes you have visibility of."
        }
        actions={
          writable && (
            <MasterFormDialog
              title="New branch or hub"
              fields={fields}
              action={createBranch}
              submitLabel="Create"
              trigger={{ label: "New branch", icon: "plus" }}
            />
          )
        }
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title="No branches visible"
            description="Either none exist yet, or your role is scoped to branches that have been removed."
          />
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Reports to</TableHead>
                <TableHead className="text-right">Staff</TableHead>
                <TableHead>Cut-off</TableHead>
                <TableHead>Geo</TableHead>
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
                      className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${TYPE_TONE[row.type]}`}
                    >
                      {row.type.replace("_", " ")}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.city.name}
                    <span className="ml-1 font-mono text-muted-foreground">
                      {row.city.code}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.parent?.code ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {row._count.primaryUsers}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.bookingCutoff ?? "—"}
                  </TableCell>
                  <TableCell>
                    {row.latitude && row.longitude ? (
                      <MapPin className="size-3.5 text-ok" aria-label="Coordinates set" />
                    ) : (
                      <span
                        className="text-xs text-warn"
                        title="No coordinates — geofencing cannot auto-detect arrivals here"
                      >
                        missing
                      </span>
                    )}
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
                          action={updateBranch}
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
                          action={setBranchActive}
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
