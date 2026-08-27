import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { expectedForSheet, sheetState } from "@/lib/transport/loading";
import { PageHeader } from "@/components/shell/page-header";
import { LoadingConsole, type LoadLine } from "./loading-console";
import { OpenSheetPrompt } from "./open-sheet-prompt";

export const metadata: Metadata = { title: "Loading sheet" };
export const dynamic = "force-dynamic";

export default async function LoadingSheetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("loading.execute");
  const { id } = await params;

  const trip = await prisma.trip.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      status: true,
      originBranchId: true,
      originBranch: { select: { code: true } },
      destinationBranch: { select: { code: true } },
      ftlShipmentId: true,
      vehicle: { select: { registrationNumber: true } },
      manifests: { select: { id: true, number: true, status: true } },
    },
  });

  if (!trip) notFound();
  if (!coversBranch(user, trip.originBranchId)) notFound();

  const sheet = await prisma.loadingSheet.findFirst({
    where: { tripId: trip.id },
    orderBy: { openedAt: "desc" },
    select: { id: true, status: true, closedAt: true },
  });

  const header = (
    <>
      <Link
        href={`/dispatch/trips/${trip.id}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {trip.number}
      </Link>

      <PageHeader
        eyebrow={`${trip.originBranch.code} → ${trip.destinationBranch.code} · ${trip.vehicle.registrationNumber}`}
        title="Loading sheet"
        description="Scan each package as it goes on. The sheet will not close while something on the paperwork is unscanned, or something scanned is not on the paperwork."
      />
    </>
  );

  // No open sheet: either none was ever opened, or the last one is closed.
  if (!sheet || sheet.status === "CLOSED") {
    return (
      <>
        {header}
        <OpenSheetPrompt
          tripId={trip.id}
          tripNumber={trip.number}
          closed={Boolean(sheet)}
          hasLoad={trip.manifests.length > 0 || Boolean(trip.ftlShipmentId)}
          departed={
            trip.status !== "PLANNED" &&
            trip.status !== "VEHICLE_REPORTED" &&
            trip.status !== "LOADING"
          }
        />
      </>
    );
  }

  const [expected, state] = await Promise.all([
    expectedForSheet(sheet.id),
    sheetState(sheet.id),
  ]);

  const loadedPerShipment = new Map<string, number>();
  for (const match of state.reconciliation.matched) {
    loadedPerShipment.set(
      match.shipmentId,
      (loadedPerShipment.get(match.shipmentId) ?? 0) + 1,
    );
  }

  const destinationByShipment = new Map(
    (
      await prisma.shipment.findMany({
        where: { id: { in: expected.map((line) => line.shipmentId) } },
        select: { id: true, destinationBranch: { select: { code: true } } },
      })
    ).map((s) => [s.id, s.destinationBranch.code]),
  );

  const lines: LoadLine[] = expected.map((line) => ({
    shipmentId: line.shipmentId,
    lrNumber: line.lrNumber ?? "—",
    expectedPackages: line.expectedPackages,
    loadedPackages: loadedPerShipment.get(line.shipmentId) ?? 0,
    destinationCode: destinationByShipment.get(line.shipmentId) ?? "—",
  }));

  return (
    <>
      {header}
      <LoadingConsole
        loadingSheetId={sheet.id}
        tripId={trip.id}
        tripNumber={trip.number}
        lines={lines}
        strayBarcodes={state.notExpected.map((item) => item.barcode)}
      />
    </>
  );
}
