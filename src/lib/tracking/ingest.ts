import { prisma } from "@/lib/prisma";
import { requireTenantOrgId } from "@/lib/tenant";
import { appendShipmentEvent } from "@/lib/shipment/events";
import type { Prisma, ShipmentEventType } from "@/generated/prisma/client";
import { haversineMetres, type LatLng } from "./geo";
import {
  EMPTY_FENCE_STATE,
  evaluateFences,
  type FenceDefinition,
  type FenceState,
  type FenceTransition,
} from "./geofence";
import {
  activeTripForVehicle,
  loadBranchPoints,
  loadFences,
  shipmentsOnTrip,
  type TripContext,
} from "./context";
import { recordSystemAudit } from "./audit";
import { runDerivations } from "./monitor";
import type { NormalizedPing } from "./providers/types";

/**
 * The ingestion pipeline (docs/BRD.html §B.6).
 *
 *   ingest → dedupe → persist → upsert location → evaluate fences →
 *   debounce → emit fence event → propagate to shipments → derive
 *
 * Two properties matter more than anything else here.
 *
 * The first is idempotency. Telematics vendors resend, webhooks retry, and
 * two server processes will poll the same devices at the same second. The
 * unique index on `(deviceId, recordedAt)` is the guarantee, and the
 * derived idempotency keys on the shipment events are the second line:
 * running this function twice over the same batch produces one arrival,
 * not two, at every stage.
 *
 * The second is that nothing here writes `Shipment.currentStatus`. A
 * geofence crossing is an event like any other and goes through
 * `appendShipmentEvent`, which validates the transition, appends to the
 * log, projects the status, and emits to the outbox in one transaction.
 * The pipeline's authority ends at deciding that a truck arrived; whether
 * that means anything for a given consignment is the state machine's
 * business, and a consignment already delivered simply refuses the event.
 */

export type IngestSummary = {
  received: number;
  accepted: number;
  duplicates: number;
  /** Pings for devices no vehicle claims. */
  unknownDevices: number;
  /** Fixes older than the vehicle's current position; stored, not applied. */
  outOfOrder: number;
  fenceEvents: number;
  shipmentEvents: number;
  alerts: number;
  etaSnapshots: number;
};

const EMPTY_SUMMARY: IngestSummary = {
  received: 0,
  accepted: 0,
  duplicates: 0,
  unknownDevices: 0,
  outOfOrder: 0,
  fenceEvents: 0,
  shipmentEvents: 0,
  alerts: 0,
  etaSnapshots: 0,
};

type VehicleRef = {
  id: string;
  registrationNumber: string;
  orgId: string;
};

/**
 * Distance from the origin at which a trip with no origin fence is
 * accepted as having left. Without this, a lane whose origin branch has no
 * geofence would leave every consignment sitting at DISPATCHED until it
 * reached the far end.
 */
const DEPARTURE_DISTANCE_METRES = 2_000;

export async function ingestPings(
  pings: readonly NormalizedPing[],
): Promise<IngestSummary> {
  if (pings.length === 0) return { ...EMPTY_SUMMARY };

  const summary: IngestSummary = { ...EMPTY_SUMMARY, received: pings.length };

  const deviceIds = [...new Set(pings.map((p) => p.deviceId))];
  const [vehicles, fences, branches] = await Promise.all([
    resolveVehicles(deviceIds),
    loadFences(),
    loadBranchPoints(),
  ]);

  // Grouped by device and ordered by device clock, because the debounce is
  // a running count and only means anything applied in sequence.
  const byDevice = new Map<string, NormalizedPing[]>();
  for (const ping of pings) {
    const list = byDevice.get(ping.deviceId) ?? [];
    list.push(ping);
    byDevice.set(ping.deviceId, list);
  }

  for (const [deviceId, batch] of byDevice) {
    batch.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

    const vehicle = vehicles.get(deviceId);
    if (!vehicle) {
      // Stored anyway: a device reporting before anybody has attached it to
      // a vehicle is a fitment in progress, and the fitter needs to see the
      // fixes arriving. It simply drives nothing.
      summary.unknownDevices += batch.length;
      for (const ping of batch) {
        const stored = await persistPing(ping, null);
        if (stored) summary.accepted++;
        else summary.duplicates++;
      }
      continue;
    }

    try {
      const result = await ingestForVehicle(vehicle, batch, fences, branches);
      summary.accepted += result.accepted;
      summary.duplicates += result.duplicates;
      summary.outOfOrder += result.outOfOrder;
      summary.fenceEvents += result.fenceEvents;
      summary.shipmentEvents += result.shipmentEvents;
      summary.alerts += result.alerts;
      summary.etaSnapshots += result.etaSnapshots;
    } catch (error) {
      // One vehicle's bad data must not stop the poll for the rest of the
      // fleet. The batch is lost; the next one is thirty seconds away.
      console.error(`[tracking] ingest failed for ${vehicle.registrationNumber}`, error);
    }
  }

  return summary;
}

