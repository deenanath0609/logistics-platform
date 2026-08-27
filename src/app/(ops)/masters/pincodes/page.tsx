import type { Metadata } from "next";
import { Upload } from "lucide-react";
import { requirePermission, can } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { MasterFormDialog, type FieldDef } from "@/components/data/master-form";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createPincode, updatePincode } from "./actions";

export const metadata: Metadata = { title: "Pincodes" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

function buildFields(
  cities: Array<{ value: string; label: string }>,
  branches: Array<{ value: string; label: string }>,
): FieldDef[] {
  return [
    {
      type: "text",
      name: "code",
      label: "PIN code",
      required: true,
      half: true,
      mono: true,
      placeholder: "302020",
      help: "Six digits. Must be unique.",
    },
    { type: "select", name: "cityId", label: "City", required: true, half: true, options: cities },
    {
      type: "text",
      name: "areaName",
      label: "Area",
      placeholder: "Malviya Nagar",
      help: "Shown to the booking clerk to confirm they have the right PIN.",
    },
    {
      type: "select",
      name: "servingBranchId",
      label: "Delivered by",
      options: branches,
      placeholder: "Unassigned",
      help: "The branch responsible for the last mile here.",
    },
    {
      type: "number",
      name: "latitude",
      label: "Latitude",
      half: true,
      step: "0.0000001",
      help: "Optional. Used for delivery-zone geofencing in Phase 7.",
    },
    { type: "number", name: "longitude", label: "Longitude", half: true, step: "0.0000001" },
    {
      type: "switch",
      name: "isServiceable",
      label: "Serviceable",
      help: "Off blocks booking to this PIN unless the clerk holds the override permission.",
    },
    {
      type: "switch",
      name: "isOda",
      label: "Out of delivery area (ODA)",
      help: "Triggers the ODA charge and a longer transit expectation.",
    },
  ];
}

export default async function PincodesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const user = await requirePermission("master.read");
  const writable = can(user, "master.manage");
  const { q, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const where = q
    ? {
        OR: [
          { code: { contains: q } },
          { areaName: { contains: q, mode: "insensitive" as const } },
          { city: { name: { contains: q, mode: "insensitive" as const } } },
        ],
      }
    : {};

  const [rows, total, serviceable, oda, unassigned, cities, branches] =
    await Promise.all([
      prisma.pincode.findMany({
        where,
        orderBy: { code: "asc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          city: { select: { id: true, name: true, code: true } },
          servingBranch: { select: { code: true, name: true } },
        },
      }),
      prisma.pincode.count({ where }),
      prisma.pincode.count({ where: { isServiceable: true } }),
      prisma.pincode.count({ where: { isOda: true } }),
      prisma.pincode.count({ where: { servingBranchId: null } }),
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
    branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })),
  );

  return (
    <>
      <PageHeader
        eyebrow="Network"
        title="Pincodes"
        description="Serviceability and ODA classification. The booking screen checks this list as the clerk types, so a PIN missing here cannot be booked to."
        actions={
          <div className="flex items-center gap-2">
            <SearchInput placeholder="Search PIN, area, city" />
            {writable && (
              <>
                <Button
                  variant="outline"
                  render={<Link href="/masters/pincodes/import" />}
                >
                  <Upload />
                  Import
                </Button>
                <MasterFormDialog
                  title="New PIN code"
                  description="Adding a PIN makes it bookable immediately."
                  fields={fields}
                  action={createPincode}
                  record={{ isServiceable: "true", isOda: "false" }}
                  submitLabel="Add PIN code"
                  trigger={{ label: "New PIN code", icon: "plus" }}
                />
              </>
            )}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap gap-3">
        {[
          { label: "Total", value: total },
          { label: "Serviceable", value: serviceable },
          { label: "ODA", value: oda },
          { label: "No delivery branch", value: unassigned, warn: unassigned > 0 },
        ].map((stat) => (
          <div
            key={stat.label}
            className="flex items-baseline gap-2 rounded-md border bg-card px-3 py-1.5"
          >
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              {stat.label}
            </span>
            <span
              className={`text-sm font-semibold tabular ${stat.warn ? "text-warn" : ""}`}
            >
              {stat.value}
            </span>
          </div>
        ))}
      </div>

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title={q ? `Nothing matches “${q}”` : "No pincodes yet"}
            description={
              q
                ? "Try the 6-digit code or a city name."
                : "Add the PIN codes you deliver to, or import them in bulk."
            }
          />
        ) : (
          <Table className="min-w-[820px]">
            <TableHeader>
              <TableRow>
                <TableHead>PIN</TableHead>
                <TableHead>Area</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Delivered by</TableHead>
                <TableHead>Serviceability</TableHead>
                {writable && <TableHead className="w-16 text-right">Edit</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs font-medium">
                    {row.code}
                  </TableCell>
                  <TableCell>{row.areaName ?? "—"}</TableCell>
                  <TableCell className="text-xs">
                    {row.city.name}
                    <span className="ml-1 font-mono text-muted-foreground">
                      {row.city.code}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.servingBranch ? (
                      <span className="font-mono">{row.servingBranch.code}</span>
                    ) : (
                      <span
                        className="text-warn"
                        title="No branch owns delivery to this PIN"
                      >
                        unassigned
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {row.isServiceable ? (
                        <span className="rounded-sm bg-ok-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-ok">
                          Serviceable
                        </span>
                      ) : (
                        <span className="rounded-sm bg-bad-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-bad">
                          Blocked
                        </span>
                      )}
                      {row.isOda && (
                        <span className="rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-warn">
                          ODA
                        </span>
                      )}
                    </div>
                  </TableCell>
                  {writable && (
                    <TableCell className="text-right">
                      <MasterFormDialog
                        title={`Edit ${row.code}`}
                        fields={fields}
                        action={updatePincode}
                        record={row as unknown as Record<string, unknown>}
                        trigger={{
                          label: `Edit ${row.code}`,
                          icon: "pencil",
                          variant: "ghost",
                          size: "icon-sm",
                          iconOnly: true,
                        }}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        baseParams={{ q }}
        pathname="/masters/pincodes"
      />
    </>
  );
}
