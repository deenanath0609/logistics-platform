import { prisma, tenantTransaction, type DbOrTx } from "@/lib/prisma";
import type { DiscrepancyKind, Prisma } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { appendShipmentEvent } from "@/lib/shipment/events";
import { raiseException } from "@/lib/exceptions/service";
import { recordAudit } from "@/server/services/audit";
import { recordScan, type ScanOutcome } from "./scan";
import {
  reconcile,
  normaliseBarcode,
  type ActualScan,
  type ExpectedLine,
  type ReconcileResult,
} from "./reconcile";

/**
 * Inbound receipt.
 *
 * Opening one turns a manifest into a checklist. Closing one is the
 * single most consequential action in the module: it converts every
 * unscanned line into a SHORT and every unexpected scan into an EXCESS,
 * automatically, with the dispatching branch as owner (BRD §A.6).
 *
 * "Automatically" is the whole point. A discrepancy that depends on a
 * tired clerk remembering to raise it is a discrepancy that gets raised
 * only when it is somebody else's fault.
 */

/** Reason codes the automation attaches. Seeded under ReasonCategory.SHORTAGE. */
const REASON_CODE: Record<DiscrepancyKind, string | null> = {
  SHORT: "SH-SHORT",
  EXCESS: "SH-EXCESS",
  SEAL_BROKEN: "SH-SEAL",
  DAMAGED: "DM-TRANSIT",
  MISROUTED: "EX-MISROUTED",
};

export type OpenReceiptInput = {
  manifestId: string;
  branchId: string;
  tripId?: string | null;
  sealIntact?: boolean | null;
  remarks?: string | null;
};

export type OpenReceiptResult =
  | { ok: true; receiptId: string; reopened: boolean }
  | { ok: false; error: string };

