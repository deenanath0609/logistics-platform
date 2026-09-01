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
  counter: "Coming to the counter",
  inNetwork: "In the network",
  moving: "In transit",
  lastMile: "Last mile",
  done: "Delivered",
  exception: "Exceptions",
};

/**
 * What each chip actually asks the database.
 *
 * `STATUS_GROUPS` is a status vocabulary and stays one; this is where the
 * list adds the one thing status alone cannot say. "Awaiting pickup" used
 * to mean `BOOKED` or `PICKUP_ASSIGNED` and nothing else, so a consignment
 * the consignor is walking in with — booked with "Needs pickup" off — sat
 * in the same chip as the ones a van has to be sent for. A duty manager
 * reading "Awaiting pickup 19" could not tell how many vans that was, and
 * the ones nobody was collecting never appeared on `/pickups` either,
 * because no pickup exists for them.
 *
 * So they are two chips. Both are still `BOOKED`; the difference is who is
 * doing the moving.
 */
const GROUP_WHERE: Record<string, Record<string, unknown>> = {
  pending: {
    currentStatus: { in: STATUS_GROUPS.pending },
    pickupRequired: true,
  },
  counter: {
    currentStatus: { in: ["BOOKED"] },
    pickupRequired: false,
  },
  inNetwork: { currentStatus: { in: STATUS_GROUPS.inNetwork } },
  moving: { currentStatus: { in: STATUS_GROUPS.moving } },
  lastMile: { currentStatus: { in: STATUS_GROUPS.lastMile } },
  done: { currentStatus: { in: STATUS_GROUPS.done } },
  exception: { currentStatus: { in: STATUS_GROUPS.exception } },
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

  const groupFilter = group && group in GROUP_WHERE ? GROUP_WHERE[group] : undefined;

  /**
   * ── Two `OR`s cannot share one object ────────────────────────────────
   *
   * `anyBranchScope` returns `{ OR: [...] }` — a shipment is visible to its
   * origin, its current location and its destination. The search returns
   * `{ OR: [...] }` too. Spread into the same literal, the second key wins
   * and the first simply disappears: the moment anybody typed anything into
   * the search box, this list dropped its branch filter entirely and
   * answered from the whole network.
   *
   * It was invisible because it needed a search to appear at all. An empty
   * box scoped correctly, the counts on the chips scoped correctly, and the
   * detail page refused the row — so the only way to see it was to search a
   * Jaipur LR number at a Gurugram counter and click nothing. That is the
   * Phase 1 acceptance test, failing through a text input.
   *
   * `AND` is a list, so both conditions survive being written down next to
   * each other. Anything else that produces an `OR` belongs in this array
   * rather than in the object.
   */
  const scoped = anyBranchScope(user, [
    "originBranchId",
    "currentBranchId",
    "destinationBranchId",
  ]);

  const where = {
    deletedAt: null,
    AND: [
      scoped,
      ...(q
        ? [
            {
              OR: [
                { lrNumber: { contains: q, mode: "insensitive" as const } },
                { consigneeName: { contains: q, mode: "insensitive" as const } },
                { consigneePhone: { contains: q } },
                { consignorName: { contains: q, mode: "insensitive" as const } },
                { consignorPhone: { contains: q } },
                { customerReference: { contains: q, mode: "insensitive" as const } },
              ],
            },
          ]
        : []),
    ],
    ...(groupFilter ?? {}),
    ...(mode ? { mode: mode as never } : {}),
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
      Object.entries(GROUP_WHERE).map(async ([key, filter]) => ({
        key,
        count: await prisma.shipment.count({
          // `AND` here too, for the same reason: `filter` is a plain object
          // today, and the day one of the chips needs an `OR` it must not
          // silently take the scope's place.
          where: { deletedAt: null, AND: [scoped], ...filter },
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