// ────────────────────────────────────────────────────────────
// Per vehicle
// ────────────────────────────────────────────────────────────

async function ingestForVehicle(
  vehicle: VehicleRef,
  batch: NormalizedPing[],
  fences: FenceDefinition[],
  branches: Awaited<ReturnType<typeof loadBranchPoints>>,
): Promise<Omit<IngestSummary, "received" | "unknownDevices">> {
  let accepted = 0;
  let duplicates = 0;
  let outOfOrder = 0;

  const location = await prisma.vehicleLocation.findUnique({
    where: { vehicleId: vehicle.id },
    select: {
      recordedAt: true,
      insideGeofenceIds: true,
      pendingFenceId: true,
      pendingCount: true,
    },
  });

  const previouslyAt = location?.recordedAt ?? null;
  const fresh: NormalizedPing[] = [];

  for (const ping of batch) {
    const stored = await persistPing(ping, vehicle.id);
    if (!stored) {
      duplicates++;
      continue;
    }
    accepted++;

    // A device flushing a buffer after an hour in a tunnel delivers real
    // history, which belongs in the ping table and the trip replay. It must
    // not move the live position backwards, and it must not re-run a fence
    // debounce that has already moved past it.
    if (previouslyAt && ping.recordedAt <= previouslyAt) {
      outOfOrder++;
      continue;
    }
    fresh.push(ping);
  }

  if (fresh.length === 0) {
    return {
      accepted,
      duplicates,
      outOfOrder,
      fenceEvents: 0,
      shipmentEvents: 0,
      alerts: 0,
      etaSnapshots: 0,
    };
  }

  // ── Evaluate and debounce, one fix at a time ──────────────
  let state: FenceState = location
    ? {
        insideGeofenceIds: location.insideGeofenceIds,
        pendingFenceId: location.pendingFenceId,
        pendingCount: location.pendingCount,
      }
    : EMPTY_FENCE_STATE;

  const confirmed: Array<{ transition: FenceTransition; ping: NormalizedPing }> = [];

  for (const ping of fresh) {
    const evaluation = evaluateFences({
      point: { lat: ping.lat, lng: ping.lng },
      fences,
      state,
    });
    state = evaluation.state;
    for (const transition of evaluation.transitions) {
      confirmed.push({ transition, ping });
    }
  }

  const latest = fresh[fresh.length - 1];
  const point: LatLng = { lat: latest.lat, lng: latest.lng };

  // ── Nearest known place, for a human-readable "last seen" ──
  let nearestBranchId: string | null = null;
  let nearestKm: number | null = null;
  for (const branch of branches) {
    const metres = haversineMetres(point, branch.point);
    if (nearestKm === null || metres / 1000 < nearestKm) {
      nearestKm = metres / 1000;
      nearestBranchId = branch.id;
    }
  }

  await prisma.vehicleLocation.upsert({
    where: { vehicleId: vehicle.id },
    create: {
      // The vehicle already resolved above owns this position; taking the
      // tenant from anywhere else would let a device fitted to one carrier's
      // truck move a row belonging to another's.
      orgId: vehicle.orgId,
      vehicleId: vehicle.id,
      deviceId: latest.deviceId,
      latitude: latest.lat,
      longitude: latest.lng,
      speedKmph: latest.speedKmph ?? undefined,
      heading: latest.heading ?? undefined,
      ignition: latest.ignition ?? undefined,
      recordedAt: latest.recordedAt,
      insideGeofenceIds: state.insideGeofenceIds,
      pendingFenceId: state.pendingFenceId,
      pendingCount: state.pendingCount,
      nearestBranchId: nearestBranchId ?? undefined,
      distanceToNearestKm: nearestKm === null ? undefined : nearestKm.toFixed(2),
    },
    update: {
      deviceId: latest.deviceId,
      latitude: latest.lat,
      longitude: latest.lng,
      speedKmph: latest.speedKmph ?? undefined,
      heading: latest.heading ?? undefined,
      ignition: latest.ignition ?? undefined,
      recordedAt: latest.recordedAt,
      insideGeofenceIds: state.insideGeofenceIds,
      pendingFenceId: state.pendingFenceId,
      pendingCount: state.pendingCount,
      nearestBranchId: nearestBranchId ?? undefined,
      distanceToNearestKm: nearestKm === null ? undefined : nearestKm.toFixed(2),
    },
  });

  const trip = await activeTripForVehicle(vehicle.id);

  // ── Emit and propagate ────────────────────────────────────
  let fenceEvents = 0;
  let shipmentEvents = 0;

  for (const { transition, ping } of confirmed) {
    const propagated = await emitFenceEvent(vehicle, trip, transition, ping);
    fenceEvents++;
    shipmentEvents += propagated;
  }

  // ── Departure ─────────────────────────────────────────────
  // A trip stays DISPATCHED from gate-out until something observes it
  // leaving. Two things can: an exit through the origin fence, or — for the
  // many branches that have no fence — simply being a long way from the
  // origin. Either way the trip becomes IN_TRANSIT, which is also what
  // stops a later fence entry at the origin being read as an arrival.
  if (trip && trip.status === "DISPATCHED") {
    const leftThroughTheFence = confirmed.some(
      ({ transition }) =>
        transition.direction === "EXIT" && transition.branchId === trip.originBranchId,
    );

    if (leftThroughTheFence) {
      await markTripInTransit(trip);
    } else if (confirmed.length === 0) {
      shipmentEvents += await markInTransitIfMoved(trip, point, latest, branches);
    }
  }

  // ── Derive ────────────────────────────────────────────────
  const derived = await runDerivations({
    vehicle,
    trip,
    latest,
    insideFence: state.insideGeofenceIds.length > 0,
  });

  return {
    accepted,
    duplicates,
    outOfOrder,
    fenceEvents,
    shipmentEvents,
    alerts: derived.alerts,
    etaSnapshots: derived.etaSnapshots,
  };
}

