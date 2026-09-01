import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope, coversBranch } from "@/server/repositories/scope";
import { utilisation } from "@/lib/transport/capacity";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame } from "@/components/data/data-shell";
import { StatusPill } from "@/components/shipment/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UtilisationBar } from "../utilisation-bar";
import { AddShipments, type CandidateShipment } from "./add-shipments";
import { ManifestActions } from "./manifest-actions";
import { RemoveLineButton } from "./remove-line";
import { AssignTrip } from "./assign-trip";

export const metadata: Metadata = { title: "Manifest" };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  CLOSED: "bg-accent text-accent-foreground",
  DISPATCHED: "bg-info-muted text-info",
  RECEIVED: "bg-warn-muted text-warn",
  RECONCILED: "bg-ok-muted text-ok",
  CANCELLED: "bg-bad-muted text-bad",
};

export default async function ManifestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("manifest.read");
  const { id } = await params;

  const manifest = await prisma.manifest.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      status: true,
      createdAt: true,
      closedAt: true,
      dispatchedAt: true,
      receivedAt: true,
      remarks: true,
      totalShipments: true,
      totalPackages: true,
      totalWeight: true,
      originBranchId: true,
      destinationBranchId: true,
      originBranch: { select: { code: true, name: true } },
      destinationBranch: { select: { code: true, name: true } },
      trip: {
        select: {
          id: true,
          number: true,
          status: true,
          sealNumber: true,
          plannedDepartureAt: true,
          vehicle: {
            select: {
              registrationNumber: true,
              vehicleType: { select: { name: true, capacityKg: true } },
            },
          },
          driver: { select: { name: true, mobile: true } },
        },
      },
      lines: {
        orderBy: { addedAt: "asc" },
        select: {
          id: true,
          packageCount: true,
          weight: true,
          addedAt: true,
          shipment: {
            select: {
              id: true,
              lrNumber: true,
              currentStatus: true,
              consigneeName: true,
              paymentType: true,
              codAmount: true,
              destinationBranch: { select: { code: true } },
            },
          },
        },
      },
    },
  });

  if (!manifest) notFound();

  // Either end of the leg may look at it; nobody else may.
  if (
    !coversBranch(user, manifest.originBranchId) &&
    !coversBranch(user, manifest.destinationBranchId)
  ) {
    notFound();
  }

  const isDraft = manifest.status === "DRAFT";
  const canEdit = isDraft && can(user, "manifest.update") && coversBranch(user, manifest.originBranchId);
  const canClose = isDraft && can(user, "manifest.close");
  const canReopen = manifest.status === "CLOSED" && can(user, "manifest.reopen");

  // Candidates: sorted, unheld, not already manifested, sitting at this
  // manifest's origin. Anything else is a routing mistake waiting to happen.
  const candidates: CandidateShipment[] = canEdit
    ? (
        await prisma.shipment.findMany({
          where: {
            deletedAt: null,
            currentStatus: "PROCESSED",
            isOnHold: false,
            mode: { not: "FTL" },
            currentBranchId: manifest.originBranchId,
            manifestLines: { none: { manifest: { status: { in: ["DRAFT", "CLOSED", "DISPATCHED"] } } } },
            ...branchScope(user, "currentBranchId"),
          },
          orderBy: { bookedAt: "asc" },
          take: 200,
          select: {
            id: true,
            lrNumber: true,
            consigneeName: true,
            packageCount: true,
            chargeableWeight: true,
            destinationBranch: { select: { id: true, code: true } },
          },
        })
      ).map((shipment) => ({
        id: shipment.id,
        lrNumber: shipment.lrNumber,
        consigneeName: shipment.consigneeName,
        packageCount: shipment.packageCount,
        weightKg: Number(shipment.chargeableWeight),
        destinationCode: shipment.destinationBranch.code,
        // Consignments whose final destination is this leg's destination
        // are the obvious ones; the rest are transshipping onward.
        isDirect: shipment.destinationBranch.id === manifest.destinationBranchId,
      }))
    : [];

  // Exactly what `setManifestTrip` will accept: not departed, not an FTL
  // trip, starting at this origin *and* ending at this destination. The
  // destination clause is the one the picker used to be missing, so every
  // trip running a different lane out of the same branch was offered and
  // then refused.
  const availableTrips = canEdit
    ? await prisma.trip.findMany({
        where: {
          status: { in: ["PLANNED", "VEHICLE_REPORTED", "LOADING"] },
          ftlShipmentId: null,
          originBranchId: manifest.originBranchId,
          destinationBranchId: manifest.destinationBranchId,
        },
        orderBy: { plannedDepartureAt: "asc" },
        take: 50,
        select: {
          id: true,
          number: true,
          plannedDepartureAt: true,
          vehicle: {
            select: {
              registrationNumber: true,
              vehicleType: { select: { capacityKg: true } },
            },
          },
        },
      })
    : [];

  const load = utilisation(
    Number(manifest.totalWeight),
    manifest.trip?.vehicle.vehicleType.capacityKg
      ? Number(manifest.trip.vehicle.vehicleType.capacityKg)
      : null,
  );

  return (
    <>
      <Link
        href="/dispatch/manifests"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All manifests
      </Link>

      <PageHeader
        eyebrow={`${manifest.originBranch.code} → ${manifest.destinationBranch.code}`}
        title={manifest.number}
        description={
          isDraft
            ? "Add sorted consignments to the load. Close it when the truck is as full as it is going to get."
            : "Closed for dispatch. The lines below are what the receiving hub reconciles its scans against."
        }
        actions={
          <div className="flex items-center gap-2">
            <span
              className={`rounded-md px-2.5 py-1 font-mono text-[0.65rem] uppercase tracking-wider ${STATUS_TONE[manifest.status] ?? "bg-muted"}`}
            >
              {manifest.status}
            </span>
            <ManifestActions
              manifestId={manifest.id}
              canClose={canClose}
              canReopen={canReopen}
              lineCount={manifest.totalShipments}
              utilisationPercent={load.percent}
              utilisationLabel={load.label}
            />
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          {/* Totals */}
          <section className="grid gap-3 sm:grid-cols-3">
            {[
              { label: "Shipments", value: manifest.totalShipments },
              { label: "Packages", value: manifest.totalPackages },
              { label: "Weight", value: `${Number(manifest.totalWeight)} kg` },
            ].map((tile) => (
              <div key={tile.label} className="flex flex-col gap-0.5 rounded-lg border bg-card px-4 py-3">
                <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
                  {tile.label}
                </span>
                <span className="text-2xl font-semibold tabular">{tile.value}</span>
              </div>
            ))}
          </section>

          {canEdit && (
            <AddShipments
              manifestId={manifest.id}
              destinationCode={manifest.destinationBranch.code}
              candidates={candidates}
              capacityKg={load.capacityKg}
              currentWeightKg={Number(manifest.totalWeight)}
            />
          )}

          {/* Lines */}
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              Lines — {manifest.lines.length}
            </h2>

            <TableFrame>
              {manifest.lines.length === 0 ? (
                <p className="px-6 py-12 text-center text-sm text-muted-foreground">
                  Nothing on this manifest yet. An empty one cannot be closed.
                </p>
              ) : (
                <Table className="min-w-[760px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>LR number</TableHead>
                      <TableHead>Consignee</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead className="text-right">Packages</TableHead>
                      <TableHead className="text-right">Weight</TableHead>
                      <TableHead>Payment</TableHead>
                      <TableHead>Status</TableHead>
                      {canEdit && <TableHead />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {manifest.lines.map((line) => (
                      <TableRow key={line.id}>
                        <TableCell>
                          <Link
                            href={`/shipments/${line.shipment.id}`}
                            className="font-mono text-xs font-medium hover:underline"
                          >
                            {line.shipment.lrNumber}
                          </Link>
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate text-sm">
                          {line.shipment.consigneeName}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {line.shipment.destinationBranch.code}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {line.packageCount}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular">
                          {Number(line.weight)} kg
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {line.shipment.paymentType === "COD" ? (
                            <span className="text-warn">
                              COD ₹
                              {Number(line.shipment.codAmount ?? 0).toLocaleString("en-IN")}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {line.shipment.paymentType.replace("_", "-")}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusPill status={line.shipment.currentStatus} />
                        </TableCell>
                        {canEdit && (
                          <TableCell className="text-right">
                            <RemoveLineButton
                              manifestId={manifest.id}
                              shipmentId={line.shipment.id}
                              lrNumber={line.shipment.lrNumber}
                            />
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TableFrame>
          </section>
        </div>

        {/* Vehicle & utilisation */}
        <aside className="flex flex-col gap-4">
          <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Capacity
            </h2>

            <UtilisationBar
              percent={load.percent}
              tone={load.tone}
              capacityKg={load.capacityKg}
              label={load.label}
            />

            {load.capacityKg !== null && load.headroomKg !== null && (
              <p className="text-xs text-muted-foreground">
                {load.headroomKg >= 0
                  ? `${load.headroomKg} kg of payload still free.`
                  : `${Math.abs(load.headroomKg)} kg over the rated payload.`}
              </p>
            )}
          </section>

          <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Vehicle
            </h2>

            {manifest.trip ? (
              <dl className="flex flex-col gap-2 text-sm">
                {[
                  ["Trip", manifest.trip.number],
                  ["Registration", manifest.trip.vehicle.registrationNumber],
                  ["Type", manifest.trip.vehicle.vehicleType.name],
                  ["Driver", manifest.trip.driver?.name ?? "Not assigned"],
                  ["Driver phone", manifest.trip.driver?.mobile ?? "—"],
                  ["Seal", manifest.trip.sealNumber ?? "Not applied"],
                  [
                    "Planned departure",
                    manifest.trip.plannedDepartureAt
                      ? format(manifest.trip.plannedDepartureAt, "dd MMM HH:mm")
                      : "—",
                  ],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="text-right font-medium">{value}</dd>
                  </div>
                ))}
                <Link
                  href={`/dispatch/trips/${manifest.trip.id}`}
                  className="mt-1 text-xs text-primary hover:underline"
                >
                  Open the trip →
                </Link>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                No vehicle attached. Utilisation cannot be judged, and the
                load cannot gate out, until there is one.
              </p>
            )}

            {canEdit && (
              <AssignTrip
                manifestId={manifest.id}
                currentTripNumber={manifest.trip?.number ?? null}
                weightKg={Number(manifest.totalWeight)}
                trips={availableTrips
                  .filter((trip) => trip.id !== manifest.trip?.id)
                  .map((trip) => ({
                    id: trip.id,
                    number: trip.number,
                    registrationNumber: trip.vehicle.registrationNumber,
                    capacityKg: trip.vehicle.vehicleType.capacityKg
                      ? Number(trip.vehicle.vehicleType.capacityKg)
                      : null,
                    plannedDeparture: trip.plannedDepartureAt
                      ? format(trip.plannedDepartureAt, "dd MMM HH:mm")
                      : null,
                  }))}
              />
            )}
          </section>

          <section className="flex flex-col gap-2 rounded-lg border bg-card p-4">
            <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Timeline
            </h2>
            <dl className="flex flex-col gap-2 text-sm">
              {[
                ["Created", manifest.createdAt],
                ["Closed", manifest.closedAt],
                ["Dispatched", manifest.dispatchedAt],
                ["Received", manifest.receivedAt],
              ].map(([label, value]) => (
                <div key={String(label)} className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{String(label)}</dt>
                  <dd className="font-medium tabular">
                    {value instanceof Date ? format(value, "dd MMM HH:mm") : "—"}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {manifest.remarks && (
            <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
              {manifest.remarks}
            </p>
          )}

        </aside>
      </div>
    </>
  );
}