export async function openReceipt(
  input: OpenReceiptInput,
  actor: SessionUser,
): Promise<OpenReceiptResult> {
  if (!can(actor, "scan.inbound")) {
    return { ok: false, error: "You do not have permission to receive inbound freight." };
  }
  if (!coversBranch(actor, input.branchId)) {
    return { ok: false, error: "You cannot receive at that branch." };
  }

  const manifest = await prisma.manifest.findUnique({
    where: { id: input.manifestId },
    select: {
      id: true,
      number: true,
      status: true,
      destinationBranchId: true,
      tripId: true,
      trip: { select: { number: true } },
      lines: {
        select: {
          shipmentId: true,
          packageCount: true,
          shipment: { select: { lrNumber: true } },
        },
      },
    },
  });

  if (!manifest) return { ok: false, error: "That manifest does not exist." };

  if (manifest.status === "DRAFT") {
    return {
      ok: false,
      error: `${manifest.number} has not been closed for dispatch yet — nothing has left the origin branch.`,
    };
  }
  if (manifest.status === "CANCELLED") {
    return { ok: false, error: `${manifest.number} was cancelled.` };
  }
  // Closed for dispatch but never gated out. The truck has, on paper,
  // not left — so every consignment on it is still MANIFESTED, and the
  // state machine takes an inbound scan from DISPATCHED, not from there.
  // Opening the receipt anyway used to "work": the lines ticked green,
  // the reconciliation came out clean, and not one consignment moved.
  // The dock would have signed for freight the network still believed
  // was standing at the origin.
  if (manifest.status === "CLOSED") {
    return {
      ok: false,
      error:
        `${manifest.number} has not been gated out${manifest.trip ? ` — ${manifest.trip.number} is still at the origin` : ""}. ` +
        `Receiving it now would record the boxes and move none of them. ` +
        `Ask the dispatching branch to gate the vehicle out first.`,
    };
  }
  // A manifest is reconciled once. A second receipt would re-run the
  // whole reconciliation against a fresh, empty set of scans and file
  // every package on it as short a second time, against a branch that
  // has already answered for it.
  if (manifest.status === "RECEIVED" || manifest.status === "RECONCILED") {
    return {
      ok: false,
      error:
        `${manifest.number} has already been received and reconciled. ` +
        `Anything found afterwards belongs on the existing receipt's discrepancies, not on a second one.`,
    };
  }
  if (manifest.destinationBranchId !== input.branchId) {
    return {
      ok: false,
      error: `${manifest.number} is consigned to another branch. Receiving it here would hide a misroute — raise it as an exception instead.`,
    };
  }

  // An open receipt is resumed, not duplicated: the dock walks away from a
  // half-scanned truck all the time, and a second receipt would split the
  // scans across two reconciliations.
  const existing = await prisma.inboundReceipt.findFirst({
    where: { manifestId: manifest.id, branchId: input.branchId, status: "OPEN" },
    select: { id: true, sealIntact: true },
  });

  if (existing) {
    // The dialog asks about the seal before it hands the receipt back, and
    // the answer used to go nowhere on this path: a clerk who arrived at a
    // half-scanned truck, saw a cut seal and said so was returned to the
    // console with the receipt still reading "not checked". Recorded only
    // when there is something to record and nothing recorded yet — a
    // second opener shrugging "not checked" must not erase the first
    // opener's "broken".
    if (input.sealIntact != null && existing.sealIntact === null) {
      await prisma.inboundReceipt.update({
        where: { id: existing.id },
        data: { sealIntact: input.sealIntact },
      });
    }
    return { ok: true, receiptId: existing.id, reopened: true };
  }

  const expectedPackages = manifest.lines.reduce(
    (sum, line) => sum + line.packageCount,
    0,
  );

  const receipt = await tenantTransaction(async (tx) => {
    const created = await tx.inboundReceipt.create({
      data: {
        // The receiving clerk's own tenant. The extension refuses the write
        // if it disagrees with the host, so naming it here asserts rather
        // than trusts.
        orgId: actor.orgId,
        branchId: input.branchId,
        manifestId: manifest.id,
        tripId: input.tripId ?? manifest.tripId ?? undefined,
        status: "OPEN",
        expectedShipments: manifest.lines.length,
        expectedPackages,
        sealIntact: input.sealIntact ?? undefined,
        openedById: actor.id,
        remarks: input.remarks ?? undefined,
      },
      select: { id: true },
    });

    await tx.inboundReceiptLine.createMany({
      data: manifest.lines.map((line) => ({
        orgId: actor.orgId,
        receiptId: created.id,
        shipmentId: line.shipmentId,
        expectedPackages: line.packageCount,
      })),
    });

    return created;
  });

  await recordAudit({
    user: actor,
    action: "CREATE",
    entity: "InboundReceipt",
    entityId: receipt.id,
    entityRef: manifest.number,
    branchId: input.branchId,
    after: { manifest: manifest.number, expectedPackages, lines: manifest.lines.length },
  });

  return { ok: true, receiptId: receipt.id, reopened: false };
}

/** The barcodes a receipt is waiting for, normalised for comparison. */
export async function expectedBarcodesFor(
  receiptId: string,
  client: DbOrTx = prisma,
): Promise<Set<string>> {
  const packages = await client.shipmentPackage.findMany({
    where: { shipment: { receiptLines: { some: { receiptId } } } },
    select: { barcode: true },
  });

  return new Set(packages.map((p) => normaliseBarcode(p.barcode)));
}

export type ReceiptScanResult = {
  outcome: ScanOutcome;
  /** Post-scan tallies, so the screen updates without a round trip. */
  line: { shipmentId: string; scannedPackages: number; expectedPackages: number } | null;
  scannedPackages: number;
};

/**
 * One scan against an open receipt.
 *
 * Ticks the matching line; an unexpected barcode is recorded against the
 * receipt anyway, flagged red, and becomes an EXCESS at close.
 */
