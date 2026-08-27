import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma, VehicleStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { documentHealth, startOfUtcDay } from "@/lib/fleet/availability";
import { formatRegistration, normaliseRegistration } from "@/lib/fleet/registration";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { MasterFormDialog, type FieldDef } from "@/components/data/master-form";
import { FilterChips, FilterSelect } from "@/components/fleet/filter-chips";
import { HealthBadge } from "@/components/fleet/expiry";
import { OwnershipTag, VehicleStatusPill } from "@/components/fleet/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createVehicle } from "./actions";

export const metadata: Metadata = { title: "Vehicles" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * Chip groups. "Blocked" is not a `VehicleStatus` — it is a document fact
 * that cuts across every status, and it is the one a transport desk needs
 * first thing in the morning, so it gets a chip of its own.
 */
const ON_TRIP: VehicleStatus[] = [
  "ASSIGNED",
  "LOADING",
  "DISPATCHED",
  "IN_TRANSIT",
  "AT_HUB",
  "UNLOADING",
];

function statusFilter(key: string | undefined, today: Date): Prisma.VehicleWhereInput {
  switch (key) {
    case "available":
      return { status: "AVAILABLE" };
    case "on_trip":
      return { status: { in: ON_TRIP } };
    case "maintenance":
      return { status: "MAINTENANCE" };
    case "inactive":
      return { OR: [{ status: "INACTIVE" }, { isActive: false }] };
    case "blocked":
      return {
        documents: { some: { isMandatory: true, expiresOn: { lt: today } } },
      };
    default:
      return {};
  }
}

/**
 * Field definitions for the vehicle form.
 *
 * Exported because the detail page edits the same record with the same
 * fields, and two divergent copies of a form is how a field ends up
 * editable in one place and not the other.
 *
 * `currentStatus` widens the status list to include whatever the trip
 * machine has already set, so editing an in-transit vehicle does not
 * silently offer to reset it.
 */
export function buildVehicleFields(
  types: Array<{ value: string; label: string }>,
  branches: Array<{ value: string; label: string }>,
  currentStatus?: VehicleStatus,
): FieldDef[] {
  const statusOptions = [
    { value: "AVAILABLE", label: "Available" },
    { value: "MAINTENANCE", label: "In maintenance" },
    { value: "INACTIVE", label: "Inactive" },
  ];
  if (
    currentStatus &&
    !statusOptions.some((option) => option.value === currentStatus)
  ) {
    statusOptions.unshift({
      value: currentStatus,
      label: `${currentStatus.replace(/_/g, " ").toLowerCase()} (on a trip)`,
    });
  }

  return [
    {
      type: "text",
      name: "registrationNumber",
      label: "Registration number",
      required: true,
      half: true,
      mono: true,
      placeholder: "HR26AB1234",
      help: "Spaces and hyphens are stripped before storing.",
    },
    {
      type: "select",
      name: "vehicleTypeId",
      label: "Vehicle type",
      required: true,
      half: true,
      options: types,
    },
    {
      type: "select",
      name: "ownership",
      label: "Ownership",
      required: true,
      half: true,
      options: [
        { value: "OWN", label: "Own" },
        { value: "VENDOR", label: "Vendor" },
        { value: "ATTACHED", label: "Attached" },
      ],
    },
    {
      type: "select",
      name: "branchId",
      label: "Home branch",
      half: true,
      options: branches,
      placeholder: "No home branch",
      help: "Decides who sees this vehicle.",
    },
    {
      type: "select",
      name: "status",
      label: "Status",
      required: true,
      half: true,
      options: statusOptions,
      help: "Trip statuses are written by trip events, not here.",
    },
    {
      type: "number",
      name: "currentOdometerKm",
      label: "Odometer (km)",
      half: true,
      step: "1",
    },
    { type: "text", name: "make", label: "Make", half: true, placeholder: "Tata" },
    { type: "text", name: "model", label: "Model", half: true, placeholder: "407 Gold" },
    {
      type: "number",
      name: "manufactureYear",
      label: "Year",
      half: true,
      step: "1",
      placeholder: "2021",
    },
    {
      type: "text",
      name: "fastagId",
      label: "FASTag ID",
      half: true,
      mono: true,
    },
    {
      type: "text",
      name: "gpsDeviceId",
      label: "GPS device ID",
      mono: true,
      help: "Matched against incoming pings from Phase 7. Leave blank for a vehicle with no telematics.",
    },
    { type: "textarea", name: "notes", label: "Notes" },
    { type: "switch", name: "isActive", label: "In the fleet" },
  ];
}

export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    ownership?: string;
    page?: string;
  }>;
}) {
  const user = await requirePermission("vehicle.read");
  const canCreate = can(user, "vehicle.create");
  const { q, status, ownership, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const asOf = new Date();
  const today = startOfUtcDay(asOf);
  const scope = branchScope(user, "branchId");

  const registration = q ? normaliseRegistration(q) : "";

  const where: Prisma.VehicleWhereInput = {
    deletedAt: null,
    ...scope,
    ...statusFilter(status, today),
    ...(ownership ? { ownership: ownership as never } : {}),
    ...(q
      ? {
          OR: [
            ...(registration
              ? [{ registrationNumber: { contains: registration } }]
              : []),
            { make: { contains: q, mode: "insensitive" as const } },
            { model: { contains: q, mode: "insensitive" as const } },
            { gpsDeviceId: { contains: q, mode: "insensitive" as const } },
            { fastagId: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const chipBase: Prisma.VehicleWhereInput = { deletedAt: null, ...scope };

  const [rows, total, types, branches, counts] = await Promise.all([
    prisma.vehicle.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { registrationNumber: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        registrationNumber: true,
        ownership: true,
        status: true,
        isActive: true,
        make: true,
        model: true,
        vehicleType: { select: { code: true, name: true, capacityKg: true } },
        branch: { select: { code: true } },
        documents: {
          select: { kind: true, expiresOn: true, isMandatory: true },
        },
      },
    }),
    prisma.vehicle.count({ where }),
    prisma.vehicleType.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: { id: true, code: true, name: true },
    }),
    prisma.branch.findMany({
      where: { isActive: true, deletedAt: null, ...branchScope(user, "id") },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    Promise.all(
      (["available", "on_trip", "maintenance", "inactive", "blocked"] as const).map(
        async (key) => ({
          key,
          count: await prisma.vehicle.count({
            where: { ...chipBase, ...statusFilter(key, today) },
          }),
        }),
      ),
    ),
  ]);

  const countOf = (key: string) =>
    counts.find((entry) => entry.key === key)?.count ?? 0;

  const fields = buildVehicleFields(
    types.map((type) => ({ value: type.id, label: `${type.code} — ${type.name}` })),
    branches.map((branch) => ({
      value: branch.id,
      label: `${branch.code} — ${branch.name}`,
    })),
  );

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Vehicles"
        description={
          user.branchIds === null
            ? "Every truck on the books — own, vendor and attached. A vehicle whose mandatory paperwork has lapsed shows as blocked and cannot be put on a trip."
            : "Vehicles homed at the branches you cover."
        }
        actions={
          <div className="flex items-center gap-2">
            <SearchInput placeholder="Search registration, make, GPS id" />
            {canCreate && (
              <MasterFormDialog
                title="New vehicle"
                description="Registration is stored stripped and uppercased, so it matches however it is typed later."
                fields={fields}
                action={createVehicle}
                submitLabel="Add vehicle"
                trigger={{ label: "New vehicle", icon: "plus" }}
              />
            )}
          </div>
        }
      />

      <FilterChips
        param="status"
        selected={status}
        chips={[
          { key: "available", label: "Available", count: countOf("available") },
          { key: "on_trip", label: "On a trip", count: countOf("on_trip") },
          {
            key: "maintenance",
            label: "Maintenance",
            count: countOf("maintenance"),
            tone: "warn",
          },
          { key: "inactive", label: "Inactive", count: countOf("inactive") },
          {
            key: "blocked",
            label: "Documents expired",
            count: countOf("blocked"),
            tone: "bad",
          },
        ]}
        extra={
          <FilterSelect
            param="ownership"
            label="All ownership"
            value={ownership}
            options={[
              { value: "OWN", label: "Own" },
              { value: "VENDOR", label: "Vendor" },
              { value: "ATTACHED", label: "Attached" },
            ]}
          />
        }
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title={q ? `Nothing matches “${q}”` : "No vehicles here"}
            description={
              q
                ? "Registration is matched without spaces, so “hr26” and “HR 26” find the same trucks."
                : "Add a vehicle type first, then the vehicles that run on it."
            }
          />
        ) : (
          <Table className="min-w-[960px]">
            <TableHeader>
              <TableRow>
                <TableHead>Registration</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Ownership</TableHead>
                <TableHead className="text-right">Capacity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Documents</TableHead>
                <TableHead>Branch</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const health = documentHealth(row.documents, asOf);
                return (
                  <TableRow
                    key={row.id}
                    className={row.isActive ? "" : "opacity-55"}
                  >
                    <TableCell>
                      <Link
                        href={`/fleet/vehicles/${row.id}`}
                        className="font-mono text-xs font-semibold hover:underline"
                      >
                        {formatRegistration(row.registrationNumber)}
                      </Link>
                      {(row.make || row.model) && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {[row.make, row.model].filter(Boolean).join(" ")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="font-mono">{row.vehicleType.code}</span>
                    </TableCell>
                    <TableCell>
                      <OwnershipTag ownership={row.ownership} />
                    </TableCell>
                    <TableCell className="text-right tabular text-xs">
                      {Number(row.vehicleType.capacityKg).toLocaleString("en-IN")} kg
                    </TableCell>
                    <TableCell>
                      <VehicleStatusPill status={row.status} />
                    </TableCell>
                    <TableCell>
                      <HealthBadge health={health} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.branch?.code ?? (
                        <span className="text-warn">unassigned</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        baseParams={{ q, status, ownership }}
        pathname="/fleet/vehicles"
      />
    </>
  );
}
