import { prisma, tenantTransaction, type DbOrTx } from "@/lib/prisma";
import type { ScanType, ShipmentEventType } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { appendShipmentEvent } from "@/lib/shipment/events";
import { normaliseBarcode } from "./reconcile";

/**
 * The dock scan.
 *
 * A scan is an operational fact first and a status change second. That
 * ordering decides every awkward case in this file: a barcode nobody
 * recognises, a box scanned inbound that was already received, a package
 * belonging to another manifest — all of them are written as ScanRecords
 * even when no shipment event can follow, because the alternative is a
 * clerk whose gun beeped red and whose evening reconciliation has no
 * record of what they were holding.
 *
 * Status, where it does change, changes only through
 * `appendShipmentEvent` — nothing here touches `Shipment.currentStatus`.
 */

/** Which permission a scan of each type demands. */
export const SCAN_PERMISSION: Record<ScanType, string> = {
  INBOUND: "scan.inbound",
  UNLOAD: "scan.inbound",
  OUTBOUND: "scan.outbound",
  LOAD: "loading.execute",
  SORT: "scan.sort",
  DELIVERY_OUT: "delivery.execute",
  DELIVERY_IN: "delivery.execute",
  AUDIT: "scan.inbound",
};

/**
 * The shipment event a scan of each type implies, if any.
 *
 * OUTBOUND and AUDIT deliberately map to nothing. Dispatch is a gate
 * event on a trip, not a consequence of one operator waving a gun at a
 * box, and an audit scan is a stock check that must not move anything.
 */
const EVENT: Partial<Record<ScanType, ShipmentEventType>> = {
  INBOUND: "INBOUND_SCAN",
  UNLOAD: "UNLOADED",
  SORT: "SORTED",
  LOAD: "LOADED",
};

export const SCAN_TYPE_LABELS: Record<ScanType, string> = {
  INBOUND: "Inbound",
  OUTBOUND: "Outbound",
  SORT: "Sort",
  LOAD: "Load",
  UNLOAD: "Unload",
  DELIVERY_OUT: "Out for delivery",
  DELIVERY_IN: "Returned to branch",
  AUDIT: "Audit",
};

export type ScanInput = {
  barcode: string;
  scanType: ScanType;
  branchId: string;
  /**
   * Client-generated, one per physical trigger pull. The offline queue
   * retries; the unique index makes that a no-op rather than a second box.
   */
  idempotencyKey: string;
  /** Device clock. `recordedAt` is stamped by the server on the row. */
  scannedAt?: Date;
  deviceId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  manifestId?: string | null;
  tripId?: string | null;
  loadingSheetId?: string | null;
  receiptId?: string | null;
  /** Bin to drop the package in. Only meaningful on a SORT scan. */
  binId?: string | null;
  remarks?: string | null;
};

/**
 * What the dock screen shows. `tone` is the colour of the row: an
 * operator forty boxes into a truck reads colour, not prose.
 */
export type ScanTone = "ok" | "warn" | "bad";

export type ScanOutcome = {
  ok: boolean;
  tone: ScanTone;
  barcode: string;
  /** Short line under the barcode. Written to be read at a glance. */
  message: string;
  scanRecordId: string | null;
  shipmentId: string | null;
  lrNumber: string | null;
  packageId: string | null;
  packageSequence: number | null;
  packageCount: number | null;
  destinationBranchCode: string | null;
  /** True when this exact trigger pull had already been recorded. */
  duplicate: boolean;
  /** True when the barcode resolved to a real package or consignment. */
  recognised: boolean;
  /** True when the barcode was expected at this receipt or sheet. */
  isExpected: boolean;
  /** Set when a status change followed. */
  newStatus: string | null;
  at: string;
};

function fail(
  barcode: string,
  message: string,
  tone: ScanTone = "bad",
): ScanOutcome {
  return {
    ok: false,
    tone,
    barcode,
    message,
    scanRecordId: null,
    shipmentId: null,
    lrNumber: null,
    packageId: null,
    packageSequence: null,
    packageCount: null,
    destinationBranchCode: null,
    duplicate: false,
    recognised: false,
    isExpected: false,
    newStatus: null,
    at: new Date().toISOString(),
  };
}

export type ResolvedBarcode =
  | {
      kind: "PACKAGE";
      packageId: string;
      sequence: number;
      shipmentId: string;
      lrNumber: string;
      packageCount: number;
      currentStatus: string;
      destinationBranchId: string;
      destinationBranchCode: string;
    }
  | {
      kind: "SHIPMENT";
      packageId: null;
      sequence: null;
      shipmentId: string;
      lrNumber: string;
      packageCount: number;
      currentStatus: string;
      destinationBranchId: string;
      destinationBranchCode: string;
    }
  | { kind: "UNKNOWN" };

/**
 * Turns whatever came off the gun into a package or a consignment.
 *
 * Guns read package labels; humans read out LR numbers over the phone.
 * Both must work, so an LR number resolves to the consignment and a
 * package barcode to the box.
 */