export async function scanIntoReceipt(
  input: {
    receiptId: string;
    barcode: string;
    idempotencyKey: string;
    scannedAt?: Date;
    deviceId?: string | null;
    remarks?: string | null;
  },
  actor: SessionUser,
): Promise<{ ok: true; result: ReceiptScanResult } | { ok: false; error: string }> {
  const receipt = await prisma.inboundReceipt.findUnique({
    where: { id: input.receiptId },
    select: {
      id: true,
      branchId: true,
      status: true,
      manifestId: true,
      tripId: true,
    },
  });

  if (!receipt) return { ok: false, error: "That receipt does not exist." };
  if (receipt.status !== "OPEN") {
    return { ok: false, error: "This receipt is closed. Reopen it or raise an exception." };
  }
  if (!coversBranch(actor, receipt.branchId)) {
    return { ok: false, error: "You cannot scan into that branch's receipt." };
  }

  const expected = await expectedBarcodesFor(receipt.id);

  const outcome = await recordScan(
    {
      barcode: input.barcode,
      scanType: "INBOUND",
      branchId: receipt.branchId,
      idempotencyKey: input.idempotencyKey,
      scannedAt: input.scannedAt,
      deviceId: input.deviceId,
      manifestId: receipt.manifestId,
      tripId: receipt.tripId,
      receiptId: receipt.id,
      remarks: input.remarks,
    },
    actor,
    expected,
  );

  if (!outcome.ok) return { ok: false, error: outcome.message };

  // ── Tick the line ─────────────────────────────────────────
  // Recounted from the ScanRecord rows rather than incremented, so a
  // retried scan cannot tick a line twice.
  let line: ReceiptScanResult["line"] = null;

  if (outcome.shipmentId && outcome.isExpected && !outcome.duplicate) {
    const distinct = await prisma.scanRecord.findMany({
      where: { receiptId: receipt.id, shipmentId: outcome.shipmentId, isExpected: true },
      distinct: ["barcode"],
      select: { barcode: true },
    });

    const updated = await prisma.inboundReceiptLine.update({
      where: {
        receiptId_shipmentId: {
          receiptId: receipt.id,
          shipmentId: outcome.shipmentId,
        },
      },
      data: { scannedPackages: distinct.length },
      select: { shipmentId: true, scannedPackages: true, expectedPackages: true },
    });

    line = updated;
  }

  const scannedPackages = await prisma.scanRecord
    .findMany({
      where: { receiptId: receipt.id, isExpected: true },
      distinct: ["barcode"],
      select: { barcode: true },
    })
    .then((rows) => rows.length);

  await prisma.inboundReceipt.update({
    where: { id: receipt.id },
    data: { scannedPackages },
  });

  return { ok: true, result: { outcome, line, scannedPackages } };
}

export type CloseReceiptInput = {
  receiptId: string;
  sealIntact?: boolean | null;
  remarks?: string | null;
};

export type CloseReceiptResult =
  | {
      ok: true;
      reconciliation: ReconcileResult;
      discrepanciesRaised: number;
      /** Exceptions opened in the tower against the dispatching branch. */
      exceptionNumbers: string[];
      warnings: string[];
    }
  | { ok: false; error: string };

/**
 * Close and reconcile.
 *
 * Everything the manifest declared and the dock did not scan becomes a
 * SHORT; everything scanned that the manifest did not declare becomes an
 * EXCESS. Both are owned by the branch that dispatched the manifest,
 * because that is the branch that can answer for them.
 */
