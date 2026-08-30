import Decimal from "decimal.js";
import { prisma, tenantTransaction, type DbOrTx } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { nextNumber } from "@/lib/numbering/number-series";
import { appendShipmentEvent } from "@/lib/shipment/events";
import { recordAudit } from "@/server/services/audit";
import { utilisation, type Utilisation } from "./capacity";

/**
 * The manifest: the document for one leg of a trip.
 *
 * A shipment joins a manifest by an event, not by an update — adding a
 * line calls MANIFEST_ADDED and removing one calls MANIFEST_REMOVED, so
 * the consignment's timeline can answer "which truck was it on at 4pm
 * last Tuesday" without any extra bookkeeping.
 *
 * Totals are denormalised onto the manifest so a dispatcher watching
 * utilisation does not re-sum two hundred lines on every keystroke; they
 * are recomputed from the lines after every change rather than
 * incremented, because an increment that drifts is worse than a sum.
 */

export type CreateManifestInput = {
  originBranchId: string;
  destinationBranchId: string;
  tripId?: string | null;
  remarks?: string | null;
};

export type CreateManifestResult =
  | { ok: true; manifestId: string; number: string }
  | { ok: false; error: string; field?: string };

export async function createManifest(
  input: CreateManifestInput,
  actor: SessionUser,
): Promise<CreateManifestResult> {
  if (!can(actor, "manifest.create")) {
    return { ok: false, error: "You do not have permission to create manifests." };
  }
  if (!coversBranch(actor, input.originBranchId)) {
    return { ok: false, error: "You cannot dispatch from that branch.", field: "originBranchId" };
  }
  if (input.originBranchId === input.destinationBranchId) {
    return {
      ok: false,
      error: "A manifest moves freight between two branches.",
      field: "destinationBranchId",
    };
  }

  const branches = await prisma.branch.findMany({
    where: { id: { in: [input.originBranchId, input.destinationBranchId] }, deletedAt: null },
    select: { id: true, code: true },
  });

  if (branches.length !== 2) {
    return { ok: false, error: "One of those branches does not exist." };
  }

  try {
    const manifest = await tenantTransaction(async (tx) => {
      // Numbered inside the transaction: an abandoned manifest must not
      // burn M000146 and leave a hole in the sequence.
      const number = await nextNumber(
        { document: "MANIFEST" },
        tx,
      );

      return tx.manifest.create({
        data: {
          orgId: actor.orgId,
          number,
          status: "DRAFT",
          tripId: input.tripId ?? undefined,
          originBranchId: input.originBranchId,
          destinationBranchId: input.destinationBranchId,
          remarks: input.remarks ?? undefined,
          createdById: actor.id,
        },
        select: { id: true, number: true },
      });
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Manifest",
      entityId: manifest.id,
      entityRef: manifest.number,
      branchId: input.originBranchId,
      after: {
        origin: input.originBranchId,
        destination: input.destinationBranchId,
        tripId: input.tripId ?? null,
      },
    });

    return { ok: true, manifestId: manifest.id, number: manifest.number };
  } catch (error) {
    console.error("[manifest] create failed", error);
    return { ok: false, error: "Could not create the manifest. Nothing was saved." };
  }
}

/** Re-sums the lines. Called after every add and remove. */
export async function recomputeTotals(
  manifestId: string,
  client: DbOrTx = prisma,
): Promise<{ totalShipments: number; totalPackages: number; totalWeight: string }> {
  const lines = await client.manifestLine.findMany({
    where: { manifestId },
    select: { packageCount: true, weight: true },
  });

  const totalPackages = lines.reduce((sum, line) => sum + line.packageCount, 0);
  const totalWeight = lines
    .reduce((sum, line) => sum.plus(new Decimal(line.weight.toString())), new Decimal(0))
    .toFixed(3);

  await client.manifest.update({
    where: { id: manifestId },
    data: { totalShipments: lines.length, totalPackages, totalWeight },
  });

  return { totalShipments: lines.length, totalPackages, totalWeight };
}

export type AddToManifestResult = {
  ok: boolean;
  added: string[];
  /** LR numbers that could not be added, each with why. */
  rejected: Array<{ lrNumber: string; reason: string }>;
  error?: string;
};

