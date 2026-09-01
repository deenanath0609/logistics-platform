import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { anyBranchScope, coversBranch } from "@/server/repositories/scope";
import {
  haversineMetres,
  polylineLengthMetres,
  projectOntoPolyline,
  type LatLng,
} from "./geo";
import { delayMinutes, scheduleEta } from "./eta";
import { LIVE_TRIP_STATUSES, plannedRouteForTrip, type TripContext } from "./context";

/**
 * Read models for the tracking screens.
 *
 * Assembled here rather than in the pages because the joins are not joins:
 * `VehicleLocation`, `TrackingAlert` and `EtaSnapshot` carry vehicle and
 * trip ids without Prisma relations — the tracking tables are deliberately
 * decoupled from the operational ones so a telematics vendor can be swapped
 * without a migration on `trip`. The cost is that stitching happens in
 * application code, and it should happen in exactly one place.
 *
 * Everything returned is plain and serialisable. Prisma `Decimal` and
 * Lucide components both fail to cross the server/client boundary, so
 * numbers come back as numbers and icons come back as names.
 */

export type FleetVehicle = {
  vehicleId: string;
  registrationNumber: string;
  vehicleType: string;
  ownership: string;
  vehicleStatus: string;
  /** Null for a vehicle with no device and no manual position. */
  position: LatLng | null;
  positionAt: string | null;
  /** Minutes since the last fix, computed server-side against one clock. */
  lastPingAgeMinutes: number | null;
  speedKmph: number | null;
  heading: number | null;
  ignition: boolean | null;
  /** True when the last position was typed rather than reported. */
  manualPosition: boolean;
  hasDevice: boolean;
  nearestBranchCode: string | null;
  distanceToNearestKm: number | null;

  trip: {
    id: string;
    number: string;
    status: string;
    originCode: string;
    destinationCode: string;
    driverName: string | null;
    driverMobile: string | null;
    departedAt: string | null;
    plannedArrivalAt: string | null;
    shipmentCount: number;
    shipments: Array<{ id: string; lrNumber: string; status: string; consignee: string }>;
  } | null;

  /** Progress along the planned route, 0–1. Null without a route. */
  progress: number | null;
  coveredKm: number | null;
  remainingKm: number | null;
  routeQuality: string | null;

  eta: {
    at: string;
    method: string;
    confidence: string | null;
    computedAt: string;
    delayMinutes: number | null;
  } | null;

  alerts: Array<{ id: string; kind: string; detectedAt: string; summary: string }>;
  /** Worst thing wrong with this vehicle, for the map colour. */
  tone: "ok" | "warn" | "bad" | "idle";
};

export type MapBranch = {
  id: string;
  code: string;
  name: string;
  type: string;
  point: LatLng;
};

export type MapRoute = {
  tripId: string;
  points: LatLng[];
};

export type LiveFleet = {
  vehicles: FleetVehicle[];
  branches: MapBranch[];
  /**
   * The nodes this user may record a movement at.
   *
   * A subset of `branches`, and separate from it on purpose: the map draws
   * the whole network so a dispatcher can see where a truck is relative to
   * places they do not run, while a typed arrival is refused anywhere they
   * do not cover. Offering the full list in the dialog produced a dropdown
   * whose options were rejected on submit, which reads as a broken form
   * rather than as a boundary.
   */
  recordableBranches: Array<{ id: string; code: string; name: string }>;
  routes: MapRoute[];
  /** Server clock at load, so relative times agree between server and client. */
  asOf: string;
  counts: { moving: number; stopped: number; silent: number; idle: number };
};

/** Minutes of silence after which the live map stops believing a position. */
const STALE_MINUTES = 20;

