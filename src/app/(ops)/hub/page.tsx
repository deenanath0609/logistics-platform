import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowDownToLine,
  ClipboardList,
  Layers,
  PackageCheck,
  ScanLine,
  TriangleAlert,
  Truck,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame } from "@/components/data/data-shell";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Branch floor" };
export const dynamic = "force-dynamic";

/**
 * The branch floor.
 *
 * Everything here is a count of work, not a count of records: what is
 * coming, what is half-done, what is stuck. Each tile links to the screen
 * that clears it, because a dashboard that only tells you a number is a
 * dashboard nobody opens twice.
 */
export default async function HubPage() {
  const user = await requirePermission("scan.inbound");

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const atBranch = branchScope(user, "currentBranchId");
  const destined = branchScope(user, "destinationBranchId");

  const [
    expectedToday,
    openReceipts,
    receivedToday,
    pendingSort,
    awaitingDispatch,
    openDiscrepancies,
    arrivingVehicles,
    departingVehicles,
    scansToday,
  ] = await Promise.all([
    // Manifests dispatched to us and not yet received.
    prisma.manifest.aggregate({
      where: { status: "DISPATCHED", ...destined },
      _sum: { totalPackages: true },
      _count: true,
    }),

    prisma.inboundReceipt.count({
      where: { status: "OPEN", ...branchScope(user, "branchId") },
    }),

    prisma.scanRecord.findMany({
      where: {
        scanType: "INBOUND",
        recordedAt: { gte: startOfDay },
        ...branchScope(user, "branchId"),
      },
      distinct: ["barcode"],
      select: { barcode: true },
    }),

    prisma.shipment.count({
      where: {
        deletedAt: null,
        currentStatus: { in: ["RECEIVED_AT_ORIGIN", "RECEIVED_AT_HUB"] },
        ...atBranch,
      },
    }),

    prisma.shipment.count({
      where: { deletedAt: null, currentStatus: "PROCESSED", ...atBranch },
    }),

    prisma.receiptDiscrepancy.count({
      where: {
        resolvedAt: null,
        receipt: { ...branchScope(user, "branchId") },
      },
    }),

    prisma.trip.findMany({
      where: {
        status: { in: ["DISPATCHED", "IN_TRANSIT"] },
        ...branchScope(user, "destinationBranchId"),
      },
      orderBy: { plannedArrivalAt: "asc" },
      take: 8,
      select: {
        id: true,
        number: true,
        status: true,
        plannedArrivalAt: true,
        actualDepartureAt: true,
        vehicle: { select: { registrationNumber: true } },
        driver: { select: { name: true, mobile: true } },
        originBranch: { select: { code: true } },
        _count: { select: { manifests: true } },
      },
    }),

    prisma.trip.findMany({
      where: {
        status: { in: ["PLANNED", "VEHICLE_REPORTED", "LOADING"] },
        ...branchScope(user, "originBranchId"),
      },
      orderBy: { plannedDepartureAt: "asc" },
      take: 8,
      select: {
        id: true,
        number: true,
        status: true,
        plannedDepartureAt: true,
        vehicle: { select: { registrationNumber: true } },
        driver: { select: { name: true } },
        destinationBranch: { select: { code: true } },
        _count: { select: { manifests: true } },
      },
    }),

    prisma.scanRecord.count({
      where: { recordedAt: { gte: startOfDay }, ...branchScope(user, "branchId") },
    }),
  ]);

  const recentDiscrepancies = await prisma.receiptDiscrepancy.findMany({
    where: { resolvedAt: null, receipt: { ...branchScope(user, "branchId") } },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: {
      id: true,
      kind: true,
      barcode: true,
      createdAt: true,
      remarks: true,
      shipment: { select: { id: true, lrNumber: true } },
      receipt: {
        select: {
          id: true,
          manifest: {
            select: { number: true, originBranch: { select: { code: true } } },
          },
        },
      },
    },
  });

  const tiles = [
    {
      label: "Expected today",
      value: expectedToday._sum.totalPackages ?? 0,
      sub: `${expectedToday._count} manifest${expectedToday._count === 1 ? "" : "s"} on the road`,
      href: "/hub/inbound",
      icon: ArrowDownToLine,
      tone: "muted" as const,
    },
    {
      label: "Receipts open",
      value: openReceipts,
      sub: openReceipts > 0 ? "Half-scanned on the dock" : "Nothing part-done",
      href: "/hub/inbound",
      icon: PackageCheck,
      tone: openReceipts > 0 ? ("warn" as const) : ("muted" as const),
    },
    {
      label: "Received today",
      value: receivedToday.length,
      sub: `${scansToday} scan${scansToday === 1 ? "" : "s"} of all kinds`,
      href: "/hub/scan",
      icon: ScanLine,
      tone: "muted" as const,
    },
    {
      label: "Pending sort",
      value: pendingSort,
      sub: pendingSort > 0 ? "Received but not routed" : "Floor is clear",
      href: "/shipments?group=inNetwork",
      icon: Layers,
      tone: pendingSort > 0 ? ("warn" as const) : ("ok" as const),
    },
    {
      label: "Awaiting dispatch",
      value: awaitingDispatch,
      sub: "Sorted, ready for a manifest",
      href: "/dispatch/manifests",
      icon: ClipboardList,
      tone: "muted" as const,
    },
    {
      label: "Open discrepancies",
      value: openDiscrepancies,
      sub: openDiscrepancies > 0 ? "Short, excess, or damaged" : "Nothing outstanding",
      href: "/hub/inbound",
      icon: TriangleAlert,
      tone: openDiscrepancies > 0 ? ("bad" as const) : ("ok" as const),
    },
  ];

  const TONE: Record<string, string> = {
    muted: "bg-card",
    ok: "bg-ok-muted text-ok",
    warn: "bg-warn-muted text-warn",
    bad: "bg-bad-muted text-bad",
  };

  return (
    <>
      <PageHeader
        eyebrow={user.primaryBranch ? `${user.primaryBranch.code} · ${user.primaryBranch.name}` : "Hub operations"}
        title="Branch floor"
        description="What is coming, what is half-done, and what is stuck. Every number here is work waiting on somebody."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button render={<Link href="/hub/scan" />}>
              <ScanLine />
              Scan console
            </Button>
            <Button variant="outline" render={<Link href="/hub/inbound" />}>
              <ArrowDownToLine />
              Inbound
            </Button>
          </div>
        }
      />

      <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <Link
            key={tile.label}
            href={tile.href}
            className={`flex flex-col gap-1 rounded-lg border p-4 transition-colors hover:border-primary/40 ${TONE[tile.tone]}`}
          >
            <span className="flex items-center gap-1.5 font-mono text-[0.6rem] uppercase tracking-[0.13em] opacity-80">
              <tile.icon className="size-3" />
              {tile.label}
            </span>
            <span className="text-3xl font-semibold tabular">{tile.value}</span>
            <span className="text-xs opacity-80">{tile.sub}</span>
          </Link>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Arriving */}
        <section className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            <Truck className="size-3.5" />
            Vehicles arriving
          </h2>
          <TableFrame>
            {arrivingVehicles.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-muted-foreground">
                Nothing on the road to this branch.
              </p>
            ) : (
              <Table className="min-w-[520px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Trip</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>Vehicle</TableHead>
                    <TableHead>Due</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {arrivingVehicles.map((trip) => (
                    <TableRow key={trip.id}>
                      <TableCell>
                        <Link
                          href={`/dispatch/trips/${trip.id}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {trip.number}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {trip.originBranch.code}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="font-mono">
                          {trip.vehicle.registrationNumber}
                        </span>
                        {trip.driver && (
                          <span className="ml-2 text-muted-foreground">
                            {trip.driver.name}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                        {trip.plannedArrivalAt
                          ? format(trip.plannedArrivalAt, "dd MMM HH:mm")
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableFrame>
        </section>

        {/* Departing */}
        <section className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            <Truck className="size-3.5" />
            Vehicles departing
          </h2>
          <TableFrame>
            {departingVehicles.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-muted-foreground">
                No trip planned out of this branch.
              </p>
            ) : (
              <Table className="min-w-[520px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Trip</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Vehicle</TableHead>
                    <TableHead>Load</TableHead>
                    <TableHead>Planned</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {departingVehicles.map((trip) => (
                    <TableRow key={trip.id}>
                      <TableCell>
                        <Link
                          href={`/dispatch/trips/${trip.id}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {trip.number}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {trip.destinationBranch.code}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {trip.vehicle.registrationNumber}
                      </TableCell>
                      <TableCell className="text-xs">
                        {trip._count.manifests === 0 ? (
                          <span className="text-warn">Empty</span>
                        ) : (
                          <span className="text-muted-foreground">
                            {trip._count.manifests} manifest
                            {trip._count.manifests === 1 ? "" : "s"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                        {trip.plannedDepartureAt
                          ? format(trip.plannedDepartureAt, "dd MMM HH:mm")
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableFrame>
        </section>
      </div>

      {/* Discrepancies */}
      {recentDiscrepancies.length > 0 && can(user, "receipt.read") && (
        <section className="mt-8 flex flex-col gap-3">
          <h2 className="flex items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-bad">
            <TriangleAlert className="size-3.5" />
            Open discrepancies
          </h2>
          <TableFrame>
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Consignment</TableHead>
                  <TableHead>Barcode</TableHead>
                  <TableHead>Manifest</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Raised</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentDiscrepancies.map((discrepancy) => (
                  <TableRow key={discrepancy.id}>
                    <TableCell>
                      <span
                        className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${
                          discrepancy.kind === "SHORT"
                            ? "bg-bad-muted text-bad"
                            : "bg-warn-muted text-warn"
                        }`}
                      >
                        {discrepancy.kind.replace("_", " ")}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {discrepancy.shipment ? (
                        <Link
                          href={`/shipments/${discrepancy.shipment.id}`}
                          className="hover:underline"
                        >
                          {discrepancy.shipment.lrNumber}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs break-all">
                      {discrepancy.barcode ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/hub/inbound/${discrepancy.receipt.id}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {discrepancy.receipt.manifest?.number ?? "—"}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {discrepancy.receipt.manifest?.originBranch.code ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                      {format(discrepancy.createdAt, "dd MMM HH:mm")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        </section>
      )}
    </>
  );
}
