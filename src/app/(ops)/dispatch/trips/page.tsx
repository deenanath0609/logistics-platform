import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { anyBranchScope, branchScope } from "@/server/repositories/scope";
import { FTL_BINDABLE_STATUSES } from "@/lib/transport/trip";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreateTripDialog } from "./create-trip";

export const metadata: Metadata = { title: "Trips" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const STATUS_TONE: Record<string, string> = {
  PLANNED: "bg-muted text-muted-foreground",
  VEHICLE_REPORTED: "bg-accent text-accent-foreground",
  LOADING: "bg-warn-muted text-warn",
  DISPATCHED: "bg-info-muted text-info",
  IN_TRANSIT: "bg-info-muted text-info",
  ARRIVED: "bg-warn-muted text-warn",
  UNLOADING: "bg-warn-muted text-warn",
  COMPLETED: "bg-ok-muted text-ok",
  CANCELLED: "bg-bad-muted text-bad",
};

export default async function TripsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const user = await requirePermission("trip.read");
  const { status, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const canCreate = can(user, "trip.create");

  const where = {
    ...anyBranchScope(user, ["originBranchId", "destinationBranchId"]),
    ...(status ? { status: status as never } : {}),
  };

  const [rows, total, vehicles, drivers, branches, routes, ftlShipments] =
    await Promise.all([
      prisma.trip.findMany({
        where,
        orderBy: [{ plannedDepartureAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          number: true,
          status: true,
          plannedDepartureAt: true,
          actualDepartureAt: true,
          actualArrivalAt: true,
          sealNumber: true,
          ftlShipmentId: true,
          ftlShipment: { select: { lrNumber: true } },
          originBranch: { select: { code: true } },
          destinationBranch: { select: { code: true } },
          vehicle: {
            select: {
              registrationNumber: true,
              vehicleType: { select: { name: true } },
            },
          },
          driver: { select: { name: true, mobile: true } },
          _count: { select: { manifests: true } },
        },
      }),
      prisma.trip.count({ where }),

      canCreate
        ? prisma.vehicle.findMany({
            where: {
              deletedAt: null,
              isActive: true,
              status: { notIn: ["MAINTENANCE", "INACTIVE"] },
            },
            orderBy: { registrationNumber: "asc" },
            select: {
              id: true,
              registrationNumber: true,
              status: true,
              vehicleType: { select: { name: true, capacityKg: true } },
            },
          })
        : [],

      canCreate
        ? prisma.driver.findMany({
            where: { status: { notIn: ["SUSPENDED", "INACTIVE"] } },
            orderBy: { name: "asc" },
            select: { id: true, name: true, mobile: true, status: true },
          })
        : [],

      canCreate
        ? prisma.branch.findMany({
            where: { deletedAt: null, isActive: true },
            orderBy: { code: "asc" },
            select: { id: true, code: true, name: true },
          })
        : [],

      canCreate
        ? prisma.route.findMany({
            where: { isActive: true },
            orderBy: { code: "asc" },
            select: { id: true, code: true, name: true },
          })
        : [],

      // FTL consignments waiting for a truck of their own.
      canCreate
        ? prisma.shipment.findMany({
            where: {
              deletedAt: null,
              mode: "FTL",
              isOnHold: false,
              currentStatus: { in: [...FTL_BINDABLE_STATUSES] },
              // Not already on a truck. Without this the picker keeps
              // offering a consignment that is bound to an open trip, and
              // the only thing that says so is the refusal after submit.
              ftlTrips: { none: { status: { notIn: ["COMPLETED", "CANCELLED"] } } },
              ...branchScope(user, "currentBranchId"),
            },
            orderBy: { bookedAt: "asc" },
            take: 50,
            select: {
              id: true,
              lrNumber: true,
              consigneeName: true,
              originBranchId: true,
              currentBranchId: true,
              destinationBranchId: true,
            },
          })
        : [],
    ]);

  return (
    <>
      <PageHeader
        eyebrow="Dispatch"
        title="Trips"
        description="A vehicle moving between two branches. Part-load trips carry manifests; a full-truck trip binds to one consignment and skips the manifest entirely."
        actions={
          canCreate && (
            <CreateTripDialog
              vehicles={vehicles.map((v) => ({
                id: v.id,
                registrationNumber: v.registrationNumber,
                type: v.vehicleType.name,
                capacityKg: Number(v.vehicleType.capacityKg),
                status: v.status,
              }))}
              drivers={drivers}
              branches={branches}
              originBranches={branches.filter(
                (b) => user.branchIds === null || user.branchIds.includes(b.id),
              )}
              defaultOriginId={user.primaryBranch?.id ?? null}
              routes={routes}
              ftlShipments={ftlShipments.map((s) => ({
                id: s.id,
                lrNumber: s.lrNumber,
                consigneeName: s.consigneeName,
                // Where the freight is standing, which is where the truck
                // loads — not where it was booked. A full load that has
                // already moved to a hub starts its trip from that hub,
                // and `createTrip` refuses any other origin.
                originBranchId: s.currentBranchId ?? s.originBranchId,
                destinationBranchId: s.destinationBranchId,
              }))}
            />
          )
        }
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {["", "PLANNED", "LOADING", "DISPATCHED", "IN_TRANSIT", "ARRIVED", "COMPLETED"].map(
          (value) => (
            <Link
              key={value || "all"}
              href={value ? `/dispatch/trips?status=${value}` : "/dispatch/trips"}
              className={`rounded-lg border px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-[0.13em] transition-colors ${
                (status ?? "") === value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-muted"
              }`}
            >
              {value ? value.replace("_", " ") : "All"}
            </Link>
          ),
        )}
      </div>

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title="No trips here"
            description={
              status
                ? "No vehicle sits in this stage right now."
                : "Plan one to move freight between branches."
            }
          />
        ) : (
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead>Trip</TableHead>
                <TableHead>Lane</TableHead>
                <TableHead>Vehicle</TableHead>
                <TableHead>Driver</TableHead>
                <TableHead>Carrying</TableHead>
                <TableHead>Seal</TableHead>
                <TableHead>Departure</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((trip) => (
                <TableRow key={trip.id}>
                  <TableCell>
                    <Link
                      href={`/dispatch/trips/${trip.id}`}
                      className="font-mono text-xs font-medium hover:underline"
                    >
                      {trip.number}
                    </Link>
                    {trip.ftlShipmentId && (
                      <span className="ml-2 rounded-sm bg-accent px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-accent-foreground">
                        FTL
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {trip.originBranch.code}
                    <span className="mx-1 text-muted-foreground">→</span>
                    {trip.destinationBranch.code}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    <span className="font-mono">{trip.vehicle.registrationNumber}</span>
                    <span className="ml-2 text-muted-foreground">
                      {trip.vehicle.vehicleType.name}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {trip.driver ? (
                      <>
                        {trip.driver.name}
                        <span className="ml-2 font-mono text-[0.6rem] text-muted-foreground">
                          {trip.driver.mobile}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Not assigned</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {trip.ftlShipment ? (
                      <span className="font-mono">{trip.ftlShipment.lrNumber}</span>
                    ) : trip._count.manifests > 0 ? (
                      <span className="text-muted-foreground">
                        {trip._count.manifests} manifest
                        {trip._count.manifests === 1 ? "" : "s"}
                      </span>
                    ) : (
                      <span className="text-warn">Empty</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {trip.sealNumber ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                    {trip.actualDepartureAt
                      ? format(trip.actualDepartureAt, "dd MMM HH:mm")
                      : trip.plannedDepartureAt
                        ? `plan ${format(trip.plannedDepartureAt, "dd MMM HH:mm")}`
                        : "—"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${STATUS_TONE[trip.status] ?? "bg-muted"}`}
                    >
                      {trip.status.replace("_", " ")}
                    </span>
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
        baseParams={{ status }}
        pathname="/dispatch/trips"
      />
    </>
  );
}