export async function loadLiveFleet(user: SessionUser): Promise<LiveFleet> {
  const now = new Date();

  const trips = await prisma.trip.findMany({
    where: {
      status: { in: [...LIVE_TRIP_STATUSES] },
      ...anyBranchScope(user, ["originBranchId", "destinationBranchId"]),
    },
    orderBy: [{ actualDepartureAt: "desc" }, { createdAt: "desc" }],
    take: 200,
    select: {
      id: true,
      number: true,
      status: true,
      orgId: true,
      vehicleId: true,
      routeId: true,
      originBranchId: true,
      destinationBranchId: true,
      actualDepartureAt: true,
      plannedArrivalAt: true,
      originBranch: { select: { code: true } },
      destinationBranch: { select: { code: true } },
      driver: { select: { name: true, mobile: true } },
      vehicle: {
        select: {
          id: true,
          registrationNumber: true,
          ownership: true,
          status: true,
          gpsDeviceId: true,
          vehicleType: { select: { name: true } },
        },
      },
    },
  });

  const vehicleIds = [...new Set(trips.map((trip) => trip.vehicleId))];

  const [locations, alerts, snapshots, branchRows, carrying] = await Promise.all([
    vehicleIds.length > 0
      ? prisma.vehicleLocation.findMany({ where: { vehicleId: { in: vehicleIds } } })
      : [],
    vehicleIds.length > 0
      ? prisma.trackingAlert.findMany({
          where: { vehicleId: { in: vehicleIds }, resolvedAt: null },
          orderBy: { detectedAt: "desc" },
          select: {
            id: true,
            kind: true,
            vehicleId: true,
            detectedAt: true,
            deviationMetres: true,
            durationMinutes: true,
            details: true,
          },
        })
      : [],
    trips.length > 0
      ? prisma.etaSnapshot.findMany({
          where: { tripId: { in: trips.map((t) => t.id) } },
          orderBy: { computedAt: "desc" },
          take: 400,
        })
      : [],
    prisma.branch.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        latitude: { not: null },
        longitude: { not: null },
      },
      select: { id: true, code: true, name: true, type: true, latitude: true, longitude: true },
    }),
    loadCarriedShipments(trips.map((t) => t.id)),
  ]);

  const locationByVehicle = new Map(locations.map((row) => [row.vehicleId, row]));
  const branchById = new Map(branchRows.map((row) => [row.id, row]));

  const alertsByVehicle = new Map<string, typeof alerts>();
  for (const alert of alerts) {
    const list = alertsByVehicle.get(alert.vehicleId) ?? [];
    list.push(alert);
    alertsByVehicle.set(alert.vehicleId, list);
  }

  const etaByTrip = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    // Ordered newest first, so the first one seen per trip is the current one.
    if (!etaByTrip.has(snapshot.tripId)) etaByTrip.set(snapshot.tripId, snapshot);
  }

  const vehicles: FleetVehicle[] = [];
  const routes: MapRoute[] = [];
  const counts = { moving: 0, stopped: 0, silent: 0, idle: 0 };

  for (const trip of trips) {
    const context: TripContext = {
      id: trip.id,
      number: trip.number,
      status: trip.status as string,
      vehicleId: trip.vehicleId,
      orgId: trip.orgId,
      originBranchId: trip.originBranchId,
      destinationBranchId: trip.destinationBranchId,
      routeId: trip.routeId,
      actualDepartureAt: trip.actualDepartureAt,
      plannedArrivalAt: trip.plannedArrivalAt,
    };

    const route = await plannedRouteForTrip(context);
    if (route.points.length >= 2) {
      routes.push({ tripId: trip.id, points: simplify(route.points) });
    }

    const location = locationByVehicle.get(trip.vehicleId);
    const position: LatLng | null = location
      ? { lat: Number(location.latitude), lng: Number(location.longitude) }
      : null;

    const ageMinutes = location
      ? Math.max(0, Math.floor((now.getTime() - location.recordedAt.getTime()) / 60_000))
      : null;

    let progress: number | null = null;
    let coveredKm: number | null = null;
    let remainingKm: number | null = null;

    if (position && route.points.length >= 2) {
      const total = polylineLengthMetres(route.points);
      const projected = projectOntoPolyline(position, route.points);
      if (projected && total > 0) {
        progress = Math.min(1, Math.max(0, projected.alongMetres / total));
        coveredKm = round2(projected.alongMetres / 1000);
        remainingKm = round2(Math.max(0, total - projected.alongMetres) / 1000);
      }
    }

    const snapshot = etaByTrip.get(trip.id);
    const vehicleAlerts = alertsByVehicle.get(trip.vehicleId) ?? [];
    const onBoard = carrying.get(trip.id) ?? [];

    const hasDevice = Boolean(trip.vehicle.gpsDeviceId);
    const manualPosition = location?.deviceId?.startsWith("manual:") ?? false;
    const silent = hasDevice && (ageMinutes === null || ageMinutes >= STALE_MINUTES);
    const moving = (location?.speedKmph ? Number(location.speedKmph) : 0) > 3;

    const tone: FleetVehicle["tone"] = vehicleAlerts.some(
      (a) => a.kind === "SIGNAL_LOST" || a.kind === "ROUTE_DEVIATION",
    )
      ? "bad"
      : vehicleAlerts.length > 0 || silent
        ? "warn"
        : moving
          ? "ok"
          : "idle";

    if (silent) counts.silent++;
    else if (moving) counts.moving++;
    else if (position) counts.stopped++;
    else counts.idle++;

    vehicles.push({
      vehicleId: trip.vehicleId,
      registrationNumber: trip.vehicle.registrationNumber,
      vehicleType: trip.vehicle.vehicleType.name,
      ownership: trip.vehicle.ownership as string,
      vehicleStatus: trip.vehicle.status as string,
      position,
      positionAt: location?.recordedAt.toISOString() ?? null,
      lastPingAgeMinutes: ageMinutes,
      speedKmph: location?.speedKmph == null ? null : Number(location.speedKmph),
      heading: location?.heading ?? null,
      ignition: location?.ignition ?? null,
      manualPosition,
      hasDevice,
      nearestBranchCode: location?.nearestBranchId
        ? (branchById.get(location.nearestBranchId)?.code ?? null)
        : null,
      distanceToNearestKm:
        location?.distanceToNearestKm == null ? null : Number(location.distanceToNearestKm),
      trip: {
        id: trip.id,
        number: trip.number,
        status: trip.status as string,
        originCode: trip.originBranch.code,
        destinationCode: trip.destinationBranch.code,
        driverName: trip.driver?.name ?? null,
        driverMobile: trip.driver?.mobile ?? null,
        departedAt: trip.actualDepartureAt?.toISOString() ?? null,
        plannedArrivalAt: trip.plannedArrivalAt?.toISOString() ?? null,
        shipmentCount: onBoard.length,
        shipments: onBoard.slice(0, 25),
      },
      progress,
      coveredKm,
      remainingKm,
      routeQuality: route.quality,
      // A measured estimate where there is one; otherwise the timetable.
      //
      // Half the fleet is attached or vendor-owned and will never have a
      // working device, and a vehicle standing still produces no estimate
      // by design. Both used to render "No estimate" on a trip that has a
      // planned arrival sitting on it — the answer was on the row and the
      // screen would not say it. `method` distinguishes the two, so nobody
      // mistakes the timetable for a live observation.
      eta: snapshot
        ? {
            at: snapshot.estimatedArrivalAt.toISOString(),
            method: snapshot.method,
            confidence: snapshot.confidence,
            computedAt: snapshot.computedAt.toISOString(),
            delayMinutes: delayMinutes(snapshot.estimatedArrivalAt, trip.plannedArrivalAt),
          }
        : scheduledEtaFor(trip.plannedArrivalAt, now),
      alerts: vehicleAlerts.map((alert) => ({
        id: alert.id,
        kind: alert.kind as string,
        detectedAt: alert.detectedAt.toISOString(),
        summary: alertSummary(alert),
      })),
      tone,
    });
  }

  // Only the branches worth drawing: the ends of the lanes on screen, plus
  // every hub, so the schematic reads as a network rather than a scatter.
  const relevant = new Set<string>();
  for (const trip of trips) {
    relevant.add(trip.originBranchId);
    relevant.add(trip.destinationBranchId);
  }

  const branches: MapBranch[] = branchRows
    .filter((row) => relevant.has(row.id) || row.type === "HUB")
    .map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type as string,
      point: { lat: Number(row.latitude), lng: Number(row.longitude) },
    }));

  const recordableBranches = branches
    .filter((branch) => coversBranch(user, branch.id))
    .map((branch) => ({ id: branch.id, code: branch.code, name: branch.name }));

  return {
    vehicles,
    branches,
    recordableBranches,
    routes,
    asOf: now.toISOString(),
    counts,
  };
}

