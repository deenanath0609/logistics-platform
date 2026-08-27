import { prisma } from "@/lib/prisma";
import { appendShipmentEvent } from "@/lib/shipment/events";
import { recordAudit } from "@/server/services/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import type { Prisma, ShipmentEventType } from "@/generated/prisma/client";
import { haversineMetres } from "./geo";
import { activeTripForVehicle, loadBranchPoints, shipmentsOnTrip } from "./context";

/**
 * The manual equivalent of everything the pipeline does automatically.
 *
 * This file is not a fallback bolted on at the end; it is the reason the
 * rest of the phase is safe to ship. Attached and vendor vehicles are a
 * large fraction of any Indian fleet and they will not all have working
 * telematics — devices fail, get unplugged to charge a phone, or were never
 * fitted because the truck is on a three-month contract. A system that only
 * works with perfect telematics does not survive contact with a mixed
 * fleet (docs/BRD.html §A.9).
 *
 * Three rules hold this together.
 *
 * The permission is the same one the automatic path uses. A geofence
 * arrival is a `GEOFENCE_ENTER` event, and the state machine says that
 * event needs `tracking.read`; a supervisor typing the same arrival needs
 * exactly that and no more. Requiring something stronger for the manual
 * route would push branches into asking the transport desk to do it, which
 * is how arrival data stops being entered at all.
 *
 * The event is the same event, through the same function. Nothing here
 * touches `currentStatus`; `appendShipmentEvent` validates the transition
 * and projects the status exactly as it does for a fence crossing.
 *
 * The source is different, and that is the point. `ShipmentEvent.source` is
 * `WEB` here and `GPS` there, so a report can answer "how much of our
 * arrival data is automatic?" — which is the number that says whether the
 * telematics contract is worth renewing.
 */

export type ManualResult =
  | { ok: true; moved: number; refused: Array<{ lrNumber: string; reason: string }> }
  | { ok: false; error: string };

/** The permission the automatic path runs under, applied to the manual one. */
export const MANUAL_TRACKING_PERMISSION = "tracking.read";

// ────────────────────────────────────────────────────────────
// Arrival and departure
// ────────────────────────────────────────────────────────────

export type ManualMovementInput = {
  tripId: string;
  branchId: string;
  occurredAt?: Date;
  latitude?: number | null;
  longitude?: number | null;
  remarks?: string | null;
};

async function recordMovement(
  input: ManualMovementInput,
  actor: SessionUser,
  direction: "ARRIVAL" | "DEPARTURE",
): Promise<ManualResult> {
  if (!can(actor, MANUAL_TRACKING_PERMISSION)) {
    return { ok: false, error: "You do not have permission to record vehicle movements." };
  }

  const trip = await prisma.trip.findUnique({
    where: { id: input.tripId },
    select: {
      id: true,
      number: true,
      status: true,
      vehicleId: true,
      originBranchId: true,
      vehicle: { select: { registrationNumber: true } },
    },
  });
  if (!trip) return { ok: false, error: "That trip does not exist." };

  const branch = await prisma.branch.findUnique({
    where: { id: input.branchId },
    select: { id: true, code: true, name: true },
  });
  if (!branch) return { ok: false, error: "That branch does not exist." };

  const eventType: ShipmentEventType =
    direction === "ARRIVAL" ? "GEOFENCE_ENTER" : "GEOFENCE_EXIT";
  const occurredAt = input.occurredAt ?? new Date();

  const carrying = await shipmentsOnTrip(trip.id);
  if (carrying.length === 0) {
    return { ok: false, error: `${trip.number} is not carrying anything.` };
  }

  const refused: Array<{ lrNumber: string; reason: string }> = [];
  let moved = 0;

  for (const shipment of carrying) {
    const result = await appendShipmentEvent(
      {
        shipmentId: shipment.id,
        eventType,
        occurredAt,
        branchId: branch.id,
        vehicleId: trip.vehicleId,
        tripId: trip.id,
        manifestId: shipment.manifestId,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        remarks: input.remarks ?? null,
        // Not GPS. This is the field that lets a report separate the
        // automatic arrivals from the typed ones.
        source: "WEB",
        idempotencyKey: `manual:${direction.toLowerCase()}:${trip.id}:${branch.id}:${shipment.id}:${Math.floor(
          occurredAt.getTime() / 60_000,
        )}`,
        payload: {
          trip: trip.number,
          branch: branch.code,
          automatic: false,
          enteredBy: actor.name,
        } satisfies Prisma.InputJsonValue,
      },
      actor,
    );

    if (result.ok && !result.duplicate) moved++;
    else if (!result.ok) refused.push({ lrNumber: shipment.lrNumber, reason: result.error });
  }

  await prisma.tripEvent.create({
    data: {
      tripId: trip.id,
      eventType: direction === "ARRIVAL" ? "MANUAL_ARRIVAL" : "MANUAL_DEPARTURE",
      occurredAt,
      branchId: branch.id,
      userId: actor.id,
      latitude: input.latitude ?? undefined,
      longitude: input.longitude ?? undefined,
      remarks: input.remarks ?? undefined,
      payload: { shipments: carrying.length, moved, source: "manual" },
    },
  });

  await recordAudit({
    user: actor,
    action: "STATUS_CHANGE",
    entity: "Trip",
    entityId: trip.id,
    entityRef: trip.number,
    branchId: branch.id,
    after: {
      direction,
      branch: branch.code,
      vehicle: trip.vehicle.registrationNumber,
      occurredAt: occurredAt.toISOString(),
      shipmentsAffected: moved,
      source: "manual",
    },
    reason: `Manual ${direction.toLowerCase()} recorded — no usable GPS`,
  });

  return { ok: true, moved, refused };
}