/**
 * Adds shipments to a draft manifest.
 *
 * Only PROCESSED consignments qualify: a box that has not been sorted has
 * no confirmed destination, and manifesting it is how freight ends up in
 * the wrong city. Partial success is the right behaviour here — a
 * dispatcher pasting forty LR numbers should not lose thirty-nine
 * because one was already loaded.
 */
export async function addShipmentsToManifest(
  input: { manifestId: string; shipmentIds: string[] },
  actor: SessionUser,
): Promise<AddToManifestResult> {
  if (!can(actor, "manifest.update")) {
    return { ok: false, added: [], rejected: [], error: "You do not have permission to edit manifests." };
  }

  const manifest = await prisma.manifest.findUnique({
    where: { id: input.manifestId },
    select: {
      id: true,
      number: true,
      status: true,
      originBranchId: true,
      destinationBranchId: true,
    },
  });

  if (!manifest) return { ok: false, added: [], rejected: [], error: "That manifest does not exist." };
  if (manifest.status !== "DRAFT") {
    return {
      ok: false,
      added: [],
      rejected: [],
      error: `${manifest.number} is ${manifest.status.toLowerCase()} — reopen it before changing the lines.`,
    };
  }
  if (!coversBranch(actor, manifest.originBranchId)) {
    return { ok: false, added: [], rejected: [], error: "That manifest belongs to another branch." };
  }

  const shipments = await prisma.shipment.findMany({
    where: { id: { in: input.shipmentIds }, deletedAt: null },
    select: {
      id: true,
      lrNumber: true,
      currentStatus: true,
      isOnHold: true,
      packageCount: true,
      chargeableWeight: true,
      actualWeight: true,
      mode: true,
    },
  });

  const added: string[] = [];
  const rejected: AddToManifestResult["rejected"] = [];
  const found = new Set(shipments.map((s) => s.id));

  for (const id of input.shipmentIds) {
    if (!found.has(id)) rejected.push({ lrNumber: id, reason: "Not found" });
  }

  await tenantTransaction(async (tx) => {
    for (const shipment of shipments) {
      if (shipment.mode === "FTL") {
        rejected.push({
          lrNumber: shipment.lrNumber,
          reason: "FTL consignments bind to a trip directly and never sit on a manifest.",
        });
        continue;
      }
      if (shipment.isOnHold) {
        rejected.push({ lrNumber: shipment.lrNumber, reason: "On hold" });
        continue;
      }
      if (shipment.currentStatus !== "PROCESSED") {
        rejected.push({
          lrNumber: shipment.lrNumber,
          reason: `Is ${shipment.currentStatus.replace(/_/g, " ").toLowerCase()}, not processed — sort it first`,
        });
        continue;
      }

      const existing = await tx.manifestLine.findUnique({
        where: {
          manifestId_shipmentId: { manifestId: manifest.id, shipmentId: shipment.id },
        },
        select: { id: true },
      });

      if (existing) {
        rejected.push({ lrNumber: shipment.lrNumber, reason: "Already on this manifest" });
        continue;
      }

      // The event is what moves the status to MANIFESTED; the line is a
      // snapshot of what the dispatching branch says it is sending, which
      // is what the receiving hub reconciles against.
      const event = await appendShipmentEvent(
        {
          shipmentId: shipment.id,
          eventType: "MANIFEST_ADDED",
          branchId: manifest.originBranchId,
          manifestId: manifest.id,
          idempotencyKey: `manifest:${manifest.id}:add:${shipment.id}`,
          payload: { manifest: manifest.number, packageCount: shipment.packageCount },
        },
        actor,
        tx,
      );

      if (!event.ok) {
        rejected.push({ lrNumber: shipment.lrNumber, reason: event.error });
        continue;
      }

      await tx.manifestLine.create({
        data: {
          orgId: actor.orgId,
          manifestId: manifest.id,
          shipmentId: shipment.id,
          packageCount: shipment.packageCount,
          weight: shipment.chargeableWeight,
          addedById: actor.id,
        },
      });

      added.push(shipment.lrNumber);
    }

    await recomputeTotals(manifest.id, tx);
  });

  if (added.length > 0) {
    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "Manifest",
      entityId: manifest.id,
      entityRef: manifest.number,
      branchId: manifest.originBranchId,
      after: { added },
    });
  }

  return { ok: added.length > 0 || rejected.length === 0, added, rejected };
}