/**
 * The trip's own planned arrival, dressed as an estimate.
 *
 * Not stored — nothing is written to `EtaSnapshot`, which stays a record of
 * what GPS actually measured. This is a display fallback and says so:
 * `method` is "schedule" and confidence is "low", and the lateness against
 * plan is deliberately null rather than zero, because a timetable compared
 * against itself is not evidence that anything is on time.
 */
function scheduledEtaFor(
  plannedArrivalAt: Date | null,
  now: Date,
): FleetVehicle["eta"] {
  const scheduled = scheduleEta(plannedArrivalAt);
  if (!scheduled) return null;

  return {
    at: scheduled.estimatedArrivalAt.toISOString(),
    method: scheduled.method,
    confidence: scheduled.confidence,
    computedAt: now.toISOString(),
    delayMinutes: null,
  };
}

function alertSummary(alert: {
  kind: string;
  deviationMetres: number | null;
  durationMinutes: number | null;
  details: unknown;
}): string {
  if (alert.details && typeof alert.details === "object" && !Array.isArray(alert.details)) {
    const title = (alert.details as Record<string, unknown>).title;
    if (typeof title === "string" && title.length > 0) return title;
  }
  if (alert.deviationMetres != null) return `${alert.deviationMetres} m off route`;
  if (alert.durationMinutes != null) return `${alert.durationMinutes} minutes`;
  return alert.kind.replace(/_/g, " ").toLowerCase();
}

