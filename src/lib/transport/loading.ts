import { prisma, tenantTransaction } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { recordAudit } from "@/server/services/audit";
import { recordScan, type ScanOutcome } from "@/lib/hub/scan";
import {
  reconcile,
  normaliseBarcode,
  type ActualScan,
  type ExpectedLine,
  type ReconcileResult,
} from "@/lib/hub/reconcile";

/**
 * The loading sheet.
 *
 * BRD §A.6: "the sheet cannot close with a package scanned but not
 * physically loaded, or vice versa." Both halves of that sentence are the
 * same comparison the inbound dock makes, so this reuses
 * `reconcile()` rather than growing a second, subtly different, notion of
 * what "accounted for" means:
 *
 *   • on the manifest, never scanned onto the truck → SHORT
 *     (loaded-but-not-scanned, or simply left on the floor)
 *   • scanned onto the truck, not on any manifest → EXCESS
 *     (scanned-but-not-loaded, or somebody else's freight)
 *
 * Either one blocks the close. There is no override: an override here is
 * how a box gets to the wrong city with paperwork that says otherwise.
 */

export type OpenSheetResult =
  | { ok: true; loadingSheetId: string; resumed: boolean }
  | { ok: false; error: string };

export async function openLoadingSheet(
  input: { tripId: string; manifestId?: string | null },
  actor: SessionUser,
): Promise<OpenSheetResult> {
  if (!can(actor, "loading.execute")) {
    return { ok: false, error: "You do not have permission to load vehicles." };
  }

  const trip = await prisma.trip.findUnique({
    where: { id: input.tripId },
    select: {
      id: true,
      number: true,
      status: true,
      originBranchId: true,
      ftlShipmentId: true,
      manifests: { select: { id: true } },
    },
  });

  if (!trip) return { ok: false, error: "That trip does not exist." };
  if (!coversBranch(actor, trip.originBranchId)) {
    return { ok: false, error: "That trip loads at another branch." };
  }
  if (trip.status !== "PLANNED" && trip.status !== "VEHICLE_REPORTED" && trip.status !== "LOADING") {
    return { ok: false, error: `${trip.number} has already departed.` };
  }
  if (trip.manifests.length === 0 && !trip.ftlShipmentId) {
    return {
      ok: false,
      error: "Attach a manifest to this trip before loading, so there is something to load against.",
    };
  }

  const existing = await prisma.loadingSheet.findFirst({
    where: { tripId: trip.id, status: "OPEN" },
    select: { id: true },
  });

  if (existing) return { ok: true, loadingSheetId: existing.id, resumed: true };

  const sheet = await tenantTransaction(async (tx) => {
    const created = await tx.loadingSheet.create({
      data: {
        orgId: actor.orgId,
        tripId: trip.id,
        manifestId: input.manifestId ?? trip.manifests[0]?.id ?? undefined,
        branchId: trip.originBranchId,
        status: "OPEN",
        openedById: actor.id,
      },
      select: { id: true },
    });

    await tx.trip.update({ where: { id: trip.id }, data: { status: "LOADING" } });
    await tx.vehicle.updateMany({
      where: { trips: { some: { id: trip.id } }, status: { in: ["AVAILABLE", "ASSIGNED"] } },
      data: { status: "LOADING" },
    });

    return created;
  });

  await recordAudit({
    user: actor,
    action: "CREATE",
    entity: "LoadingSheet",
    entityId: sheet.id,
    entityRef: trip.number,
    branchId: trip.originBranchId,
    after: { tripId: trip.id },
  });

  return { ok: true, loadingSheetId: sheet.id, resumed: false };
}