/** What a geofence ENTER would have written, typed by a human instead. */
export function recordManualArrival(
  input: ManualMovementInput,
  actor: SessionUser,
): Promise<ManualResult> {
  return recordMovement(input, actor, "ARRIVAL");
}

/** What a geofence EXIT would have written, typed by a human instead. */
export function recordManualDeparture(
  input: ManualMovementInput,
  actor: SessionUser,
): Promise<ManualResult> {
  return recordMovement(input, actor, "DEPARTURE");
}

// ────────────────────────────────────────────────────────────
// Position report
// ────────────────────────────────────────────────────────────

export type ManualPositionInput = {
  vehicleId: string;
  latitude: number;
  longitude: number;
  occurredAt?: Date;
  remarks?: string | null;
};

export type PositionResult =
  | { ok: true; nearestBranchCode: string | null; distanceKm: number | null }
  | { ok: false; error: string };

/**
 * "Driver says he is just past Behror."
 *
 * A phoned-in position for a truck with no device. It updates the live map
 * and nothing else: no fence evaluation, no arrival propagation, no ETA
 * snapshot. That restraint is deliberate — a single coordinate typed from a
 * phone call has none of the debounce evidence a fence crossing needs, and
 * quietly firing arrivals from it would put the manual path outside every
 * safeguard the automatic one has.
 *
 * It is written to `GpsPing` as well as `VehicleLocation`, with a `manual`
 * provider, so trip replay shows it in the trail with its provenance
 * attached rather than as a gap.
 */