export async function resolveBarcode(
  barcode: string,
  client: DbOrTx = prisma,
): Promise<ResolvedBarcode> {
  const code = normaliseBarcode(barcode);
  if (code === "") return { kind: "UNKNOWN" };

  // `findFirst`, not `findUnique`: a package barcode is only unique within a
  // tenant now, and a bare `findUnique({ barcode })` resolved — and then let
  // the caller update — whichever carrier's row happened to hold the code.
  // Going through the scoped form is what stops a gun in one carrier's hub
  // reaching into another's packages.
  const pkg = await client.shipmentPackage.findFirst({
    where: { barcode: code },
    select: {
      id: true,
      sequence: true,
      shipmentId: true,
      shipment: {
        select: {
          lrNumber: true,
          packageCount: true,
          currentStatus: true,
          destinationBranchId: true,
          destinationBranch: { select: { code: true } },
        },
      },
    },
  });

  if (pkg) {
    return {
      kind: "PACKAGE",
      packageId: pkg.id,
      sequence: pkg.sequence,
      shipmentId: pkg.shipmentId,
      lrNumber: pkg.shipment.lrNumber,
      packageCount: pkg.shipment.packageCount,
      currentStatus: pkg.shipment.currentStatus,
      destinationBranchId: pkg.shipment.destinationBranchId,
      destinationBranchCode: pkg.shipment.destinationBranch.code,
    };
  }

  // An LR number is only unique within a tenant now, so this is a scoped
  // lookup rather than a global one — the extension supplies the org.
  const shipment = await client.shipment.findFirst({
    where: { lrNumber: code },
    select: {
      id: true,
      lrNumber: true,
      packageCount: true,
      currentStatus: true,
      deletedAt: true,
      destinationBranchId: true,
      destinationBranch: { select: { code: true } },
    },
  });

  if (shipment && !shipment.deletedAt) {
    return {
      kind: "SHIPMENT",
      packageId: null,
      sequence: null,
      shipmentId: shipment.id,
      lrNumber: shipment.lrNumber,
      packageCount: shipment.packageCount,
      currentStatus: shipment.currentStatus,
      destinationBranchId: shipment.destinationBranchId,
      destinationBranchCode: shipment.destinationBranch.code,
    };
  }

  return { kind: "UNKNOWN" };
}

/**
 * Records one scan.
 *
 * The ScanRecord and the shipment event commit together: a scan the
 * operator saw go green must never be missing from the timeline, and a
 * timeline entry must never exist without the scan that caused it.
 */