async function loadCarriedShipments(
  tripIds: string[],
): Promise<Map<string, Array<{ id: string; lrNumber: string; status: string; consignee: string }>>> {
  const map = new Map<string, Array<{ id: string; lrNumber: string; status: string; consignee: string }>>();
  if (tripIds.length === 0) return map;

  const [ftl, lines] = await Promise.all([
    prisma.trip.findMany({
      where: { id: { in: tripIds }, ftlShipmentId: { not: null } },
      select: {
        id: true,
        ftlShipment: {
          select: { id: true, lrNumber: true, currentStatus: true, consigneeName: true },
        },
      },
    }),
    prisma.manifestLine.findMany({
      where: {
        manifest: { tripId: { in: tripIds }, status: { notIn: ["CANCELLED"] } },
      },
      take: 2_000,
      select: {
        manifest: { select: { tripId: true } },
        shipment: {
          select: { id: true, lrNumber: true, currentStatus: true, consigneeName: true },
        },
      },
    }),
  ]);

  for (const trip of ftl) {
    if (!trip.ftlShipment) continue;
    map.set(trip.id, [
      {
        id: trip.ftlShipment.id,
        lrNumber: trip.ftlShipment.lrNumber,
        status: trip.ftlShipment.currentStatus as string,
        consignee: trip.ftlShipment.consigneeName,
      },
    ]);
  }

  for (const line of lines) {
    const tripId = line.manifest.tripId;
    if (!tripId) continue;
    const list = map.get(tripId) ?? [];
    list.push({
      id: line.shipment.id,
      lrNumber: line.shipment.lrNumber,
      status: line.shipment.currentStatus as string,
      consignee: line.shipment.consigneeName,
    });
    map.set(tripId, list);
  }

  return map;
}

// ────────────────────────────────────────────────────────────
// Trip replay
// ────────────────────────────────────────────────────────────

export type ReplayFix = {
  at: string;
  lat: number;
  lng: number;
  speedKmph: number | null;
  /** Kilometres from the previous fix; the source of the distance total. */
  legKm: number;
  provider: string | null;
};

export type TripReplay = {
  trip: {
    id: string;
    number: string;
    status: string;
    originCode: string;
    destinationCode: string;
    vehicle: string;
    driverName: string | null;
    departedAt: string | null;
    arrivedAt: string | null;
    plannedArrivalAt: string | null;
    odometerKm: number | null;
  };
  fixes: ReplayFix[];
  route: LatLng[];
  routeQuality: string;
  fences: Array<{
    id: string;
    at: string;
    direction: string;
    name: string;
    dwellMinutes: number | null;
    propagated: boolean;
  }>;
  alerts: Array<{
    id: string;
    kind: string;
    detectedAt: string;
    resolvedAt: string | null;
    summary: string;
    lat: number | null;
    lng: number | null;
  }>;
  stats: {
    fixCount: number;
    trackedKm: number;
    routeKm: number;
    movingMinutes: number;
    stoppedMinutes: number;
    maxSpeedKmph: number | null;
    averageSpeedKmph: number | null;
    /** How much of the trip has no fixes at all, in minutes. */
    gapMinutes: number;
  };
  /** Arrival events on the consignments, split by how they were recorded. */
  provenance: { automatic: number; manual: number };
};

const REPLAY_FIX_LIMIT = 3_000;
/** A gap longer than this is a hole in the trail, not a slow reporting rate. */
const GAP_MINUTES = 15;

/**
 * Historical playback for one trip.
 *
 * `user` is not optional, and the scope fragment is not decoration. The
 * live map has always been branch-scoped; this screen was not, so a
 * branch-scoped account holding `tracking.replay` could type any trip id
 * and read another branch's whole trail — position by position, with the
 * driver's name on it. Scoped the same way `loadLiveFleet` is, against the
 * two ends of the lane, so a Jaipur trip is readable by Delhi and Jaipur
 * and by nobody else. A network-scoped user is unaffected: `anyBranchScope`
 * returns an empty fragment for them.
 */