export async function closeReceipt(
  input: CloseReceiptInput,
  actor: SessionUser,
): Promise<CloseReceiptResult> {
  if (!can(actor, "receipt.close")) {
    return { ok: false, error: "You do not have permission to close a receipt." };
  }

  const receipt = await prisma.inboundReceipt.findUnique({
    where: { id: input.receiptId },
    select: {
      id: true,
      branchId: true,
      status: true,
      manifestId: true,
      sealIntact: true,
      manifest: {
        select: {
          id: true,
          number: true,
          originBranchId: true,
          lines: {
            select: {
              shipmentId: true,
              packageCount: true,
              shipment: {
                select: {
                  lrNumber: true,
                  packages: { select: { id: true, barcode: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!receipt) return { ok: false, error: "That receipt does not exist." };
  if (receipt.status !== "OPEN") {
    return { ok: false, error: "This receipt has already been closed." };
  }
  if (!coversBranch(actor, receipt.branchId)) {
    return { ok: false, error: "You cannot close that branch's receipt." };
  }
  if (!receipt.manifest) {
    return { ok: false, error: "This receipt has no manifest to reconcile against." };
  }

  // ── Gather both sides ─────────────────────────────────────
  const expected: ExpectedLine[] = receipt.manifest.lines.map((line) => ({
    shipmentId: line.shipmentId,
    lrNumber: line.shipment.lrNumber,
    expectedPackages: line.packageCount,
    barcodes: line.shipment.packages.map((p) => p.barcode),
  }));

  const scans = await prisma.scanRecord.findMany({
    where: { receiptId: receipt.id },
    orderBy: { scannedAt: "asc" },
    select: {
      barcode: true,
      packageId: true,
      shipmentId: true,
      scannedAt: true,
    },
  });

  const actual: ActualScan[] = scans.map((scan) => ({
    barcode: scan.barcode,
    packageId: scan.packageId,
    shipmentId: scan.shipmentId,
    scannedAt: scan.scannedAt,
  }));

  const reconciliation = reconcile(expected, actual);

  // Barcode → package id, so a shortage can name the row it refers to.
  const packageIdByBarcode = new Map<string, string>();
  for (const line of receipt.manifest.lines) {
    for (const pkg of line.shipment.packages) {
      packageIdByBarcode.set(normaliseBarcode(pkg.barcode), pkg.id);
    }
  }

  const sealIntact = input.sealIntact ?? receipt.sealIntact;
  const sealBroken = sealIntact === false;

  // ── Reason codes ──────────────────────────────────────────
  const reasonCodes = await prisma.reasonCode.findMany({
    where: {
      code: { in: [REASON_CODE.SHORT, REASON_CODE.EXCESS, REASON_CODE.SEAL_BROKEN].filter((c): c is string => Boolean(c)) },
      isActive: true,
    },
    select: { id: true, code: true },
  });
  const reasonIdByCode = new Map(reasonCodes.map((r) => [r.code, r.id]));

  const warnings: string[] = [];
  function reasonIdFor(kind: DiscrepancyKind): string | null {
    const code = REASON_CODE[kind];
    const id = code ? reasonIdByCode.get(code) ?? null : null;
    if (!id && code) {
      const warning = `Reason code ${code} is missing, so no timeline event was raised for the ${kind.toLowerCase()} entries. The discrepancies themselves were saved.`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    return id;
  }

  const ownerBranchId = receipt.manifest.originBranchId;
  const now = new Date();

  type PendingDiscrepancy = Prisma.ReceiptDiscrepancyCreateManyInput;
  const discrepancies: PendingDiscrepancy[] = [];

  for (const item of reconciliation.short) {
    discrepancies.push({
      // The clerk closing the receipt. `ownerBranchId` below points at the
      // dispatching branch, which answers for the shortage — but that is
      // another branch of the same carrier, never another carrier.
      orgId: actor.orgId,
      receiptId: receipt.id,
      kind: "SHORT",
      shipmentId: item.shipmentId,
      packageId: item.barcode ? packageIdByBarcode.get(item.barcode) ?? null : null,
      barcode: item.barcode,
      quantity: 1,
      reasonCodeId: reasonIdFor("SHORT"),
      ownerBranchId,
      remarks: item.barcode
        ? `Declared on ${receipt.manifest.number}, never scanned at this hub.`
        : `Declared on ${receipt.manifest.number} without a package label, and unaccounted for.`,
      createdById: actor.id,
    });
  }

  for (const item of reconciliation.excess) {
    discrepancies.push({
      orgId: actor.orgId,
      receiptId: receipt.id,
      kind: "EXCESS",
      shipmentId: item.shipmentId,
      packageId: item.packageId,
      barcode: item.barcode,
      quantity: 1,
      reasonCodeId: reasonIdFor("EXCESS"),
      ownerBranchId,
      remarks:
        item.reason === "NOT_ON_MANIFEST"
          ? `Scanned here but not listed on ${receipt.manifest.number} — likely misrouted.`
          : `Scanned here; the barcode matches nothing in the system.`,
      createdById: actor.id,
    });
  }

  if (sealBroken) {
    discrepancies.push({
      orgId: actor.orgId,
      receiptId: receipt.id,
      kind: "SEAL_BROKEN",
      quantity: 1,
      reasonCodeId: reasonIdFor("SEAL_BROKEN"),
      ownerBranchId,
      remarks: "Seal reported broken on arrival.",
      createdById: actor.id,
    });
  }

  // ── Write ─────────────────────────────────────────────────
  // Counts, discrepancy rows, line tallies, manifest status and every
  // timeline event commit together. A half-closed receipt would leave a
  // shortage nobody owns.
  const eventFailures: string[] = [];

  await tenantTransaction(async (tx) => {
    for (const line of reconciliation.lines) {
      await tx.inboundReceiptLine.updateMany({
        where: { receiptId: receipt.id, shipmentId: line.shipmentId },
        data: { scannedPackages: line.scannedPackages },
      });
    }

    if (discrepancies.length > 0) {
      await tx.receiptDiscrepancy.createMany({ data: discrepancies });
    }

    await tx.inboundReceipt.update({
      where: { id: receipt.id },
      data: {
        status: reconciliation.isClean && !sealBroken ? "RECONCILED" : "CLOSED",
        scannedPackages: reconciliation.totals.matchedPackages,
        shortPackages: reconciliation.totals.shortPackages,
        excessPackages: reconciliation.totals.excessPackages,
        damagedPackages: reconciliation.totals.damagedPackages,
        sealIntact: sealIntact ?? undefined,
        closedAt: now,
        closedById: actor.id,
        remarks: input.remarks ?? undefined,
      },
    });

    await tx.manifest.update({
      where: { id: receipt.manifest!.id },
      data: {
        status: reconciliation.isClean ? "RECONCILED" : "RECEIVED",
        receivedAt: now,
        receivedById: actor.id,
      },
    });

    // ── Timeline events ────────────────────────────────────
    // One DISCREPANCY_RAISED per affected shipment, not per package: the
    // consignment's timeline should read "3 packages short", not repeat
    // the same sentence three times.
    const shortReason = reasonIdFor("SHORT");
    if (shortReason) {
      const byShipment = new Map<string, string[]>();
      for (const item of reconciliation.short) {
        const list = byShipment.get(item.shipmentId) ?? [];
        list.push(item.barcode ?? "unlabelled");
        byShipment.set(item.shipmentId, list);
      }

      for (const [shipmentId, barcodes] of byShipment) {
        const event = await appendShipmentEvent(
          {
            shipmentId,
            eventType: "DISCREPANCY_RAISED",
            branchId: receipt.branchId,
            manifestId: receipt.manifest!.id,
            reasonCodeId: shortReason,
            occurredAt: now,
            idempotencyKey: `receipt:${receipt.id}:short:${shipmentId}`,
            remarks: `${barcodes.length} package${barcodes.length === 1 ? "" : "s"} short against ${receipt.manifest!.number}.`,
            payload: {
              kind: "SHORT",
              manifest: receipt.manifest!.number,
              barcodes,
              ownerBranchId,
            },
          },
          actor,
          tx,
        );

        if (!event.ok) eventFailures.push(`${shipmentId}: ${event.error}`);
      }
    }

    const excessReason = reasonIdFor("EXCESS");
    if (excessReason) {
      const byShipment = new Map<string, string[]>();
      for (const item of reconciliation.excess) {
        if (!item.shipmentId) continue; // Unknown barcode — nothing to event.
        const list = byShipment.get(item.shipmentId) ?? [];
        list.push(item.barcode);
        byShipment.set(item.shipmentId, list);
      }

      for (const [shipmentId, barcodes] of byShipment) {
        const event = await appendShipmentEvent(
          {
            shipmentId,
            eventType: "DISCREPANCY_RAISED",
            branchId: receipt.branchId,
            manifestId: receipt.manifest!.id,
            reasonCodeId: excessReason,
            occurredAt: now,
            idempotencyKey: `receipt:${receipt.id}:excess:${shipmentId}`,
            remarks: `${barcodes.length} package${barcodes.length === 1 ? "" : "s"} received here but not listed on ${receipt.manifest!.number}.`,
            payload: {
              kind: "EXCESS",
              manifest: receipt.manifest!.number,
              barcodes,
              ownerBranchId,
            },
          },
          actor,
          tx,
        );

        if (!event.ok) eventFailures.push(`${shipmentId}: ${event.error}`);
      }
    }
  });

  if (eventFailures.length > 0) {
    // The discrepancy rows are the record of account and they were
    // written. A refused transition here means a shipment was already
    // closed or cancelled — worth surfacing, not worth rolling back.
    warnings.push(
      `${eventFailures.length} shipment timeline${eventFailures.length === 1 ? "" : "s"} could not accept a discrepancy event: ${eventFailures.join("; ")}`,
    );
  }

  // ── The tower ─────────────────────────────────────────────
  //
  // A discrepancy row records that freight is missing. It does not make
  // anybody answer for it: nothing chases it, nothing escalates it, and
  // the only place it appears is a receipt the closing clerk has already
  // walked away from. The exception tower is where the duty manager runs
  // the shift, and `SHORT_RECEIVED` and `EXCESS_RECEIVED` — owner
  // "Dispatching branch", detected by "Hub inbound scan", with a seeded
  // ladder escalating to the branch manager after a day and the ops
  // manager after two — were defined for exactly this and raised by
  // nothing. The loss-and-damage figure on the insights report counts
  // `SHORT_RECEIVED`, so it was structurally always zero.
  //
  // Raised after the transaction, never inside it: the reconciliation is
  // the record of account and must not roll back because the tower was
  // briefly unavailable.
  const exceptionNumbers = await raiseReceiptExceptions(
    {
      receiptId: receipt.id,
      receivingBranchId: receipt.branchId,
      ownerBranchId,
      manifestNumber: receipt.manifest.number,
      orgId: actor.orgId,
      reconciliation,
      sealBroken,
      shortReasonId: reasonIdByCode.get(REASON_CODE.SHORT ?? "") ?? null,
      excessReasonId: reasonIdByCode.get(REASON_CODE.EXCESS ?? "") ?? null,
      sealReasonId: reasonIdByCode.get(REASON_CODE.SEAL_BROKEN ?? "") ?? null,
    },
    warnings,
  );

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "InboundReceipt",
    entityId: receipt.id,
    entityRef: receipt.manifest.number,
    branchId: receipt.branchId,
    reason: reconciliation.isClean
      ? "Receipt closed clean"
      : `Receipt closed with ${reconciliation.totals.shortPackages} short and ${reconciliation.totals.excessPackages} excess`,
    after: {
      expectedPackages: reconciliation.totals.expectedPackages,
      matchedPackages: reconciliation.totals.matchedPackages,
      shortPackages: reconciliation.totals.shortPackages,
      excessPackages: reconciliation.totals.excessPackages,
      sealIntact,
      ownerBranchId,
      exceptions: exceptionNumbers,
    },
  });

  return {
    ok: true,
    reconciliation,
    discrepanciesRaised: discrepancies.length,
    exceptionNumbers,
    warnings,
  };
}

/**
 * Puts the reconciliation in front of a duty manager.
 *
 * One exception per affected consignment, matching how the timeline
 * events are grouped — a forty-line manifest that arrived three boxes
 * short is three things to chase, not three hundred. Every barcode the
 * system does not recognise is folded into a single unidentified-freight
 * exception, because they are one conversation with one branch.
 *
 * `dedupeKey` is keyed on the receipt, so closing is idempotent: nothing
 * here can double-open if the close is somehow replayed.
 *
 * Never throws. A tower that is unavailable produces a warning on the
 * close screen, not a lost reconciliation.
 */
async function raiseReceiptExceptions(
  input: {
    receiptId: string;
    receivingBranchId: string;
    /** The dispatching branch — the one that answers for the freight. */
    ownerBranchId: string;
    manifestNumber: string;
    orgId: string;
    reconciliation: ReconcileResult;
    sealBroken: boolean;
    shortReasonId: string | null;
    excessReasonId: string | null;
    sealReasonId: string | null;
  },
  warnings: string[],
): Promise<string[]> {
  const { reconciliation, manifestNumber } = input;
  const numbers: string[] = [];

  // LR numbers for the excess side. `ExcessPackage` carries the shipment
  // it really belongs to but not its number, and an exception titled with
  // a cuid is an exception nobody opens.
  const excessShipmentIds = [
    ...new Set(
      reconciliation.excess
        .map((item) => item.shipmentId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const lrByShipment = new Map<string, string>(
    reconciliation.short.map((item) => [item.shipmentId, item.lrNumber ?? ""]),
  );

  if (excessShipmentIds.length > 0) {
    const rows = await prisma.shipment.findMany({
      where: { id: { in: excessShipmentIds } },
      select: { id: true, lrNumber: true },
    });
    for (const row of rows) lrByShipment.set(row.id, row.lrNumber);
  }

  const common = {
    orgId: input.orgId,
    branchId: input.receivingBranchId,
    ownerBranchId: input.ownerBranchId,
    source: "hub",
  } as const;

  async function open(
    args: Parameters<typeof raiseException>[0],
  ): Promise<void> {
    try {
      const raised = await raiseException(args);
      if (raised.created) numbers.push(raised.exception.number);
    } catch (error) {
      console.error("[hub/receipt] exception", error);
      warnings.push(
        `The discrepancies were saved but could not be raised in the exception tower. Raise them by hand against the dispatching branch.`,
      );
    }
  }

  // ── Short ─────────────────────────────────────────────────
  const shortByShipment = new Map<string, string[]>();
  for (const item of reconciliation.short) {
    const list = shortByShipment.get(item.shipmentId) ?? [];
    list.push(item.barcode ?? "unlabelled");
    shortByShipment.set(item.shipmentId, list);
  }

  for (const [shipmentId, barcodes] of shortByShipment) {
    const lr = lrByShipment.get(shipmentId) || "This consignment";
    await open({
      ...common,
      kind: "SHORT_RECEIVED",
      shipmentId,
      reasonCodeId: input.shortReasonId,
      title: `${barcodes.length} package${barcodes.length === 1 ? "" : "s"} short on ${lr}`,
      detail:
        `${manifestNumber} declared ${barcodes.length} package${barcodes.length === 1 ? "" : "s"} ` +
        `(${barcodes.join(", ")}) that were never scanned at the receiving hub. ` +
        `The dispatching branch loaded them and owns the shortage until it can show otherwise.`,
      dedupeKey: `receipt:${input.receiptId}:short:${shipmentId}`,
    });
  }

  // ── Excess, package by known consignment ──────────────────
  const excessByShipment = new Map<string, string[]>();
  const unidentified: string[] = [];

  for (const item of reconciliation.excess) {
    if (!item.shipmentId) {
      unidentified.push(item.barcode);
      continue;
    }
    const list = excessByShipment.get(item.shipmentId) ?? [];
    list.push(item.barcode);
    excessByShipment.set(item.shipmentId, list);
  }

  for (const [shipmentId, barcodes] of excessByShipment) {
    const lr = lrByShipment.get(shipmentId) || "An unlisted consignment";
    await open({
      ...common,
      kind: "EXCESS_RECEIVED",
      shipmentId,
      reasonCodeId: input.excessReasonId,
      title: `${barcodes.length} package${barcodes.length === 1 ? "" : "s"} of ${lr} arrived unlisted`,
      detail:
        `${barcodes.join(", ")} ${barcodes.length === 1 ? "was" : "were"} scanned off the vehicle ` +
        `but ${manifestNumber} does not list ${barcodes.length === 1 ? "it" : "them"}. ` +
        `Almost certainly misrouted: the goods are here and the paperwork is somewhere else.`,
      dedupeKey: `receipt:${input.receiptId}:excess:${shipmentId}`,
    });
  }

  // ── Excess nothing in the system recognises ───────────────
  if (unidentified.length > 0) {
    await open({
      ...common,
      kind: "EXCESS_RECEIVED",
      reasonCodeId: input.excessReasonId,
      title: `${unidentified.length} unidentified package${unidentified.length === 1 ? "" : "s"} off ${manifestNumber}`,
      detail:
        `${unidentified.join(", ")} ${unidentified.length === 1 ? "was" : "were"} scanned at the dock and ` +
        `${unidentified.length === 1 ? "matches" : "match"} nothing in the system — a foreign label, another ` +
        `carrier's freight, or a misread. The goods are physically here and belong to nobody until somebody claims them.`,
      dedupeKey: `receipt:${input.receiptId}:excess:unidentified`,
    });
  }

  // ── Seal ──────────────────────────────────────────────────
  // No `SEAL_BROKEN` kind exists in the tower, and inventing one is a
  // schema change. `OTHER` carries it — the point is that a broken seal
  // reaches a duty manager at all, rather than sitting on a receipt.
  if (input.sealBroken) {
    await open({
      ...common,
      kind: "OTHER",
      priority: "HIGH",
      reasonCodeId: input.sealReasonId,
      title: `Seal broken on arrival — ${manifestNumber}`,
      detail:
        `The receiving clerk recorded the seal as broken or missing when the vehicle presented. ` +
        `Everything on ${manifestNumber} was in an unsealed vehicle for some part of the journey, ` +
        `whatever the reconciliation says.`,
      dedupeKey: `receipt:${input.receiptId}:seal`,
    });
  }

  return numbers;
}

/** Marks a discrepancy settled. Never deletes it — the row is the record. */
export async function resolveDiscrepancy(
  input: { discrepancyId: string; resolution: string },
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "discrepancy.resolve")) {
    return { ok: false, error: "You do not have permission to resolve discrepancies." };
  }

  const discrepancy = await prisma.receiptDiscrepancy.findUnique({
    where: { id: input.discrepancyId },
    select: { id: true, resolvedAt: true, receipt: { select: { branchId: true } } },
  });

  if (!discrepancy) return { ok: false, error: "That discrepancy does not exist." };
  if (discrepancy.resolvedAt) return { ok: false, error: "Already resolved." };
  if (!coversBranch(actor, discrepancy.receipt.branchId)) {
    return { ok: false, error: "That discrepancy belongs to another branch." };
  }
  if (input.resolution.trim().length < 4) {
    return { ok: false, error: "Say what the outcome was." };
  }

  await prisma.receiptDiscrepancy.update({
    where: { id: discrepancy.id },
    data: {
      resolvedAt: new Date(),
      resolvedById: actor.id,
      resolution: input.resolution.trim(),
    },
  });

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "ReceiptDiscrepancy",
    entityId: discrepancy.id,
    branchId: discrepancy.receipt.branchId,
    reason: "Discrepancy resolved",
    after: { resolution: input.resolution.trim() },
  });

  return { ok: true };
}