export async function recordScan(
  input: ScanInput,
  actor: SessionUser,
  /** Barcodes this context expected, for green/red feedback at the dock. */
  expectedBarcodes?: ReadonlySet<string> | null,
): Promise<ScanOutcome> {
  const barcode = normaliseBarcode(input.barcode);
  if (barcode === "") return fail(barcode, "Empty scan ignored.");

  const permission = SCAN_PERMISSION[input.scanType];
  if (!can(actor, permission)) {
    return fail(barcode, `You do not have permission to scan ${SCAN_TYPE_LABELS[input.scanType].toLowerCase()}.`);
  }
  if (!coversBranch(actor, input.branchId)) {
    return fail(barcode, "You cannot scan at that branch.");
  }

  // ── Idempotency ───────────────────────────────────────────
  // Checked before anything is written so a retried offline batch replays
  // as a series of no-ops rather than a series of duplicate boxes.
  // Scoped by the extension: the key is client-generated, so two tenants
  // can legitimately mint the same one and neither may see the other's scan.
  const existing = await prisma.scanRecord.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    select: {
      id: true,
      barcode: true,
      isExpected: true,
      shipmentId: true,
      packageId: true,
      recordedAt: true,
      shipment: { select: { lrNumber: true, packageCount: true } },
      package: { select: { sequence: true } },
    },
  });

  if (existing) {
    return {
      ok: true,
      tone: "warn",
      barcode: existing.barcode,
      message: "Already recorded — this scan was retried.",
      scanRecordId: existing.id,
      shipmentId: existing.shipmentId,
      lrNumber: existing.shipment?.lrNumber ?? null,
      packageId: existing.packageId,
      packageSequence: existing.package?.sequence ?? null,
      packageCount: existing.shipment?.packageCount ?? null,
      destinationBranchCode: null,
      duplicate: true,
      recognised: Boolean(existing.shipmentId),
      isExpected: existing.isExpected,
      newStatus: null,
      at: existing.recordedAt.toISOString(),
    };
  }

  const resolved = await resolveBarcode(barcode);
  const recognised = resolved.kind !== "UNKNOWN";

  // "Expected" means "on the paperwork in front of this operator". With
  // no paperwork — a loose sort scan — anything recognised is expected.
  const isExpected = expectedBarcodes
    ? expectedBarcodes.has(barcode)
    : recognised;

  const scannedAt = input.scannedAt ?? new Date();

  const result = await tenantTransaction(async (tx) => {
    const record = await tx.scanRecord.create({
      data: {
        // The operator's own tenant, which the extension then checks the
        // scan against — a scan is a fact about who was holding the gun.
        orgId: actor.orgId,
        scanType: input.scanType,
        barcode,
        packageId: resolved.kind === "PACKAGE" ? resolved.packageId : undefined,
        shipmentId: recognised ? resolved.shipmentId : undefined,
        branchId: input.branchId,
        userId: actor.id,
        deviceId: input.deviceId ?? undefined,
        manifestId: input.manifestId ?? undefined,
        tripId: input.tripId ?? undefined,
        loadingSheetId: input.loadingSheetId ?? undefined,
        receiptId: input.receiptId ?? undefined,
        latitude: input.latitude ?? undefined,
        longitude: input.longitude ?? undefined,
        scannedAt,
        idempotencyKey: input.idempotencyKey,
        isExpected,
        remarks: input.remarks ?? undefined,
      },
      select: { id: true, recordedAt: true },
    });

    if (!recognised) {
      return { record, eventMessage: null as string | null, newStatus: null as string | null };
    }

    // ── Where the package now sits ────────────────────────
    //
    // A stock audit is a count, and a count that writes is not a count:
    // it moved `currentBranchId` onto the auditing branch and, for a
    // barcode still sitting at BOOKED, quietly promoted the package to
    // IN_NETWORK. An audit that disagrees with the system is precisely
    // the thing worth finding, so it is recorded and nothing is touched.
    if (resolved.kind === "PACKAGE" && input.scanType !== "AUDIT") {
      await tx.shipmentPackage.update({
        where: { id: resolved.packageId },
        data: {
          currentBranchId: input.branchId,
          ...(resolved.currentStatus === "BOOKED" || input.scanType === "INBOUND"
            ? { status: "IN_NETWORK" as const }
            : {}),
        },
      });

      if (input.scanType === "SORT") {
        // Bin occupancy is what tells the floor which lane is building up.
        await tx.packageLocation.upsert({
          where: { packageId: resolved.packageId },
          create: {
            // Same tenant as the ScanRecord above: the bin, the package and
            // the operator are all one carrier's, and `resolveBarcode` was
            // already scoped to them.
            orgId: actor.orgId,
            packageId: resolved.packageId,
            branchId: input.branchId,
            binId: input.binId ?? undefined,
            placedById: actor.id,
          },
          update: {
            branchId: input.branchId,
            binId: input.binId ?? null,
            placedAt: scannedAt,
            placedById: actor.id,
            removedAt: null,
          },
        });
      }
    }

    const eventType = EVENT[input.scanType];
    if (!eventType) {
      return { record, eventMessage: null, newStatus: null };
    }

    const event = await appendShipmentEvent(
      {
        shipmentId: resolved.shipmentId,
        eventType,
        packageId: resolved.kind === "PACKAGE" ? resolved.packageId : null,
        occurredAt: scannedAt,
        branchId: input.branchId,
        tripId: input.tripId ?? undefined,
        manifestId: input.manifestId ?? undefined,
        deviceId: input.deviceId ?? undefined,
        latitude: input.latitude ?? undefined,
        longitude: input.longitude ?? undefined,
        // The scan's key is reused with a suffix: one trigger pull yields
        // at most one event, however many times the queue retries it.
        idempotencyKey: `scan:${input.idempotencyKey}`,
        payload: { barcode, scanType: input.scanType },
      },
      actor,
      tx,
    );

    if (event.ok) {
      return {
        record,
        eventMessage: null,
        newStatus: event.statusChanged ? event.currentStatus : null,
      };
    }

    // The transition was refused — usually a box scanned inbound twice, or
    // one sorted before it was received. The scan itself stands; refusing
    // to record it would lose the only evidence the box was here.
    return { record, eventMessage: event.error, newStatus: null };
  });

  const lrNumber = recognised ? resolved.lrNumber : null;
  const sequenceLabel =
    resolved.kind === "PACKAGE"
      ? ` · box ${resolved.sequence} of ${resolved.packageCount}`
      : "";

  if (!recognised) {
    return {
      ok: true,
      tone: "bad",
      barcode,
      message: "Not a known barcode. Recorded as unexpected.",
      scanRecordId: result.record.id,
      shipmentId: null,
      lrNumber: null,
      packageId: null,
      packageSequence: null,
      packageCount: null,
      destinationBranchCode: null,
      duplicate: false,
      recognised: false,
      isExpected: false,
      newStatus: null,
      at: result.record.recordedAt.toISOString(),
    };
  }

  const tone: ScanTone = !isExpected
    ? "bad"
    : result.eventMessage
      ? "warn"
      : "ok";

  return {
    ok: true,
    tone,
    barcode,
    message: !isExpected
      ? `${lrNumber} is not on this list — recorded as excess.`
      : (result.eventMessage ?? `${lrNumber}${sequenceLabel}`),
    scanRecordId: result.record.id,
    shipmentId: resolved.shipmentId,
    lrNumber,
    packageId: resolved.kind === "PACKAGE" ? resolved.packageId : null,
    packageSequence: resolved.kind === "PACKAGE" ? resolved.sequence : null,
    packageCount: resolved.packageCount,
    destinationBranchCode: resolved.destinationBranchCode,
    duplicate: false,
    recognised: true,
    isExpected,
    newStatus: result.newStatus,
    at: result.record.recordedAt.toISOString(),
  };
}
