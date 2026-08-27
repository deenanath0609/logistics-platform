import type { Metadata } from "next";
import Link from "next/link";
import type { DriverStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import {
  canAssignDriver,
  daysUntilExpiry,
  utcDayFromNow,
} from "@/lib/fleet/availability";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { MasterFormDialog, type FieldDef } from "@/components/data/master-form";
import { FilterChips } from "@/components/fleet/filter-chips";
import { ExpiryDate } from "@/components/fleet/expiry";
import { DriverStatusPill } from "@/components/fleet/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createDriver } from "./actions";

export const metadata: Metadata = { title: "Drivers" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

function statusFilter(key: string | undefined, soon: Date): Prisma.DriverWhereInput {
  switch (key) {
    case "available":
      return { status: "AVAILABLE" };
    case "on_trip":
      return { status: "ON_TRIP" };
    case "unavailable":
      return { status: { in: ["ON_LEAVE", "SUSPENDED"] } };
    case "inactive":
      return { OR: [{ status: "INACTIVE" }, { isActive: false }] };
    case "licence":
      // A missing licence counts here too: an unrecorded licence is not a
      // valid one, and this is the list somebody works through.
      return {
        OR: [
          { licenceExpiry: { lt: soon } },
          { licenceExpiry: null },
          { licenceNumber: null },
        ],
      };
    default:
      return {};
  }
}

/**
 * Field definitions for the driver form. Exported so the detail page edits
 * the same record through the same fields.
 */
export function buildDriverFields(
  branches: Array<{ value: string; label: string }>,
  currentStatus?: DriverStatus,
): FieldDef[] {
  const statusOptions = [
    { value: "AVAILABLE", label: "Available" },
    { value: "ON_LEAVE", label: "On leave" },
    { value: "SUSPENDED", label: "Suspended" },
    { value: "INACTIVE", label: "Inactive" },
  ];
  if (currentStatus === "ON_TRIP") {
    statusOptions.unshift({ value: "ON_TRIP", label: "On a trip" });
  }

  return [
    {
      type: "text",
      name: "code",
      label: "Driver code",
      required: true,
      half: true,
      mono: true,
      placeholder: "DRV-014",
    },
    {
      type: "text",
      name: "name",
      label: "Full name",
      required: true,
      half: true,
    },
    {
      type: "text",
      name: "mobile",
      label: "Mobile",
      required: true,
      half: true,
      mono: true,
      help: "Ten digits. Also the sign-in identifier if they use the field app.",
    },
    {
      type: "text",
      name: "altMobile",
      label: "Alternate mobile",
      half: true,
      mono: true,
    },
    {
      type: "select",
      name: "branchId",
      label: "Home branch",
      half: true,
      options: branches,
      placeholder: "No home branch",
      help: "Decides who sees this driver.",
    },
    {
      type: "select",
      name: "status",
      label: "Status",
      required: true,
      half: true,
      options: statusOptions,
      help: "On-trip is written when a trip is assigned.",
    },
    {
      type: "text",
      name: "licenceNumber",
      label: "Licence number",
      half: true,
      mono: true,
      help: "Without it the driver cannot be put on a trip.",
    },
    {
      type: "text",
      name: "licenceClass",
      label: "Licence class",
      half: true,
      placeholder: "HMV / LMV",
    },
    {
      type: "date",
      name: "licenceExpiry",
      label: "Licence expiry",
      half: true,
      help: "An expired licence blocks assignment outright.",
    },
    { type: "text", name: "bloodGroup", label: "Blood group", half: true },
    {
      type: "text",
      name: "emergencyContactName",
      label: "Emergency contact",
      half: true,
    },
    {
      type: "text",
      name: "emergencyContactPhone",
      label: "Emergency phone",
      half: true,
      mono: true,
    },
    { type: "textarea", name: "address", label: "Address" },
    { type: "textarea", name: "notes", label: "Notes" },
    { type: "switch", name: "isActive", label: "On the roll" },
  ];
}

export default async function DriversPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const user = await requirePermission("driver.read");
  const canCreate = can(user, "driver.create");
  const { q, status, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const asOf = new Date();
  const soon = utcDayFromNow(30, asOf);
  const scope = branchScope(user, "branchId");

  const where: Prisma.DriverWhereInput = {
    deletedAt: null,
    ...scope,
    ...statusFilter(status, soon),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { code: { contains: q, mode: "insensitive" as const } },
            { mobile: { contains: q } },
            { licenceNumber: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const chipBase: Prisma.DriverWhereInput = { deletedAt: null, ...scope };

  const [rows, total, branches, counts] = await Promise.all([
    prisma.driver.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        code: true,
        name: true,
        mobile: true,
        status: true,
        isActive: true,
        deletedAt: true,
        licenceNumber: true,
        licenceClass: true,
        licenceExpiry: true,
        emergencyContactName: true,
        emergencyContactPhone: true,
        branch: { select: { code: true } },
      },
    }),
    prisma.driver.count({ where }),
    prisma.branch.findMany({
      where: { isActive: true, deletedAt: null, ...branchScope(user, "id") },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    Promise.all(
      (["available", "on_trip", "unavailable", "inactive", "licence"] as const).map(
        async (key) => ({
          key,
          count: await prisma.driver.count({
            where: { ...chipBase, ...statusFilter(key, soon) },
          }),
        }),
      ),
    ),
  ]);

  const countOf = (key: string) =>
    counts.find((entry) => entry.key === key)?.count ?? 0;

  const fields = buildDriverFields(
    branches.map((branch) => ({
      value: branch.id,
      label: `${branch.code} — ${branch.name}`,
    })),
  );

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Drivers"
        description={
          user.branchIds === null
            ? "Everyone who drives for the network. A lapsed or unrecorded licence blocks assignment to a trip."
            : "Drivers based at the branches you cover."
        }
        actions={
          <div className="flex items-center gap-2">
            <SearchInput placeholder="Search name, code, mobile, licence" />
            {canCreate && (
              <MasterFormDialog
                title="New driver"
                fields={fields}
                action={createDriver}
                submitLabel="Add driver"
                trigger={{ label: "New driver", icon: "plus" }}
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
            key: "unavailable",
            label: "Leave or suspended",
            count: countOf("unavailable"),
            tone: "warn",
          },
          { key: "inactive", label: "Inactive", count: countOf("inactive") },
          {
            key: "licence",
            label: "Licence attention",
            count: countOf("licence"),
            tone: "bad",
          },
        ]}
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title={q ? `Nothing matches “${q}”` : "No drivers here"}
            description={
              q ? "Try a mobile number, a driver code, or part of a name." : undefined
            }
          />
        ) : (
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead>Driver</TableHead>
                <TableHead>Mobile</TableHead>
                <TableHead>Licence</TableHead>
                <TableHead>Licence expiry</TableHead>
                <TableHead>Emergency contact</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Assignable</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const assignable = canAssignDriver(row, asOf);
                return (
                  <TableRow
                    key={row.id}
                    className={row.isActive ? "" : "opacity-55"}
                  >
                    <TableCell>
                      <Link
                        href={`/fleet/drivers/${row.id}`}
                        className="font-medium hover:underline"
                      >
                        {row.name}
                      </Link>
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {row.code}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.mobile}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.licenceNumber ? (
                        <>
                          <span className="font-mono">{row.licenceNumber}</span>
                          {row.licenceClass && (
                            <span className="ml-1.5 text-muted-foreground">
                              {row.licenceClass}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-bad">not on record</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <ExpiryDate
                        expiresOn={row.licenceExpiry}
                        daysRemaining={
                          row.licenceExpiry
                            ? daysUntilExpiry(row.licenceExpiry, asOf)
                            : undefined
                        }
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.emergencyContactName ? (
                        <>
                          {row.emergencyContactName}
                          {row.emergencyContactPhone && (
                            <span className="ml-1.5 font-mono">
                              {row.emergencyContactPhone}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-warn">none</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <DriverStatusPill status={row.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.branch?.code ?? (
                        <span className="text-warn">unassigned</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-block whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider ${
                          assignable.ok
                            ? "bg-ok-muted text-ok"
                            : "bg-bad-muted text-bad"
                        }`}
                        title={assignable.reason}
                      >
                        {assignable.ok ? "Yes" : "No"}
                      </span>
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
        baseParams={{ q, status }}
        pathname="/fleet/drivers"
      />
    </>
  );
}
