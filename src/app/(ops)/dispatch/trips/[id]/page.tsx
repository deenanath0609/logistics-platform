import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft, ScanLine } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { utilisation } from "@/lib/transport/capacity";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame } from "@/components/data/data-shell";
import { StatusPill } from "@/components/shipment/status-pill";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UtilisationBar } from "../../manifests/utilisation-bar";
import { TripGateActions } from "./gate-actions";

export const metadata: Metadata = { title: "Trip" };
export const dynamic = "force-dynamic";

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

export default async function TripDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("trip.read");
  const { id } = await params;

  const trip = await prisma.trip.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      status: true,
      sealNumber: true,
      startOdometerKm: true,
      endOdometerKm: true,
      distanceKm: true,
      plannedDepartureAt: true,
      actualDepartureAt: true,
      plannedArrivalAt: true,
      actualArrivalAt: true,
      closedAt: true,
      remarks: true,
      originBranchId: true,
      destinationBranchId: true,
      originBranch: { select: { code: true, name: true } },
      destinationBranch: { select: { code: true, name: true } },
      route: { select: { code: true, name: true } },
      vehicle: {
        select: {
          id: true,
          registrationNumber: true,
          status: true,
          vehicleType: { select: { name: true, capacityKg: true } },
        },
      },
      driver: { select: { name: true, mobile: true, licenceNumber: true } },
      ftlShipment: {
        select: {
          id: true,
          lrNumber: true,
          consigneeName: true,
          currentStatus: true,
          packageCount: true,
          chargeableWeight: true,
        },
      },
      manifests: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          number: true,
          status: true,
          totalShipments: true,
          totalPackages: true,
          totalWeight: true,
          originBranch: { select: { code: true } },
          destinationBranch: { select: { code: true } },
        },
      },
      events: {
        orderBy: { occurredAt: "asc" },
        select: {
          id: true,
          eventType: true,
          occurredAt: true,
          odometerKm: true,
          remarks: true,
        },
      },
    },
  });

  if (!trip) notFound();

  if (
    !coversBranch(user, trip.originBranchId) &&
    !coversBranch(user, trip.destinationBranchId)
  ) {
    notFound();
  }

  const [openSheet, receipt] = await Promise.all([
    prisma.loadingSheet.findFirst({
      where: { tripId: trip.id, status: "OPEN" },
      select: { id: true },
    }),
    prisma.inboundReceipt.findFirst({
      where: { tripId: trip.id },
      orderBy: { openedAt: "desc" },
      select: { id: true, status: true },
    }),
  ]);

  const isFtl = Boolean(trip.ftlShipment);

  // FTL weight comes from the single consignment; PTL from its manifests.
  const totalWeight = isFtl
    ? Number(trip.ftlShipment!.chargeableWeight)
    : trip.manifests.reduce((sum, m) => sum + Number(m.totalWeight), 0);
  const totalPackages = isFtl
    ? trip.ftlShipment!.packageCount
    : trip.manifests.reduce((sum, m) => sum + m.totalPackages, 0);
  const totalShipments = isFtl
    ? 1
    : trip.manifests.reduce((sum, m) => sum + m.totalShipments, 0);

  const load = utilisation(totalWeight, Number(trip.vehicle.vehicleType.capacityKg));

  const canDispatch = can(user, "trip.dispatch");
  const canCloseTrip = can(user, "trip.close");
  const canLoad = can(user, "loading.execute");

  const preDeparture =
    trip.status === "PLANNED" ||
    trip.status === "VEHICLE_REPORTED" ||
    trip.status === "LOADING";

  const facts = [
    { label: "Vehicle", value: trip.vehicle.registrationNumber },
    { label: "Type", value: trip.vehicle.vehicleType.name },
    { label: "Driver", value: trip.driver?.name ?? "Not assigned" },
    { label: "Route", value: trip.route?.code ?? "—" },
    { label: "Seal", value: trip.sealNumber ?? "Not applied" },
    {
      label: "Distance",
      value: trip.distanceKm ? `${Number(trip.distanceKm)} km` : "—",
    },
  ];

  return (
    <>
      <Link
        href="/dispatch/trips"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All trips
      </Link>

      <PageHeader
        eyebrow={`${trip.originBranch.code} → ${trip.destinationBranch.code}${isFtl ? " · full truck" : ""}`}
        title={trip.number}
        description={
          isFtl
            ? `A dedicated truck for ${trip.ftlShipment!.lrNumber}. No manifest, no sortation — the consignment is the trip.`
            : "Gate-out dispatches every consignment on every manifest attached here, in one transaction."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-md px-2.5 py-1 font-mono text-[0.65rem] uppercase tracking-wider ${STATUS_TONE[trip.status] ?? "bg-muted"}`}
            >
              {trip.status.replace("_", " ")}
            </span>

            {preDeparture && canLoad && (trip.manifests.length > 0 || isFtl) && (
              <Button variant="outline" render={<Link href={`/dispatch/trips/${trip.id}/loading`} />}>
                <ScanLine />
                {openSheet ? "Continue loading" : "Loading sheet"}
              </Button>
            )}

            <TripGateActions
              tripId={trip.id}
              status={trip.status}
              canDispatch={canDispatch}
              canClose={canCloseTrip}
              destinationBranchId={trip.destinationBranchId}
              destinationCode={trip.destinationBranch.code}
              sealNumber={trip.sealNumber}
              startOdometerKm={trip.startOdometerKm}
              hasOpenLoadingSheet={Boolean(openSheet)}
              carrying={totalShipments}
            />
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-wrap gap-3">
            {facts.map((fact) => (
              <div
                key={fact.label}
                className="flex items-baseline gap-2 rounded-md border bg-card px-3 py-1.5"
              >
                <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
                  {fact.label}
                </span>
                <span className="text-sm font-semibold tabular">{fact.value}</span>
              </div>
            ))}
          </div>

          {/* Load */}
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              {isFtl ? "Consignment" : `Manifests — ${trip.manifests.length}`}
            </h2>

            <TableFrame>
              {isFtl ? (
                <Table className="min-w-[600px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>LR number</TableHead>
                      <TableHead>Consignee</TableHead>
                      <TableHead className="text-right">Packages</TableHead>
                      <TableHead className="text-right">Weight</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell>
                        <Link
                          href={`/shipments/${trip.ftlShipment!.id}`}
                          className="font-mono text-xs font-medium hover:underline"
                        >
                          {trip.ftlShipment!.lrNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">
                        {trip.ftlShipment!.consigneeName}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {trip.ftlShipment!.packageCount}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular">
                        {Number(trip.ftlShipment!.chargeableWeight)} kg
                      </TableCell>
                      <TableCell>
                        <StatusPill status={trip.ftlShipment!.currentStatus} />
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              ) : trip.manifests.length === 0 ? (
                <p className="px-6 py-12 text-center text-sm text-muted-foreground">
                  No manifest attached. Build one on the manifest screen and
                  assign this trip to it — a trip with nothing on it cannot
                  gate out.
                </p>
              ) : (
                <Table className="min-w-[720px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Manifest</TableHead>
                      <TableHead>Leg</TableHead>
                      <TableHead className="text-right">Shipments</TableHead>
                      <TableHead className="text-right">Packages</TableHead>
                      <TableHead className="text-right">Weight</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trip.manifests.map((manifest) => (
                      <TableRow key={manifest.id}>
                        <TableCell>
                          <Link
                            href={`/dispatch/manifests/${manifest.id}`}
                            className="font-mono text-xs font-medium hover:underline"
                          >
                            {manifest.number}
                          </Link>
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {manifest.originBranch.code}
                          <span className="mx-1 text-muted-foreground">→</span>
                          {manifest.destinationBranch.code}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {manifest.totalShipments}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {manifest.totalPackages}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular">
                          {Number(manifest.totalWeight)} kg
                        </TableCell>
                        <TableCell>
                          <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                            {manifest.status}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TableFrame>
          </section>

          {/* Trip events */}
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              Vehicle log
            </h2>
            <div className="rounded-lg border bg-card p-4">
              {trip.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing yet. The gate writes the first entry.
                </p>
              ) : (
                <ol className="flex flex-col gap-3">
                  {trip.events.map((event) => (
                    <li key={event.id} className="flex gap-3 text-sm">
                      <span className="w-32 shrink-0 font-mono text-xs text-muted-foreground tabular">
                        {format(event.occurredAt, "dd MMM HH:mm")}
                      </span>
                      <span className="font-medium">
                        {event.eventType.replace(/_/g, " ").toLowerCase()}
                      </span>
                      {event.odometerKm != null && (
                        <span className="font-mono text-xs text-muted-foreground tabular">
                          {event.odometerKm.toLocaleString("en-IN")} km
                        </span>
                      )}
                      {event.remarks && (
                        <span className="text-xs text-muted-foreground">
                          {event.remarks}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        </div>

        <aside className="flex flex-col gap-4">
          <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Load
            </h2>
            <UtilisationBar
              percent={load.percent}
              tone={load.tone}
              capacityKg={load.capacityKg}
              label={load.label}
            />
            <dl className="flex flex-col gap-2 text-sm">
              {[
                ["Shipments", String(totalShipments)],
                ["Packages", String(totalPackages)],
                ["Weight", `${Math.round(totalWeight * 1000) / 1000} kg`],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium tabular">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="flex flex-col gap-2 rounded-lg border bg-card p-4">
            <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Gate &amp; odometer
            </h2>
            <dl className="flex flex-col gap-2 text-sm">
              {[
                [
                  "Planned departure",
                  trip.plannedDepartureAt ? format(trip.plannedDepartureAt, "dd MMM HH:mm") : "—",
                ],
                [
                  "Gated out",
                  trip.actualDepartureAt ? format(trip.actualDepartureAt, "dd MMM HH:mm") : "—",
                ],
                [
                  "Expected arrival",
                  trip.plannedArrivalAt ? format(trip.plannedArrivalAt, "dd MMM HH:mm") : "—",
                ],
                [
                  "Gated in",
                  trip.actualArrivalAt ? format(trip.actualArrivalAt, "dd MMM HH:mm") : "—",
                ],
                [
                  "Odometer out",
                  trip.startOdometerKm ? `${trip.startOdometerKm.toLocaleString("en-IN")} km` : "—",
                ],
                [
                  "Odometer in",
                  trip.endOdometerKm ? `${trip.endOdometerKm.toLocaleString("en-IN")} km` : "—",
                ],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium tabular">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          {receipt && (
            <Link
              href={`/hub/inbound/${receipt.id}`}
              className="rounded-lg border bg-card p-4 text-sm hover:bg-muted"
            >
              <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
                Inbound receipt
              </span>
              <p className="mt-1 font-medium">
                {receipt.status === "OPEN" ? "Open on the dock" : `Receipt ${receipt.status.toLowerCase()}`}
              </p>
            </Link>
          )}

          {trip.remarks && (
            <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
              {trip.remarks}
            </p>
          )}
        </aside>
      </div>
    </>
  );
}
