import { prisma } from "@/lib/prisma";
import { appendShipmentEvent } from "@/lib/shipment/events";
import { recordAudit } from "@/server/services/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
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
 * The permission is the same one the state machine demands of a person
 * posting the equivalent event — but a *person*, not the pipeline. The
 * automatic path carries `source: "GPS"` and is not permission-checked at
 * all, so "the same permission the automatic path uses" was never a real
 * constraint: it read `tracking.read`, which is in `allReads` and which
 * MANAGEMENT — documented as read-only visibility of the whole network —
 * and CUSTOMER_SUPPORT both hold. Either could post an arrival against a
 * trip id and advance every consignment on it, writing custody evidence
 * and firing customer notifications from a nominally read-only account.
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

/**
 * Recording a movement by hand.
 *
 * `trip.dispatch` — the permission GATE_IN and GATE_OUT already require —
 * because typing "the truck reached Jaipur" is the same act as scanning it
 * in, and produces the same rows. Branch managers, dispatch managers and
 * operations managers hold it; the read-only roles that used to be able to
 * do this do not.
 */
export const MANUAL_MOVEMENT_PERMISSION = "trip.dispatch";

/**
 * Reporting a position and closing an alert.
 *
 * Still the tracking read, deliberately. Neither touches the consignment
 * timeline: a phoned-in position updates the live map and explicitly
 * refuses to evaluate fences (see `recordManualPosition`), and closing an
 * alert annotates an alert. Both are audited. Narrowing them to
 * `trip.dispatch` would take the phone-in away from the transport desk,
 * which is the desk that actually takes those calls — the catalogue has no
 * permission shaped like "may write tracking data but not custody", and
 * inventing one needs a seed run.
 */
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
  if (!can(actor, MANUAL_MOVEMENT_PERMISSION)) {
    return { ok: false, error: "You do not have permission to record vehicle movements." };
  }

  // Branch scope, which this path had none of. Tenant scoping is automatic
  // and was never the gap: the gap was that any branch id would do, so a
  // user at one branch could post arrivals at every other one.
  //
  // Checked against the branch the movement is being recorded at rather
  // than the trip's origin — a Jaipur trip really does arrive at Delhi,
  // and it is Delhi's people who witness it.
  if (!coversBranch(actor, input.branchId)) {
    return {
      ok: false,
      error: "You can only record movements at branches you cover.",
    };
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
      orgId: actor.orgId,
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
    // The compound key, because an upsert needs a genuinely unique `where`
    // and a device clock is only unique within a tenant now. `orgId` comes
    // from the vehicle this position is being recorded against.
    where: {
      orgId_deviceId_recordedAt: {
        orgId: vehicle.orgId,
        deviceId,
        recordedAt: occurredAt,
      },
    },
    create: {
      orgId: vehicle.orgId,
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
      orgId: vehicle.orgId,
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
        orgId: actor.orgId,
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
