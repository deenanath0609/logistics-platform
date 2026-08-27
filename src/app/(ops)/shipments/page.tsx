import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { Plus, PauseCircle } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { anyBranchScope } from "@/server/repositories/scope";
import { STATUS_GROUPS } from "@/lib/shipment/state-machine";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { StatusPill } from "@/components/shipment/status-pill";
import { ShipmentFilters } from "./filters";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Shipments" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const GROUP_LABEL: Record<string, string> = {
  pending: "Awaiting pickup",
  inNetwork: "In the network",
  moving: "In transit",
  lastMile: "Last mile",
  done: "Delivered",
  exception: "Exceptions",
};

export default async function ShipmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; group?: string; mode?: string; page?: string }>;
}) {
  const user = await requirePermission("shipment.read");
  const canBook = can(user, "shipment.create");
  const { q, group, mode, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const groupStatuses =
    group && group in STATUS_GROUPS
      ? STATUS_GROUPS[group as keyof typeof STATUS_GROUPS]
      : undefined;

  const where = {
    deletedAt: null,
    // A shipment is visible to its origin, its current location, and its
    // destination — all three branches have a legitimate interest in it.
    ...anyBranchScope(user, [
      "originBranchId",
      "currentBranchId",
      "destinationBranchId",
    ]),
    ...(groupStatuses ? { currentStatus: { in: groupStatuses } } : {}),
    ...(mode ? { mode: mode as never } : {}),
    ...(q
      ? {
          OR: [
            { lrNumber: { contains: q, mode: "insensitive" as const } },
            { consigneeName: { contains: q, mode: "insensitive" as const } },
            { consigneePhone: { contains: q } },
            { consignorName: { contains: q, mode: "insensitive" as const } },
            { consignorPhone: { contains: q } },
            { customerReference: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, total, counts] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { bookedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        lrNumber: true,
        mode: true,
        currentStatus: true,
        isOnHold: true,
        attemptCount: true,
        bookedAt: true,
        packageCount: true,
        chargeableWeight: true,
        grandTotal: true,
        paymentType: true,
        codAmount: true,
        consignorName: true,
        consigneeName: true,
        originBranch: { select: { code: true } },
        destinationBranch: { select: { code: true } },
        currentBranch: { select: { code: true } },
      },
    }),
    prisma.shipment.count({ where }),
    // Counts per group for the filter chips, so a duty manager sees where
    // the volume sits before clicking anything.
    Promise.all(
      Object.entries(STATUS_GROUPS).map(async ([key, statuses]) => ({
        key,
        count: await prisma.shipment.count({
          where: {
            deletedAt: null,
            ...anyBranchScope(user, [
              "originBranchId",
              "currentBranchId",
              "destinationBranchId",
            ]),
            currentStatus: { in: statuses },
          },
        }),
      })),
    ),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Shipments"
        description="Every consignment in the network. Status here is produced by scans and field actions — nobody types it in."
        actions={
          <div className="flex items-center gap-2">
            <SearchInput placeholder="LR, phone, name, reference" />
            {canBook && (
              <Button render={<Link href="/shipments/new" />}>
                <Plus />
                New booking
              </Button>
            )}
          </div>
        }
      />

      <ShipmentFilters
        groups={counts.map((c) => ({
          key: c.key,
          label: GROUP_LABEL[c.key] ?? c.key,
          count: c.count,
        }))}
        selectedGroup={group}
        selectedMode={mode}
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title={q ? `Nothing matches “${q}”` : "No shipments here"}
            description={
              q
                ? "Try the LR number or a phone number."
                : group
                  ? "Nothing is sitting in this stage right now."
                  : "Book the first consignment to get started."
            }
            action={
              canBook && !q ? (
                <Button variant="outline" render={<Link href="/shipments/new" />}>
                  <Plus />
                  New booking
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table className="min-w-[1000px]">
            <TableHeader>
              <TableRow>
                <TableHead>LR number</TableHead>
                <TableHead>Booked</TableHead>
                <TableHead>Lane</TableHead>
                <TableHead>Consignor → Consignee</TableHead>
                <TableHead className="text-right">Pkgs</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>At</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={`/shipments/${row.id}`}
                      className="font-mono text-xs font-medium hover:underline"
                    >
                      {row.lrNumber}
                    </Link>
                    <span className="ml-2 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                      {row.mode}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                    {format(row.bookedAt, "dd MMM HH:mm")}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {row.originBranch.code}
                    <span className="mx-1 text-muted-foreground">→</span>
                    {row.destinationBranch.code}
                  </TableCell>
                  <TableCell className="max-w-[240px] truncate text-sm">
                    {row.consignorName}
                    <span className="mx-1 text-muted-foreground">→</span>
                    {row.consigneeName}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {row.packageCount}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular">
                    {Number(row.chargeableWeight)} kg
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {row.paymentType === "COD" ? (
                      <span className="text-warn">
                        COD ₹{Number(row.codAmount ?? 0).toLocaleString("en-IN")}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {row.paymentType.replace("_", "-")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.currentBranch?.code ?? "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <StatusPill status={row.currentStatus} />
                      {row.isOnHold && (
                        <span
                          className="inline-flex items-center gap-1 rounded-sm bg-bad-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-bad"
                          title="On hold"
                        >
                          <PauseCircle className="size-2.5" />
                          Hold
                        </span>
                      )}
                      {row.attemptCount > 0 && (
                        <span
                          className="rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-warn"
                          title={`${row.attemptCount} failed delivery attempt(s)`}
                        >
                          {row.attemptCount}×
                        </span>
                      )}
                    </div>
                  </TableCell>
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
        baseParams={{ q, group, mode }}
        pathname="/shipments"
      />
    </>
  );
}