export async function recordManualPosition(
  input: ManualPositionInput,
  actor: SessionUser,
): Promise<PositionResult> {
  if (!can(actor, MANUAL_TRACKING_PERMISSION)) {
    return { ok: false, error: "You do not have permission to record vehicle positions." };
  }

  if (
    !Number.isFinite(input.latitude) ||
    !Number.isFinite(input.longitude) ||
    Math.abs(input.latitude) > 90 ||
    Math.abs(input.longitude) > 180
  ) {
    return { ok: false, error: "Those coordinates are not on the planet." };
  }

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: input.vehicleId },
    select: { id: true, orgId: true, registrationNumber: true, gpsDeviceId: true },
  });
  if (!vehicle) return { ok: false, error: "That vehicle does not exist." };

  const occurredAt = input.occurredAt ?? new Date();
  const point = { lat: input.latitude, lng: input.longitude };

  const branches = await loadBranchPoints();
  let nearestBranchId: string | null = null;
  let nearestCode: string | null = null;
  let nearestKm: number | null = null;
  for (const branch of branches) {
    const km = haversineMetres(point, branch.point) / 1000;
    if (nearestKm === null || km < nearestKm) {
      nearestKm = km;
      nearestBranchId = branch.id;
      nearestCode = branch.code;
    }
  }

  const deviceId = vehicle.gpsDeviceId ?? `manual:${vehicle.id}`;
  const trip = await activeTripForVehicle(vehicle.id);

  await prisma.gpsPing.upsert({
    where: { deviceId_recordedAt: { deviceId, recordedAt: occurredAt } },
    create: {
      deviceId,
      vehicleId: vehicle.id,
      latitude: input.latitude,
      longitude: input.longitude,
      recordedAt: occurredAt,
      provider: "manual",
      providerRef: `user:${actor.id}`,
    },
    update: {
      latitude: input.latitude,
      longitude: input.longitude,
      provider: "manual",
      providerRef: `user:${actor.id}`,
    },
  });

  await prisma.vehicleLocation.upsert({
    where: { vehicleId: vehicle.id },
    create: {
      vehicleId: vehicle.id,
      deviceId,
      latitude: input.latitude,
      longitude: input.longitude,
      recordedAt: occurredAt,
      nearestBranchId: nearestBranchId ?? undefined,
      distanceToNearestKm: nearestKm === null ? undefined : nearestKm.toFixed(2),
    },
    update: {
      latitude: input.latitude,
      longitude: input.longitude,
      recordedAt: occurredAt,
      // The fence state is deliberately left alone. A typed position is not
      // evidence of a crossing, and overwriting the debounce with it would
      // let one phone call fire an arrival.
      nearestBranchId: nearestBranchId ?? undefined,
      distanceToNearestKm: nearestKm === null ? undefined : nearestKm.toFixed(2),
    },
  });

  if (trip) {
    await prisma.tripEvent.create({
      data: {
        tripId: trip.id,
        eventType: "MANUAL_POSITION",
        occurredAt,
        userId: actor.id,
        latitude: input.latitude,
        longitude: input.longitude,
        remarks: input.remarks ?? undefined,
        payload: { nearestBranch: nearestCode, source: "manual" },
      },
    });
  }

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "VehicleLocation",
    entityId: vehicle.id,
    entityRef: vehicle.registrationNumber,
    after: {
      latitude: input.latitude,
      longitude: input.longitude,
      occurredAt: occurredAt.toISOString(),
      nearestBranch: nearestCode,
      source: "manual",
      remarks: input.remarks ?? null,
    },
    reason: "Position reported by hand",
  });

  return {
    ok: true,
    nearestBranchCode: nearestCode,
    distanceKm: nearestKm === null ? null : Math.round(nearestKm * 100) / 100,
  };
}

// ────────────────────────────────────────────────────────────
// Alerts
// ────────────────────────────────────────────────────────────

/** Closes an alert by hand — the driver rang in, the stop was a puncture. */
export async function resolveAlert(
  alertId: string,
  note: string | null,
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, MANUAL_TRACKING_PERMISSION)) {
    return { ok: false, error: "You do not have permission to close tracking alerts." };
  }

  const alert = await prisma.trackingAlert.findUnique({
    where: { id: alertId },
    select: { id: true, kind: true, vehicleId: true, resolvedAt: true, details: true },
  });
  if (!alert) return { ok: false, error: "That alert does not exist." };
  if (alert.resolvedAt) return { ok: true };

  const details =
    alert.details && typeof alert.details === "object" && !Array.isArray(alert.details)
      ? (alert.details as Record<string, unknown>)
      : {};

  await prisma.trackingAlert.update({
    where: { id: alertId },
    data: {
      resolvedAt: new Date(),
      details: { ...details, resolvedBy: actor.name, resolutionNote: note ?? null },
    },
  });

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "TrackingAlert",
    entityId: alertId,
    entityRef: alert.kind,
    after: { resolved: true, note: note ?? null },
    reason: "Closed by hand",
  });

  return { ok: true };
}