export async function removeShipmentFromManifest(
  input: { manifestId: string; shipmentId: string },
  actor: SessionUser,
): Promise<{ ok: true; lrNumber: string } | { ok: false; error: string }> {
  if (!can(actor, "manifest.update")) {
    return { ok: false, error: "You do not have permission to edit manifests." };
  }

  const line = await prisma.manifestLine.findUnique({
    where: {
      manifestId_shipmentId: {
        manifestId: input.manifestId,
        shipmentId: input.shipmentId,
      },
    },
    select: {
      id: true,
      shipment: { select: { id: true, lrNumber: true } },
      manifest: {
        select: { id: true, number: true, status: true, originBranchId: true },
      },
    },
  });

  if (!line) return { ok: false, error: "That shipment is not on this manifest." };
  if (line.manifest.status !== "DRAFT") {
    return {
      ok: false,
      error: `${line.manifest.number} is ${line.manifest.status.toLowerCase()} — reopen it before removing lines.`,
    };
  }
  if (!coversBranch(actor, line.manifest.originBranchId)) {
    return { ok: false, error: "That manifest belongs to another branch." };
  }

  const event = await tenantTransaction(async (tx) => {
    const result = await appendShipmentEvent(
      {
        shipmentId: line.shipment.id,
        eventType: "MANIFEST_REMOVED",
        branchId: line.manifest.originBranchId,
        manifestId: line.manifest.id,
        idempotencyKey: `manifest:${line.manifest.id}:remove:${line.shipment.id}:${Date.now()}`,
        payload: { manifest: line.manifest.number },
      },
      actor,
      tx,
    );

    if (!result.ok) return result;

    await tx.manifestLine.delete({ where: { id: line.id } });
    await recomputeTotals(line.manifest.id, tx);
    return result;
  });

  if (!event.ok) return { ok: false, error: event.error };

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "Manifest",
    entityId: line.manifest.id,
    entityRef: line.manifest.number,
    branchId: line.manifest.originBranchId,
    before: { line: line.shipment.lrNumber },
    reason: "Shipment removed from manifest",
  });

  return { ok: true, lrNumber: line.shipment.lrNumber };
}

export async function closeManifest(
  input: { manifestId: string },
  actor: SessionUser,
): Promise<{ ok: true; number: string } | { ok: false; error: string }> {
  if (!can(actor, "manifest.close")) {
    return { ok: false, error: "You do not have permission to close manifests." };
  }

  const manifest = await prisma.manifest.findUnique({
    where: { id: input.manifestId },
    select: {
      id: true,
      number: true,
      status: true,
      originBranchId: true,
      totalShipments: true,
    },
  });

  if (!manifest) return { ok: false, error: "That manifest does not exist." };
  if (manifest.status !== "DRAFT") {
    return { ok: false, error: `${manifest.number} is already ${manifest.status.toLowerCase()}.` };
  }
  if (!coversBranch(actor, manifest.originBranchId)) {
    return { ok: false, error: "That manifest belongs to another branch." };
  }
  if (manifest.totalShipments === 0) {
    return { ok: false, error: "An empty manifest has nothing to dispatch." };
  }

  await prisma.manifest.update({
    where: { id: manifest.id },
    data: { status: "CLOSED", closedAt: new Date(), closedById: actor.id },
  });

  await recordAudit({
    user: actor,
    action: "STATUS_CHANGE",
    entity: "Manifest",
    entityId: manifest.id,
    entityRef: manifest.number,
    branchId: manifest.originBranchId,
    before: { status: "DRAFT" },
    after: { status: "CLOSED" },
    reason: "Closed for dispatch",
  });

  return { ok: true, number: manifest.number };
}

/**
 * Reopens a closed manifest.
 *
 * Only before gate-out. Once the truck has left, the paperwork is what
 * the receiving hub reconciles against, and editing it retrospectively
 * would make every shortage arguable.
 */
