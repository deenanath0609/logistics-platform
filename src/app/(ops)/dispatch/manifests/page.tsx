import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { anyBranchScope, branchScope } from "@/server/repositories/scope";
import { utilisation } from "@/lib/transport/capacity";
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
import { CreateManifestDialog } from "./create-manifest";
import { UtilisationBar } from "./utilisation-bar";

export const metadata: Metadata = { title: "Manifests" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  CLOSED: "bg-accent text-accent-foreground",
  DISPATCHED: "bg-info-muted text-info",
  RECEIVED: "bg-warn-muted text-warn",
  RECONCILED: "bg-ok-muted text-ok",
  CANCELLED: "bg-bad-muted text-bad",
};

export default async function ManifestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const user = await requirePermission("manifest.read");
  const { status, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const canCreate = can(user, "manifest.create");

  // A manifest concerns both ends of its leg, so either branch sees it.
  const scope = anyBranchScope(user, ["originBranchId", "destinationBranchId"]);

  const where = {
    ...scope,
    ...(status ? { status: status as never } : {}),
  };

  const [rows, total, branches, trips] = await Promise.all([
    prisma.manifest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        number: true,
        status: true,
        createdAt: true,
        dispatchedAt: true,
        totalShipments: true,
        totalPackages: true,
        totalWeight: true,
        originBranch: { select: { code: true } },
        destinationBranch: { select: { code: true } },
        trip: {
          select: {
            number: true,
            vehicle: {
              select: {
                registrationNumber: true,
                vehicleType: { select: { capacityKg: true } },
              },
            },
          },
        },
      },
    }),
    prisma.manifest.count({ where }),

    canCreate
      ? prisma.branch.findMany({
          where: { deletedAt: null, isActive: true },
          orderBy: { code: "asc" },
          select: { id: true, code: true, name: true },
        })
      : [],

    // Only trips that can still take a manifest.
    canCreate
      ? prisma.trip.findMany({
          where: {
            status: { in: ["PLANNED", "VEHICLE_REPORTED", "LOADING"] },
            ftlShipmentId: null,
            ...branchScope(user, "originBranchId"),
          },
          orderBy: { plannedDepartureAt: "asc" },
          take: 50,
          select: {
            id: true,
            number: true,
            originBranchId: true,
            destinationBranchId: true,
            vehicle: { select: { registrationNumber: true } },
          },
        })
      : [],
  ]);

  const originScopedBranches = branches.filter(
    (b) => user.branchIds === null || user.branchIds.includes(b.id),
  );

  return (
    <>
      <PageHeader
        eyebrow="Dispatch"
        title="Manifests"
        description="One document per leg. Add sorted consignments, watch the truck fill, and close it for dispatch before the vehicle gates out."
        actions={
          canCreate && (
            <CreateManifestDialog
              branches={branches}
              originBranches={originScopedBranches}
              defaultOriginId={user.primaryBranch?.id ?? null}
              trips={trips.map((trip) => ({
                id: trip.id,
                number: trip.number,
                originBranchId: trip.originBranchId,
                destinationBranchId: trip.destinationBranchId,
                vehicle: trip.vehicle.registrationNumber,
              }))}
            />
          )
        }
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {["", "DRAFT", "CLOSED", "DISPATCHED", "RECEIVED", "RECONCILED"].map(
          (value) => (
            <Link
              key={value || "all"}
              href={value ? `/dispatch/manifests?status=${value}` : "/dispatch/manifests"}
              className={`rounded-lg border px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-[0.13em] transition-colors ${
                (status ?? "") === value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-muted"
              }`}
            >
              {value || "All"}
            </Link>
          ),
        )}
      </div>

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title="No manifests here"
            description={
              status
                ? "Nothing sits in this stage right now."
                : "Create one to start building a load for a lane."
            }
          />
        ) : (
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead>Manifest</TableHead>
                <TableHead>Lane</TableHead>
                <TableHead>Vehicle</TableHead>
                <TableHead className="text-right">Shipments</TableHead>
                <TableHead className="text-right">Packages</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead className="w-[180px]">Utilisation</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const load = utilisation(
                  Number(row.totalWeight),
                  row.trip?.vehicle.vehicleType.capacityKg
                    ? Number(row.trip.vehicle.vehicleType.capacityKg)
                    : null,
                );

                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link
                        href={`/dispatch/manifests/${row.id}`}
                        className="font-mono text-xs font-medium hover:underline"
                      >
                        {row.number}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {row.originBranch.code}
                      <span className="mx-1 text-muted-foreground">→</span>
                      {row.destinationBranch.code}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {row.trip ? (
                        <>
                          <span className="font-mono">
                            {row.trip.vehicle.registrationNumber}
                          </span>
                          <span className="ml-2 font-mono text-[0.6rem] text-muted-foreground">
                            {row.trip.number}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">Not assigned</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {row.totalShipments}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {row.totalPackages}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular">
                      {Number(row.totalWeight)} kg
                    </TableCell>
                    <TableCell>
                      <UtilisationBar
                        percent={load.percent}
                        tone={load.tone}
                        capacityKg={load.capacityKg}
                        compact
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                      {format(row.createdAt, "dd MMM HH:mm")}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${STATUS_TONE[row.status] ?? "bg-muted"}`}
                      >
                        {row.status}
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
        baseParams={{ status }}
        pathname="/dispatch/manifests"
      />
    </>
  );
}