// ────────────────────────────────────────────────────────────
// Persist
// ────────────────────────────────────────────────────────────

/**
 * Returns false when the unique index rejected this fix as a duplicate.
 *
 * `createMany({ skipDuplicates })` rather than `create` inside a try/catch,
 * for one reason that only shows up in a log file. A duplicate here is the
 * *ordinary* case — a vendor resend, a webhook retry, two pollers racing —
 * and letting it surface as a thrown P2002 made Prisma print a multi-line
 * `prisma:error … Unique constraint failed` for every one of them. A
 * worker log in which the most common line is an error teaches whoever
 * reads it that errors do not matter, which is the opposite of what a log
 * is for. The database does exactly the same work; it simply reports the
 * conflict as a count of zero instead of as an exception.
 */
async function persistPing(
  ping: NormalizedPing,
  vehicleId: string | null,
): Promise<boolean> {
  const { count } = await prisma.gpsPing.createMany({
    data: [
      {
        // A ping arrives before anything is known about it — `vehicleId` is
        // null for a device nobody has fitted yet — so the tenant is the one
        // whose poll or webhook brought the fix in.
        orgId: await requireTenantOrgId(),
        deviceId: ping.deviceId,
        vehicleId: vehicleId ?? undefined,
        latitude: ping.lat,
        longitude: ping.lng,
        speedKmph: ping.speedKmph ?? undefined,
        heading: ping.heading ?? undefined,
        ignition: ping.ignition ?? undefined,
        odometerKm: ping.odometerKm ?? undefined,
        recordedAt: ping.recordedAt,
        provider: ping.provider,
        providerRef: ping.providerRef ?? undefined,
      },
    ],
    skipDuplicates: true,
  });

  return count > 0;
}

// ────────────────────────────────────────────────────────────
// Fence events and propagation
// ────────────────────────────────────────────────────────────

/**
 * Writes the fence event and turns it into shipment events.
 *
 * This is the step the BRD calls the single highest-value automation in the
 * system: one truck entering one hub fence removes a manual arrival update
 * from every consignment aboard. It is also the step with the most ways to
 * be wrong, which is why the guards are explicit rather than implied.
 */
