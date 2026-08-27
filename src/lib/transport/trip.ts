import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { nextNumber } from "@/lib/numbering/number-series";
import { appendShipmentEvent } from "@/lib/shipment/events";
import { recordAudit } from "@/server/services/audit";

/**
 * The trip: a vehicle physically moving between two branches.
 *
 * A PTL trip carries manifests; an FTL trip binds to one consignment and
 * carries no manifest at all (BRD §A.7). Both go out through the same
 * gate, which is why gate-out lives here rather than on the manifest —
 * the gate is where the vehicle is, and the vehicle is the trip.
 *
 * Gate-out and gate-in append GATE_OUT / GATE_IN to every shipment the
 * vehicle is carrying, in one transaction. Fifty shipments leaving on one
 * truck must all be dispatched or none of them: a half-dispatched
 * manifest is a tracking board nobody trusts.
 */

export type CreateTripInput = {
  vehicleId: string;
  driverId?: string | null;
  routeId?: string | null;
  originBranchId: string;
  destinationBranchId: string;
  plannedDepartureAt?: Date | null;
  plannedArrivalAt?: Date | null;
  /** Set for a full-truck trip; the trip then carries no manifest. */
  ftlShipmentId?: string | null;
  sealNumber?: string | null;
  remarks?: string | null;
};

export type CreateTripResult =
  | { ok: true; tripId: string; number: string }
  | { ok: false; error: string; field?: string };

export async function createTrip(
  input: CreateTripInput,
  actor: SessionUser,
): Promise<CreateTripResult> {
  if (!can(actor, "trip.create")) {
    return { ok: false, error: "You do not have permission to plan trips." };
  }
  if (!coversBranch(actor, input.originBranchId)) {
    return { ok: false, error: "You cannot dispatch from that branch.", field: "originBranchId" };
  }
  if (input.originBranchId === input.destinationBranchId) {
    return {
      ok: false,
      error: "A trip runs between two different branches.",
      field: "destinationBranchId",
    };
  }

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: input.vehicleId },
    select: {
      id: true,
      registrationNumber: true,
      isActive: true,
      deletedAt: true,
      status: true,
    },
  });

  if (!vehicle || vehicle.deletedAt || !vehicle.isActive) {
    return { ok: false, error: "That vehicle is not available.", field: "vehicleId" };
  }
  if (vehicle.status === "MAINTENANCE" || vehicle.status === "INACTIVE") {
    return {
      ok: false,
      error: `${vehicle.registrationNumber} is ${vehicle.status.toLowerCase()} and cannot be assigned.`,
      field: "vehicleId",
    };
  }

  if (input.driverId) {
    const driver = await prisma.driver.findUnique({
      where: { id: input.driverId },
      select: { id: true, name: true, status: true },
    });
    if (!driver) return { ok: false, error: "That driver does not exist.", field: "driverId" };
    if (driver.status === "SUSPENDED" || driver.status === "INACTIVE") {
      return {
        ok: false,
        error: `${driver.name} is ${driver.status.toLowerCase()} and cannot be assigned.`,
        field: "driverId",
      };
    }
  }

  // ── FTL binding ───────────────────────────────────────────
  if (input.ftlShipmentId) {
    const shipment = await prisma.shipment.findUnique({
      where: { id: input.ftlShipmentId },
      select: {
        id: true,
        lrNumber: true,
        mode: true,
        currentStatus: true,
        deletedAt: true,
      },
    });

    if (!shipment || shipment.deletedAt) {
      return { ok: false, error: "That consignment does not exist.", field: "ftlShipmentId" };
    }
    if (shipment.mode !== "FTL") {
      return {
        ok: false,
        error: `${shipment.lrNumber} is a ${shipment.mode} consignment. Put it on a manifest instead of binding a whole truck to it.`,
        field: "ftlShipmentId",
      };
    }

    const alreadyBound = await prisma.trip.findFirst({
      where: {
        ftlShipmentId: shipment.id,
        status: { notIn: ["COMPLETED", "CANCELLED"] },
      },
      select: { number: true },
    });

    if (alreadyBound) {
      return {
        ok: false,
        error: `${shipment.lrNumber} is already on ${alreadyBound.number}.`,
        field: "ftlShipmentId",
      };
    }
  }

  try {
    const trip = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(
        { document: "TRIP" },
        tx as unknown as Parameters<typeof nextNumber>[1],
      );

      return tx.trip.create({
        data: {
          orgId: actor.orgId,
          number,
          status: "PLANNED",
          vehicleId: input.vehicleId,
          driverId: input.driverId ?? undefined,
          routeId: input.routeId ?? undefined,
          originBranchId: input.originBranchId,
          destinationBranchId: input.destinationBranchId,
          plannedDepartureAt: input.plannedDepartureAt ?? undefined,
          plannedArrivalAt: input.plannedArrivalAt ?? undefined,
          ftlShipmentId: input.ftlShipmentId ?? undefined,
          sealNumber: input.sealNumber ?? undefined,
          remarks: input.remarks ?? undefined,
          createdById: actor.id,
        },
        select: { id: true, number: true },
      });
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Trip",
      entityId: trip.id,
      entityRef: trip.number,
      branchId: input.originBranchId,
      after: {
        vehicleId: input.vehicleId,
        driverId: input.driverId ?? null,
        ftlShipmentId: input.ftlShipmentId ?? null,
      },
    });

    return { ok: true, tripId: trip.id, number: trip.number };
  } catch (error) {
    console.error("[trip] create failed", error);
    return { ok: false, error: "Could not plan the trip. Nothing was saved." };
  }
}