export async function loadTripReplay(
  tripId: string,
  user: SessionUser,
): Promise<TripReplay | null> {
  const trip = await prisma.trip.findFirst({
    where: {
      id: tripId,
      ...anyBranchScope(user, ["originBranchId", "destinationBranchId"]),
    },
    select: {
      id: true,
      number: true,
      status: true,
      orgId: true,
      vehicleId: true,
      routeId: true,
      originBranchId: true,
      destinationBranchId: true,
      actualDepartureAt: true,
      actualArrivalAt: true,
      plannedArrivalAt: true,
      createdAt: true,
      distanceKm: true,
      originBranch: { select: { code: true } },
      destinationBranch: { select: { code: true } },
      driver: { select: { name: true } },
      vehicle: { select: { registrationNumber: true } },
    },
  });

  if (!trip) return null;

  const from = trip.actualDepartureAt ?? trip.createdAt;
  const to = trip.actualArrivalAt ?? new Date();

  const [pings, fenceEvents, alerts, events] = await Promise.all([
    prisma.gpsPing.findMany({
      where: { vehicleId: trip.vehicleId, recordedAt: { gte: from, lte: to } },
      orderBy: { recordedAt: "asc" },
      take: REPLAY_FIX_LIMIT,
      select: {
        latitude: true,
        longitude: true,
        speedKmph: true,
        recordedAt: true,
        provider: true,
      },
    }),
    prisma.geofenceEvent.findMany({
      where: { vehicleId: trip.vehicleId, occurredAt: { gte: from, lte: to } },
      orderBy: { occurredAt: "asc" },
      select: {
        id: true,
        direction: true,
        occurredAt: true,
        dwellMinutes: true,
        propagated: true,
        geofence: { select: { name: true } },
      },
    }),
    prisma.trackingAlert.findMany({
      where: { vehicleId: trip.vehicleId, detectedAt: { gte: from, lte: to } },
      orderBy: { detectedAt: "asc" },
      select: {
        id: true,
        kind: true,
        detectedAt: true,
        resolvedAt: true,
        latitude: true,
        longitude: true,
        deviationMetres: true,
        durationMinutes: true,
        details: true,
      },
    }),
    // The provenance split the BRD asks for: how many of this trip's
    // arrival events came from a fence, and how many were typed in.
    prisma.shipmentEvent.groupBy({
      by: ["source"],
      where: {
        tripId: trip.id,
        eventType: { in: ["GEOFENCE_ENTER", "GEOFENCE_EXIT", "IN_TRANSIT_PING", "GATE_IN", "GATE_OUT"] },
      },
      _count: { _all: true },
    }),
  ]);

  const fixes: ReplayFix[] = [];
  let trackedMetres = 0;
  let movingMs = 0;
  let stoppedMs = 0;
  let gapMs = 0;
  let maxSpeed: number | null = null;

  for (let i = 0; i < pings.length; i++) {
    const row = pings[i];
    const point = { lat: Number(row.latitude), lng: Number(row.longitude) };
    const previous = i > 0 ? pings[i - 1] : null;

    let legMetres = 0;
    if (previous) {
      legMetres = haversineMetres(
        { lat: Number(previous.latitude), lng: Number(previous.longitude) },
        point,
      );
      trackedMetres += legMetres;

      const deltaMs = row.recordedAt.getTime() - previous.recordedAt.getTime();
      if (deltaMs > GAP_MINUTES * 60_000) gapMs += deltaMs;
      else if (legMetres > 100) movingMs += deltaMs;
      else stoppedMs += deltaMs;
    }

    const speed = row.speedKmph === null ? null : Number(row.speedKmph);
    if (speed !== null && (maxSpeed === null || speed > maxSpeed)) maxSpeed = speed;

    fixes.push({
      at: row.recordedAt.toISOString(),
      lat: point.lat,
      lng: point.lng,
      speedKmph: speed,
      legKm: round2(legMetres / 1000),
      provider: row.provider,
    });
  }

  const route = await plannedRouteForTrip({
    id: trip.id,
    number: trip.number,
    status: trip.status as string,
    vehicleId: trip.vehicleId,
    orgId: trip.orgId,
    originBranchId: trip.originBranchId,
    destinationBranchId: trip.destinationBranchId,
    routeId: trip.routeId,
    actualDepartureAt: trip.actualDepartureAt,
    plannedArrivalAt: trip.plannedArrivalAt,
  });

  const movingMinutes = Math.round(movingMs / 60_000);

  return {
    trip: {
      id: trip.id,
      number: trip.number,
      status: trip.status as string,
      originCode: trip.originBranch.code,
      destinationCode: trip.destinationBranch.code,
      vehicle: trip.vehicle.registrationNumber,
      driverName: trip.driver?.name ?? null,
      departedAt: trip.actualDepartureAt?.toISOString() ?? null,
      arrivedAt: trip.actualArrivalAt?.toISOString() ?? null,
      plannedArrivalAt: trip.plannedArrivalAt?.toISOString() ?? null,
      odometerKm: trip.distanceKm === null ? null : Number(trip.distanceKm),
    },
    fixes,
    route: simplify(route.points),
    routeQuality: route.quality,
    fences: fenceEvents.map((event) => ({
      id: event.id,
      at: event.occurredAt.toISOString(),
      direction: event.direction as string,
      name: event.geofence.name,
      dwellMinutes: event.dwellMinutes,
      propagated: event.propagated,
    })),
    alerts: alerts.map((alert) => ({
      id: alert.id,
      kind: alert.kind as string,
      detectedAt: alert.detectedAt.toISOString(),
      resolvedAt: alert.resolvedAt?.toISOString() ?? null,
      summary: alertSummary(alert),
      lat: alert.latitude === null ? null : Number(alert.latitude),
      lng: alert.longitude === null ? null : Number(alert.longitude),
    })),
    stats: {
      fixCount: fixes.length,
      trackedKm: round2(trackedMetres / 1000),
      routeKm: round2(polylineLengthMetres(route.points) / 1000),
      movingMinutes,
      stoppedMinutes: Math.round(stoppedMs / 60_000),
      maxSpeedKmph: maxSpeed,
      averageSpeedKmph:
        movingMinutes > 0 ? round2(trackedMetres / 1000 / (movingMinutes / 60)) : null,
      gapMinutes: Math.round(gapMs / 60_000),
    },
    provenance: {
      automatic: events
        .filter((row) => row.source === "GPS" || row.source === "SYSTEM")
        .reduce((sum, row) => sum + row._count._all, 0),
      manual: events
        .filter((row) => row.source !== "GPS" && row.source !== "SYSTEM")
        .reduce((sum, row) => sum + row._count._all, 0),
    },
  };
}