async function emitFenceEvent(
  vehicle: VehicleRef,
  trip: TripContext | null,
  transition: FenceTransition,
  ping: NormalizedPing,
): Promise<number> {
  const dwellMinutes =
    transition.direction === "EXIT"
      ? await dwellSinceEntry(vehicle.id, transition.geofenceId, ping.recordedAt)
      : null;

  const fenceEvent = await prisma.geofenceEvent.create({
    data: {
      orgId: vehicle.orgId,
      geofenceId: transition.geofenceId,
      vehicleId: vehicle.id,
      tripId: trip?.id ?? undefined,
      direction: transition.direction,
      latitude: ping.lat,
      longitude: ping.lng,
      occurredAt: ping.recordedAt,
      dwellMinutes: dwellMinutes ?? undefined,
    },
    select: { id: true },
  });

  const propagated = await propagateToShipments(vehicle, trip, transition, ping, fenceEvent.id);

  if (propagated > 0) {
    await prisma.geofenceEvent.update({
      where: { id: fenceEvent.id },
      data: { propagated: true },
    });
  }

  await recordSystemAudit({
    action: "STATUS_CHANGE",
    entity: "GeofenceEvent",
    entityId: fenceEvent.id,
    entityRef: `${transition.direction} ${transition.name}`,
    orgId: vehicle.orgId,
    branchId: transition.branchId,
    deviceId: ping.deviceId,
    after: {
      vehicle: vehicle.registrationNumber,
      trip: trip?.number ?? null,
      geofence: transition.name,
      direction: transition.direction,
      occurredAt: ping.recordedAt.toISOString(),
      shipmentsAffected: propagated,
      dwellMinutes,
      provider: ping.provider,
    },
    reason: `Geofence ${transition.direction.toLowerCase()} detected from GPS`,
  });

  return propagated;
}

async function propagateToShipments(
  vehicle: VehicleRef,
  trip: TripContext | null,
  transition: FenceTransition,
  ping: NormalizedPing,
  fenceEventId: string,
): Promise<number> {
  // Nothing propagates without a trip: a truck crossing a fence on its way
  // to a workshop is a movement, not an arrival.
  if (!trip) return 0;

  // Nor without a branch: a fence around a customer site or a restricted
  // zone is worth an event of its own, but it is not one of our nodes and
  // cannot be where a consignment arrived.
  if (!transition.branchId) return 0;

  const eventType: ShipmentEventType =
    transition.direction === "ENTER" ? "GEOFENCE_ENTER" : "GEOFENCE_EXIT";

  // An arrival is only meaningful for a trip that is actually running, and
  // a departure only for one that has just been dispatched. Without these
  // guards, a truck manoeuvring in the yard after gate-in would re-arrive
  // its own consignments.
  if (transition.direction === "ENTER" && trip.status !== "DISPATCHED" && trip.status !== "IN_TRANSIT") {
    return 0;
  }

  // The one that is easy to miss: a truck loaded and gated out is sitting
  // inside its own origin fence, and its first confirmed crossing is an
  // ENTER of that fence. Read literally, that is "arrived at Delhi hub" on
  // every consignment ten minutes after they were dispatched from it. An
  // arrival back at the origin only counts once the trip has been seen to
  // leave — which is what moves it to IN_TRANSIT.
  if (
    transition.direction === "ENTER" &&
    transition.branchId === trip.originBranchId &&
    trip.status === "DISPATCHED"
  ) {
    return 0;
  }

  if (transition.direction === "EXIT" && trip.status !== "DISPATCHED") return 0;
  if (transition.direction === "EXIT" && transition.branchId !== trip.originBranchId) return 0;

  const carrying = await shipmentsOnTrip(trip.id);
  if (carrying.length === 0) return 0;

  let moved = 0;

  for (const shipment of carrying) {
    const result = await appendShipmentEvent({
      shipmentId: shipment.id,
      eventType,
      occurredAt: ping.recordedAt,
      branchId: transition.branchId,
      vehicleId: vehicle.id,
      tripId: trip.id,
      manifestId: shipment.manifestId,
      latitude: ping.lat,
      longitude: ping.lng,
      deviceId: ping.deviceId,
      // GPS is a system source: no actor, no permission check, and — the
      // part that matters for a mixed fleet — a report can tell this from
      // a supervisor's manual entry (docs/BRD.html §A.9).
      source: "GPS",
      // Keyed on the fence event, so replaying this batch cannot produce a
      // second arrival for the same crossing.
      idempotencyKey: `geofence:${fenceEventId}:${shipment.id}`,
      payload: {
        geofence: transition.name,
        geofenceId: transition.geofenceId,
        direction: transition.direction,
        trip: trip.number,
        provider: ping.provider,
        automatic: true,
      } satisfies Prisma.InputJsonValue,
    }, null);

    // A refusal is expected and harmless: a consignment already delivered,
    // or short-shipped and left behind, declines the transition. Counting
    // only what moved keeps the number on the screen honest.
    if (result.ok && !result.duplicate) moved++;
  }

  return moved;
}

/** Minutes since the matching unpaired ENTER, for the dwell figure. */
async function dwellSinceEntry(
  vehicleId: string,
  geofenceId: string,
  exitedAt: Date,
): Promise<number | null> {
  const entry = await prisma.geofenceEvent.findFirst({
    where: {
      vehicleId,
      geofenceId,
      direction: "ENTER",
      occurredAt: { lt: exitedAt },
    },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  });

  if (!entry) return null;
  return Math.max(0, Math.round((exitedAt.getTime() - entry.occurredAt.getTime()) / 60_000));
}