/** Every shipment a trip is carrying — manifest lines, or the FTL binding. */
async function shipmentsOnTrip(
  tripId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Array<{ id: string; lrNumber: string; manifestId: string | null }>> {
  const trip = await client.trip.findUnique({
    where: { id: tripId },
    select: {
      ftlShipmentId: true,
      ftlShipment: { select: { id: true, lrNumber: true } },
      manifests: {
        where: { status: { notIn: ["CANCELLED"] } },
        select: {
          id: true,
          lines: { select: { shipment: { select: { id: true, lrNumber: true } } } },
        },
      },
    },
  });

  if (!trip) return [];

  if (trip.ftlShipment) {
    return [{ id: trip.ftlShipment.id, lrNumber: trip.ftlShipment.lrNumber, manifestId: null }];
  }

  return trip.manifests.flatMap((manifest) =>
    manifest.lines.map((line) => ({
      id: line.shipment.id,
      lrNumber: line.shipment.lrNumber,
      manifestId: manifest.id,
    })),
  );
}

export type GateResult =
  | {
      ok: true;
      number: string;
      moved: number;
      /** LR numbers whose event was refused, with the reason. */
      refused: Array<{ lrNumber: string; reason: string }>;
    }
  | { ok: false; error: string };

export type GateOutInput = {
  tripId: string;
  odometerKm?: number | null;
  sealNumber?: string | null;
  occurredAt?: Date;
  remarks?: string | null;
};

/**
 * Gate-out: the truck leaves.
 *
 * Refuses while a loading sheet is still open, because an open sheet
 * means the floor has not yet agreed that what is scanned is what is
 * loaded — which is exactly the disagreement this module exists to stop
 * leaving the yard.
 */
export async function gateOut(
  input: GateOutInput,
  actor: SessionUser,
): Promise<GateResult> {
  if (!can(actor, "trip.dispatch")) {
    return { ok: false, error: "You do not have permission to dispatch trips." };
  }

  const trip = await prisma.trip.findUnique({
    where: { id: input.tripId },
    select: {
      id: true,
      number: true,
      status: true,
      originBranchId: true,
      vehicleId: true,
      ftlShipmentId: true,
      sealNumber: true,
      manifests: { select: { id: true, number: true, status: true } },
    },
  });

  if (!trip) return { ok: false, error: "That trip does not exist." };
  if (!coversBranch(actor, trip.originBranchId)) {
    return { ok: false, error: "That trip departs from another branch." };
  }
  if (trip.status !== "PLANNED" && trip.status !== "VEHICLE_REPORTED" && trip.status !== "LOADING") {
    return { ok: false, error: `${trip.number} has already been dispatched.` };
  }

  const openSheet = await prisma.loadingSheet.findFirst({
    where: { tripId: trip.id, status: "OPEN" },
    select: { id: true },
  });

  if (openSheet) {
    return {
      ok: false,
      error: "Close the loading sheet first — the floor has not confirmed the load.",
    };
  }

  const draftManifests = trip.manifests.filter((m) => m.status === "DRAFT");
  if (draftManifests.length > 0) {
    return {
      ok: false,
      error: `${draftManifests.map((m) => m.number).join(", ")} ${draftManifests.length === 1 ? "is" : "are"} still in draft. Close for dispatch first.`,
    };
  }

  const carrying = await shipmentsOnTrip(trip.id);
  if (carrying.length === 0) {
    return { ok: false, error: "There is nothing on this trip to dispatch." };
  }

  const occurredAt = input.occurredAt ?? new Date();
  const refused: Array<{ lrNumber: string; reason: string }> = [];
  let moved = 0;

  await prisma.$transaction(async (tx) => {
    for (const shipment of carrying) {
      const event = await appendShipmentEvent(
        {
          shipmentId: shipment.id,
          eventType: "GATE_OUT",
          occurredAt,
          branchId: trip.originBranchId,
          vehicleId: trip.vehicleId,
          tripId: trip.id,
          manifestId: shipment.manifestId,
          idempotencyKey: `trip:${trip.id}:gateout:${shipment.id}`,
          payload: {
            trip: trip.number,
            sealNumber: input.sealNumber ?? trip.sealNumber ?? null,
          },
        },
        actor,
        tx,
      );

      if (event.ok) moved += 1;
      else refused.push({ lrNumber: shipment.lrNumber, reason: event.error });
    }

    await tx.trip.update({
      where: { id: trip.id },
      data: {
        status: "DISPATCHED",
        actualDepartureAt: occurredAt,
        startOdometerKm: input.odometerKm ?? undefined,
        sealNumber: input.sealNumber ?? undefined,
        remarks: input.remarks ?? undefined,
      },
    });

    if (trip.manifests.length > 0) {
      await tx.manifest.updateMany({
        where: { tripId: trip.id, status: "CLOSED" },
        data: { status: "DISPATCHED", dispatchedAt: occurredAt },
      });
    }

    await tx.tripEvent.create({
      data: {
        tripId: trip.id,
        eventType: "GATE_OUT",
        occurredAt,
        branchId: trip.originBranchId,
        userId: actor.id,
        odometerKm: input.odometerKm ?? undefined,
        remarks: input.remarks ?? undefined,
        payload: {
          shipments: carrying.length,
          dispatched: moved,
          sealNumber: input.sealNumber ?? trip.sealNumber ?? null,
        },
      },
    });

    // The vehicle is out. Its status is fleet's to own, but leaving it
    // AVAILABLE while it is on the highway would let a dispatcher assign
    // the same truck twice.
    await tx.vehicle.update({
      where: { id: trip.vehicleId },
      data: { status: "DISPATCHED", currentOdometerKm: input.odometerKm ?? undefined },
    });

    await tx.vehicleStatusLog.create({
      data: {
        vehicleId: trip.vehicleId,
        toStatus: "DISPATCHED",
        tripId: trip.id,
        branchId: trip.originBranchId,
        userId: actor.id,
        remarks: `Gate-out on ${trip.number}`,
      },
    });
  });

  await recordAudit({
    user: actor,
    action: "STATUS_CHANGE",
    entity: "Trip",
    entityId: trip.id,
    entityRef: trip.number,
    branchId: trip.originBranchId,
    before: { status: trip.status },
    after: {
      status: "DISPATCHED",
      shipmentsDispatched: moved,
      odometerKm: input.odometerKm ?? null,
      sealNumber: input.sealNumber ?? trip.sealNumber ?? null,
    },
    reason: "Gate-out",
  });

  return { ok: true, number: trip.number, moved, refused };
}

export type GateInInput = {
  tripId: string;
  branchId: string;
  odometerKm?: number | null;
  sealIntact?: boolean;
  occurredAt?: Date;
  remarks?: string | null;
};

/** Gate-in: the truck arrives. Its shipments become ARRIVED_AT_HUB. */
export async function gateIn(
  input: GateInInput,
  actor: SessionUser,
): Promise<GateResult> {
  if (!can(actor, "trip.dispatch")) {
    return { ok: false, error: "You do not have permission to receive trips." };
  }
  if (!coversBranch(actor, input.branchId)) {
    return { ok: false, error: "You cannot receive a vehicle at that branch." };
  }

  const trip = await prisma.trip.findUnique({
    where: { id: input.tripId },
    select: {
      id: true,
      number: true,
      status: true,
      vehicleId: true,
      startOdometerKm: true,
      destinationBranchId: true,
    },
  });

  if (!trip) return { ok: false, error: "That trip does not exist." };
  if (trip.status !== "DISPATCHED" && trip.status !== "IN_TRANSIT") {
    return {
      ok: false,
      error:
        trip.status === "ARRIVED" || trip.status === "UNLOADING"
          ? `${trip.number} has already arrived.`
          : `${trip.number} has not been dispatched.`,
    };
  }

  const occurredAt = input.occurredAt ?? new Date();
  const carrying = await shipmentsOnTrip(trip.id);
  const refused: Array<{ lrNumber: string; reason: string }> = [];
  let moved = 0;

  const distanceKm =
    input.odometerKm && trip.startOdometerKm && input.odometerKm > trip.startOdometerKm
      ? new Decimal(input.odometerKm - trip.startOdometerKm).toFixed(2)
      : undefined;

  await prisma.$transaction(async (tx) => {
    for (const shipment of carrying) {
      const event = await appendShipmentEvent(
        {
          shipmentId: shipment.id,
          eventType: "GATE_IN",
          occurredAt,
          branchId: input.branchId,
          vehicleId: trip.vehicleId,
          tripId: trip.id,
          manifestId: shipment.manifestId,
          idempotencyKey: `trip:${trip.id}:gatein:${input.branchId}:${shipment.id}`,
          payload: { trip: trip.number, sealIntact: input.sealIntact ?? null },
        },
        actor,
        tx,
      );

      if (event.ok) moved += 1;
      else refused.push({ lrNumber: shipment.lrNumber, reason: event.error });
    }

    await tx.trip.update({
      where: { id: trip.id },
      data: {
        status: "ARRIVED",
        actualArrivalAt: occurredAt,
        endOdometerKm: input.odometerKm ?? undefined,
        distanceKm,
        sealBrokenBy: input.sealIntact === false ? actor.id : undefined,
        remarks: input.remarks ?? undefined,
      },
    });

    await tx.tripEvent.create({
      data: {
        tripId: trip.id,
        eventType: "GATE_IN",
        occurredAt,
        branchId: input.branchId,
        userId: actor.id,
        odometerKm: input.odometerKm ?? undefined,
        remarks: input.remarks ?? undefined,
        payload: {
          shipments: carrying.length,
          arrived: moved,
          sealIntact: input.sealIntact ?? null,
        },
      },
    });

    await tx.vehicle.update({
      where: { id: trip.vehicleId },
      data: { status: "AT_HUB", currentOdometerKm: input.odometerKm ?? undefined },
    });

    await tx.vehicleStatusLog.create({
      data: {
        vehicleId: trip.vehicleId,
        toStatus: "AT_HUB",
        tripId: trip.id,
        branchId: input.branchId,
        userId: actor.id,
        remarks: `Gate-in on ${trip.number}`,
      },
    });
  });

  await recordAudit({
    user: actor,
    action: "STATUS_CHANGE",
    entity: "Trip",
    entityId: trip.id,
    entityRef: trip.number,
    branchId: input.branchId,
    before: { status: trip.status },
    after: {
      status: "ARRIVED",
      shipmentsArrived: moved,
      odometerKm: input.odometerKm ?? null,
      sealIntact: input.sealIntact ?? null,
    },
    reason: "Gate-in",
  });

  return { ok: true, number: trip.number, moved, refused };
}

export async function closeTrip(
  input: { tripId: string; remarks?: string | null },
  actor: SessionUser,
): Promise<{ ok: true; number: string } | { ok: false; error: string }> {
  if (!can(actor, "trip.close")) {
    return { ok: false, error: "You do not have permission to close trips." };
  }

  const trip = await prisma.trip.findUnique({
    where: { id: input.tripId },
    select: {
      id: true,
      number: true,
      status: true,
      vehicleId: true,
      destinationBranchId: true,
    },
  });

  if (!trip) return { ok: false, error: "That trip does not exist." };
  if (trip.status === "COMPLETED") return { ok: false, error: `${trip.number} is already closed.` };
  if (trip.status !== "ARRIVED" && trip.status !== "UNLOADING") {
    return { ok: false, error: `${trip.number} has not arrived yet.` };
  }

  const openReceipts = await prisma.inboundReceipt.count({
    where: { tripId: trip.id, status: "OPEN" },
  });

  if (openReceipts > 0) {
    return {
      ok: false,
      error: "An inbound receipt against this trip is still open. Close it so shortages are raised before the trip is settled.",
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.trip.update({
      where: { id: trip.id },
      data: {
        status: "COMPLETED",
        closedAt: new Date(),
        remarks: input.remarks ?? undefined,
      },
    });

    await tx.tripEvent.create({
      data: {
        tripId: trip.id,
        eventType: "CLOSED",
        branchId: trip.destinationBranchId,
        userId: actor.id,
        remarks: input.remarks ?? undefined,
      },
    });

    await tx.vehicle.update({
      where: { id: trip.vehicleId },
      data: { status: "AVAILABLE" },
    });

    await tx.vehicleStatusLog.create({
      data: {
        vehicleId: trip.vehicleId,
        toStatus: "AVAILABLE",
        tripId: trip.id,
        branchId: trip.destinationBranchId,
        userId: actor.id,
        remarks: `${trip.number} closed`,
      },
    });
  });

  await recordAudit({
    user: actor,
    action: "STATUS_CHANGE",
    entity: "Trip",
    entityId: trip.id,
    entityRef: trip.number,
    branchId: trip.destinationBranchId,
    before: { status: trip.status },
    after: { status: "COMPLETED" },
    reason: "Trip closed",
  });

  return { ok: true, number: trip.number };
}

/** Marks the vehicle as reported at the gate, ready to load. */
export async function markVehicleReported(
  input: { tripId: string },
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "trip.dispatch")) {
    return { ok: false, error: "You do not have permission to update trips." };
  }

  const trip = await prisma.trip.findUnique({
    where: { id: input.tripId },
    select: { id: true, number: true, status: true, originBranchId: true, vehicleId: true },
  });

  if (!trip) return { ok: false, error: "That trip does not exist." };
  if (trip.status !== "PLANNED") {
    return { ok: false, error: `${trip.number} is already ${trip.status.toLowerCase()}.` };
  }
  if (!coversBranch(actor, trip.originBranchId)) {
    return { ok: false, error: "That trip departs from another branch." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.trip.update({
      where: { id: trip.id },
      data: { status: "VEHICLE_REPORTED" },
    });
    await tx.tripEvent.create({
      data: {
        tripId: trip.id,
        eventType: "VEHICLE_REPORTED",
        branchId: trip.originBranchId,
        userId: actor.id,
      },
    });
    await tx.vehicle.update({
      where: { id: trip.vehicleId },
      data: { status: "ASSIGNED" },
    });
  });

  await recordAudit({
    user: actor,
    action: "STATUS_CHANGE",
    entity: "Trip",
    entityId: trip.id,
    entityRef: trip.number,
    branchId: trip.originBranchId,
    before: { status: "PLANNED" },
    after: { status: "VEHICLE_REPORTED" },
  });

  return { ok: true };
}