export async function reopenManifest(
  input: { manifestId: string; reason: string },
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "manifest.reopen")) {
    return { ok: false, error: "You do not have permission to reopen manifests." };
  }
  if (input.reason.trim().length < 4) {
    return { ok: false, error: "Say why this manifest is being reopened." };
  }

  const manifest = await prisma.manifest.findUnique({
    where: { id: input.manifestId },
    select: { id: true, number: true, status: true, originBranchId: true },
  });

  if (!manifest) return { ok: false, error: "That manifest does not exist." };
  if (manifest.status !== "CLOSED") {
    return {
      ok: false,
      error:
        manifest.status === "DRAFT"
          ? `${manifest.number} is already open.`
          : `${manifest.number} has already been dispatched. Raise an exception instead of editing it.`,
    };
  }
  if (!coversBranch(actor, manifest.originBranchId)) {
    return { ok: false, error: "That manifest belongs to another branch." };
  }

  await prisma.manifest.update({
    where: { id: manifest.id },
    data: { status: "DRAFT", closedAt: null, closedById: null },
  });

  await recordAudit({
    user: actor,
    action: "OVERRIDE",
    entity: "Manifest",
    entityId: manifest.id,
    entityRef: manifest.number,
    branchId: manifest.originBranchId,
    before: { status: "CLOSED" },
    after: { status: "DRAFT" },
    reason: input.reason.trim(),
  });

  return { ok: true };
}

/** Attaches or detaches the trip that will carry this manifest. */
export async function setManifestTrip(
  input: { manifestId: string; tripId: string | null },
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "manifest.update")) {
    return { ok: false, error: "You do not have permission to edit manifests." };
  }

  const manifest = await prisma.manifest.findUnique({
    where: { id: input.manifestId },
    select: {
      id: true,
      number: true,
      status: true,
      originBranchId: true,
      destinationBranchId: true,
    },
  });

  if (!manifest) return { ok: false, error: "That manifest does not exist." };
  if (!coversBranch(actor, manifest.originBranchId)) {
    return { ok: false, error: "That manifest belongs to another branch." };
  }
  if (manifest.status === "DISPATCHED" || manifest.status === "RECEIVED" || manifest.status === "RECONCILED") {
    return { ok: false, error: "This manifest has already left. Its vehicle cannot change here." };
  }

  if (input.tripId) {
    const trip = await prisma.trip.findUnique({
      where: { id: input.tripId },
      select: {
        id: true,
        number: true,
        status: true,
        originBranchId: true,
        ftlShipmentId: true,
      },
    });

    if (!trip) return { ok: false, error: "That trip does not exist." };
    if (trip.ftlShipmentId) {
      return {
        ok: false,
        error: `${trip.number} is a full-truck trip bound to one consignment. It carries no manifest.`,
      };
    }
    if (trip.status !== "PLANNED" && trip.status !== "VEHICLE_REPORTED" && trip.status !== "LOADING") {
      return { ok: false, error: `${trip.number} has already departed.` };
    }
    if (trip.originBranchId !== manifest.originBranchId) {
      return { ok: false, error: `${trip.number} does not start at this manifest's origin.` };
    }
  }

  await prisma.manifest.update({
    where: { id: manifest.id },
    data: { tripId: input.tripId },
  });

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "Manifest",
    entityId: manifest.id,
    entityRef: manifest.number,
    branchId: manifest.originBranchId,
    after: { tripId: input.tripId },
  });

  return { ok: true };
}

/**
 * Utilisation of the vehicle assigned to a manifest, if one is.
 *
 * Weight only for now. Volume is on file for vehicle types but not for
 * most consignments, and a utilisation figure built from mostly-absent
 * dimensions would be confidently wrong.
 */
export function manifestUtilisation(manifest: {
  totalWeight: { toString(): string };
  trip?: { vehicle?: { vehicleType?: { capacityKg: { toString(): string } | null } | null } | null } | null;
}): Utilisation {
  const capacity = manifest.trip?.vehicle?.vehicleType?.capacityKg;
  return utilisation(
    Number(manifest.totalWeight.toString()),
    capacity ? Number(capacity.toString()) : null,
  );
}