/**
 * Moves a dispatched trip to in-transit on distance alone.
 *
 * Not every origin has a fence — a franchise operating out of a rented shed
 * very often does not — and a consignment that never leaves DISPATCHED is a
 * consignment whose customer is told nothing for six hours. The event is
 * idempotent per trip and per consignment, so it fires once however many
 * pings arrive afterwards.
 */
async function markInTransitIfMoved(
  trip: TripContext,
  point: LatLng,
  ping: NormalizedPing,
  branches: Awaited<ReturnType<typeof loadBranchPoints>>,
): Promise<number> {
  if (trip.status !== "DISPATCHED") return 0;

  const origin = branches.find((branch) => branch.id === trip.originBranchId);
  if (!origin) return 0;
  if (haversineMetres(point, origin.point) < DEPARTURE_DISTANCE_METRES) return 0;

  await markTripInTransit(trip);

  const carrying = await shipmentsOnTrip(trip.id);
  let moved = 0;

  for (const shipment of carrying) {
    const result = await appendShipmentEvent({
      shipmentId: shipment.id,
      eventType: "IN_TRANSIT_PING",
      occurredAt: ping.recordedAt,
      vehicleId: trip.vehicleId,
      tripId: trip.id,
      manifestId: shipment.manifestId,
      latitude: ping.lat,
      longitude: ping.lng,
      deviceId: ping.deviceId,
      source: "GPS",
      idempotencyKey: `trip:${trip.id}:intransit:${shipment.id}`,
      payload: {
        trip: trip.number,
        reason: "moved away from origin without an origin geofence",
        provider: ping.provider,
        automatic: true,
      } satisfies Prisma.InputJsonValue,
    }, null);

    if (result.ok && !result.duplicate) moved++;
  }

  return moved;
}

/**
 * Moves a trip from DISPATCHED to IN_TRANSIT.
 *
 * Until this phase, `IN_TRANSIT` was a status nothing ever set: gate-out
 * writes DISPATCHED and gate-in writes ARRIVED, and the stretch between
 * them — the part that takes eight hours — had no observation behind it.
 * Tracking is what closes that gap, and the dispatch board reads better for
 * it. The update is conditional in SQL rather than in JavaScript, so two
 * pollers racing cannot both claim the transition.
 */
async function markTripInTransit(trip: TripContext): Promise<void> {
  const { count } = await prisma.trip.updateMany({
    where: { id: trip.id, status: "DISPATCHED" },
    data: { status: "IN_TRANSIT" },
  });

  if (count === 0) return;
  trip.status = "IN_TRANSIT";

  await prisma.tripEvent.create({
    data: {
      orgId: trip.orgId,
      tripId: trip.id,
      eventType: "IN_TRANSIT",
      occurredAt: new Date(),
      payload: { source: "gps", reason: "observed to have left the origin" },
    },
  });

  await recordSystemAudit({
    action: "STATUS_CHANGE",
    entity: "Trip",
    entityId: trip.id,
    entityRef: trip.number,
    orgId: trip.orgId,
    branchId: trip.originBranchId,
    before: { status: "DISPATCHED" },
    after: { status: "IN_TRANSIT" },
    reason: "Departure observed from GPS",
  });
}

// ────────────────────────────────────────────────────────────
// Devices
// ────────────────────────────────────────────────────────────

async function resolveVehicles(deviceIds: string[]): Promise<Map<string, VehicleRef>> {
  const vehicles = await prisma.vehicle.findMany({
    where: { gpsDeviceId: { in: deviceIds }, deletedAt: null },
    select: { id: true, orgId: true, registrationNumber: true, gpsDeviceId: true },
  });

  const map = new Map<string, VehicleRef>();
  for (const vehicle of vehicles) {
    if (!vehicle.gpsDeviceId) continue;
    map.set(vehicle.gpsDeviceId, {
      id: vehicle.id,
      orgId: vehicle.orgId,
      registrationNumber: vehicle.registrationNumber,
    });
  }
  return map;
}

/** Devices we expect to hear from: fitted vehicles that are not retired. */
export async function trackedDeviceIds(): Promise<string[]> {
  const vehicles = await prisma.vehicle.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      gpsDeviceId: { not: null },
      status: { notIn: ["INACTIVE"] },
    },
    select: { gpsDeviceId: true },
  });

  return vehicles
    .map((v) => v.gpsDeviceId)
    .filter((id): id is string => Boolean(id));
}