/** What the trip's paperwork says should go on the vehicle. */
export async function expectedForSheet(
  loadingSheetId: string,
): Promise<ExpectedLine[]> {
  // LoadingSheet carries `tripId` as a plain column — there is no relation
  // on the model — so the trip is fetched separately rather than joined.
  const sheet = await prisma.loadingSheet.findUnique({
    where: { id: loadingSheetId },
    select: { tripId: true },
  });

  if (!sheet?.tripId) return [];

  const trip = await prisma.trip.findUnique({
    where: { id: sheet.tripId },
    select: {
      ftlShipment: {
        select: {
          id: true,
          lrNumber: true,
          packageCount: true,
          packages: { select: { barcode: true } },
        },
      },
      manifests: {
        where: { status: { notIn: ["CANCELLED"] } },
        select: {
          lines: {
            select: {
              packageCount: true,
              shipment: {
                select: {
                  id: true,
                  lrNumber: true,
                  packages: { select: { barcode: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!trip) return [];

  if (trip.ftlShipment) {
    const shipment = trip.ftlShipment;
    return [
      {
        shipmentId: shipment.id,
        lrNumber: shipment.lrNumber,
        expectedPackages: shipment.packageCount,
        barcodes: shipment.packages.map((p) => p.barcode),
      },
    ];
  }

  return trip.manifests.flatMap((manifest) =>
    manifest.lines.map((line) => ({
      shipmentId: line.shipment.id,
      lrNumber: line.shipment.lrNumber,
      expectedPackages: line.packageCount,
      barcodes: line.shipment.packages.map((p) => p.barcode),
    })),
  );
}

export type LoadScanResult = {
  outcome: ScanOutcome;
  loadedPackages: number;
  expectedPackages: number;
};

/** One scan-to-load. Writes the sheet line and the LOADED event together. */
export async function scanToLoad(
  input: {
    loadingSheetId: string;
    barcode: string;
    idempotencyKey: string;
    scannedAt?: Date;
    deviceId?: string | null;
  },
  actor: SessionUser,
): Promise<{ ok: true; result: LoadScanResult } | { ok: false; error: string }> {
  const sheet = await prisma.loadingSheet.findUnique({
    where: { id: input.loadingSheetId },
    select: {
      id: true,
      status: true,
      branchId: true,
      tripId: true,
      manifestId: true,
    },
  });

  // The only function in this module that checked the branch and not the
  // permission. The action above it authorises, so nothing was reachable
  // without it — but every sibling here defends itself, and a service that
  // relies on exactly one caller remembering is one refactor from not
  // being defended at all.
  if (!can(actor, "loading.execute")) {
    return { ok: false, error: "You do not have permission to load vehicles." };
  }
  if (!sheet) return { ok: false, error: "That loading sheet does not exist." };
  if (sheet.status !== "OPEN") return { ok: false, error: "This sheet is closed." };
  if (!coversBranch(actor, sheet.branchId)) {
    return { ok: false, error: "That sheet belongs to another branch." };
  }

  const expected = await expectedForSheet(sheet.id);
  const expectedBarcodes = new Set(
    expected.flatMap((line) => line.barcodes.map(normaliseBarcode)),
  );

  const outcome = await recordScan(
    {
      barcode: input.barcode,
      scanType: "LOAD",
      branchId: sheet.branchId,
      idempotencyKey: input.idempotencyKey,
      scannedAt: input.scannedAt,
      deviceId: input.deviceId,
      tripId: sheet.tripId,
      manifestId: sheet.manifestId,
      loadingSheetId: sheet.id,
    },
    actor,
    expectedBarcodes,
  );

  if (!outcome.ok) return { ok: false, error: outcome.message };

  // A sheet line is the assertion "this box is physically on the vehicle".
  // Only a package that exists gets one; an unknown barcode stays a
  // ScanRecord and surfaces as an excess when the sheet is closed.
  if (outcome.packageId) {
    await prisma.loadingSheetLine.upsert({
      where: {
        loadingSheetId_packageId: {
          loadingSheetId: sheet.id,
          packageId: outcome.packageId,
        },
      },
      create: {
        // The operator holding the gun. `recordScan` above already refused
        // anything belonging to another tenant, so the package is theirs.
        orgId: actor.orgId,
        loadingSheetId: sheet.id,
        packageId: outcome.packageId,
        barcode: outcome.barcode,
        scannedAt: input.scannedAt ?? new Date(),
        scannedById: actor.id,
      },
      update: {},
    });
  }

  const loadedPackages = await prisma.loadingSheetLine.count({
    where: { loadingSheetId: sheet.id },
  });

  return {
    ok: true,
    result: {
      outcome,
      loadedPackages,
      expectedPackages: expected.reduce((sum, line) => sum + line.expectedPackages, 0),
    },
  };
}

/** Removes a line — a box pulled back off the truck before departure. */
export async function unload(
  input: { loadingSheetId: string; packageId: string },
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "loading.execute")) {
    return { ok: false, error: "You do not have permission to load vehicles." };
  }

  const sheet = await prisma.loadingSheet.findUnique({
    where: { id: input.loadingSheetId },
    select: { id: true, status: true, branchId: true },
  });

  if (!sheet) return { ok: false, error: "That loading sheet does not exist." };
  if (sheet.status !== "OPEN") return { ok: false, error: "This sheet is closed." };
  if (!coversBranch(actor, sheet.branchId)) {
    return { ok: false, error: "That sheet belongs to another branch." };
  }

  await prisma.loadingSheetLine.deleteMany({
    where: { loadingSheetId: sheet.id, packageId: input.packageId },
  });

  return { ok: true };
}

export type SheetState = {
  reconciliation: ReconcileResult;
  /** On the paperwork, not on the vehicle. */
  notLoaded: Array<{ shipmentId: string; lrNumber?: string; barcode: string | null }>;
  /** On the vehicle, not on the paperwork. */
  notExpected: Array<{ barcode: string; shipmentId: string | null }>;
  canClose: boolean;
};

/**
 * The live state of a sheet — what is loaded, what is missing, what
 * should not be there. Drives both the screen and the close guard, so
 * the button's reason for being disabled is the reason the close fails.
 */
export async function sheetState(loadingSheetId: string): Promise<SheetState> {
  const expected = await expectedForSheet(loadingSheetId);

  const lines = await prisma.loadingSheetLine.findMany({
    where: { loadingSheetId },
    orderBy: { scannedAt: "asc" },
    select: {
      barcode: true,
      packageId: true,
      package: { select: { shipmentId: true } },
    },
  });

  // Unknown barcodes never became sheet lines, but they were scanned
  // against this sheet and must still block the close.
  const strayScans = await prisma.scanRecord.findMany({
    where: { loadingSheetId, isExpected: false },
    distinct: ["barcode"],
    select: { barcode: true, packageId: true, shipmentId: true, scannedAt: true },
  });

  const actual: ActualScan[] = [
    ...lines.map((line) => ({
      barcode: line.barcode,
      packageId: line.packageId,
      shipmentId: line.package.shipmentId,
    })),
    ...strayScans.map((scan) => ({
      barcode: scan.barcode,
      packageId: scan.packageId,
      shipmentId: scan.shipmentId,
      scannedAt: scan.scannedAt,
    })),
  ];

  const reconciliation = reconcile(expected, actual);

  return {
    reconciliation,
    notLoaded: reconciliation.short,
    notExpected: reconciliation.excess.map((e) => ({
      barcode: e.barcode,
      shipmentId: e.shipmentId,
    })),
    canClose: reconciliation.isClean,
  };
}

export type CloseSheetResult =
  | { ok: true; loadedPackages: number }
  | { ok: false; error: string; state?: SheetState };

export async function closeLoadingSheet(
  input: { loadingSheetId: string },
  actor: SessionUser,
): Promise<CloseSheetResult> {
  if (!can(actor, "loading.execute")) {
    return { ok: false, error: "You do not have permission to load vehicles." };
  }

  const sheet = await prisma.loadingSheet.findUnique({
    where: { id: input.loadingSheetId },
    select: { id: true, status: true, branchId: true, tripId: true },
  });

  if (!sheet) return { ok: false, error: "That loading sheet does not exist." };
  if (sheet.status !== "OPEN") return { ok: false, error: "This sheet is already closed." };
  if (!coversBranch(actor, sheet.branchId)) {
    return { ok: false, error: "That sheet belongs to another branch." };
  }

  const state = await sheetState(sheet.id);

  if (!state.canClose) {
    const problems: string[] = [];
    if (state.notLoaded.length > 0) {
      problems.push(
        `${state.notLoaded.length} package${state.notLoaded.length === 1 ? "" : "s"} on the paperwork ${state.notLoaded.length === 1 ? "is" : "are"} not scanned onto the vehicle`,
      );
    }
    if (state.notExpected.length > 0) {
      problems.push(
        `${state.notExpected.length} scanned package${state.notExpected.length === 1 ? "" : "s"} ${state.notExpected.length === 1 ? "is" : "are"} not on the paperwork`,
      );
    }

    return {
      ok: false,
      error: `${problems.join(", and ")}. Resolve both before closing — a sheet that closes over a mismatch is worth nothing at the other end.`,
      state,
    };
  }

  const loadedPackages = state.reconciliation.totals.matchedPackages;

  await prisma.loadingSheet.update({
    where: { id: sheet.id },
    data: { status: "CLOSED", closedAt: new Date(), closedById: actor.id },
  });

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "LoadingSheet",
    entityId: sheet.id,
    branchId: sheet.branchId,
    after: { status: "CLOSED", loadedPackages },
    reason: "Loading sheet closed — scanned and loaded agree",
  });

  return { ok: true, loadedPackages };
}