// ────────────────────────────────────────────────────────────
// Provider configuration
// ────────────────────────────────────────────────────────────

export type ProviderSummary = {
  id: string;
  code: string;
  name: string;
  mode: string;
  baseUrl: string | null;
  /** Whether a secret exists — never the secret itself. */
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  pollIntervalSeconds: number;
  isActive: boolean;
  lastPolledAt: string | null;
  lastError: string | null;
};

/**
 * Provider rows, with the secrets stripped at the source.
 *
 * `apiKey` and `webhookSecret` are never selected, so there is no path by
 * which they reach a page, a prop, or a serialised payload. A component
 * that forgets to omit them cannot leak what it was never handed.
 */
export async function loadProviders(orgId: string): Promise<ProviderSummary[]> {
  const rows = await prisma.trackingProviderConfig.findMany({
    where: { orgId },
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
    select: {
      id: true,
      code: true,
      name: true,
      mode: true,
      baseUrl: true,
      pollIntervalSeconds: true,
      isActive: true,
      lastPolledAt: true,
      lastError: true,
      // Selected as a boolean expression would be ideal; Prisma cannot, so
      // the two secrets are fetched and immediately reduced to "is it set".
      apiKey: true,
      webhookSecret: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    mode: row.mode,
    baseUrl: row.baseUrl,
    hasApiKey: Boolean(row.apiKey),
    hasWebhookSecret: Boolean(row.webhookSecret),
    pollIntervalSeconds: row.pollIntervalSeconds,
    isActive: row.isActive,
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    lastError: row.lastError,
  }));
}

// ────────────────────────────────────────────────────────────

/**
 * Thins a polyline for the wire.
 *
 * A decoded lane can be thousands of points; the schematic is a few hundred
 * pixels wide. Every point beyond that is bytes on the wire and nodes in
 * the DOM for a difference nobody can see. The ends are always kept, so the
 * lane still starts and finishes where it should.
 */
function simplify(points: readonly LatLng[], maxPoints = 120): LatLng[] {
  if (points.length <= maxPoints) return [...points];
  const step = Math.ceil(points.length / maxPoints);
  const out: LatLng[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
