import { prisma } from "@/lib/prisma";
import { decodePolyline, parseGeoJsonRing, type LatLng } from "./geo";
import type { FenceDefinition } from "./geofence";

/**
 * Everything the pipeline has to read from the database before it can
 * decide anything, and the small caches that stop it reading the same
 * things thirty times a minute.
 *
 * Fences and branch coordinates change a few times a year and are read on
 * every ping of every vehicle. Trip routes change when a trip is planned
 * and are read for the whole life of that trip. Caching them for a minute
 * turns a poll of forty vehicles from a hundred and twenty queries into
 * three, and the staleness it buys — a fence edited less than sixty
 * seconds ago — is not a staleness anyone can perceive.
 */

const FENCE_TTL_MS = 60_000;
const BRANCH_TTL_MS = 5 * 60_000;
const ROUTE_TTL_MS = 10 * 60_000;

type Cached<T> = { value: T; expiresAt: number };

const globalForCache = globalThis as unknown as {
  trackingFenceCache: Cached<FenceDefinition[]> | undefined;
  trackingBranchCache: Cached<BranchPoint[]> | undefined;
  trackingRouteCache: Map<string, Cached<PlannedRoute>> | undefined;
};

export type BranchPoint = {
  id: string;
  code: string;
  name: string;
  type: string;
  point: LatLng;
};

// ────────────────────────────────────────────────────────────
// Geofences
// ────────────────────────────────────────────────────────────

/**
 * Active fences, in the shape the pure evaluator wants.
 *
 * A fence whose geometry does not parse is dropped here rather than passed
 * on as a fence that contains nothing. Both behave identically, but only
 * one of them says so in the log, and a hub whose arrivals quietly stopped
 * working is worth a line.
 */
export async function loadFences(options: { fresh?: boolean } = {}): Promise<FenceDefinition[]> {
  const cached = globalForCache.trackingFenceCache;
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const rows = await prisma.geofence.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      type: true,
      branchId: true,
      centerLat: true,
      centerLng: true,
      radiusMeters: true,
      polygon: true,
      debouncePings: true,
    },
  });

  const fences: FenceDefinition[] = [];
  for (const row of rows) {
    if (row.type === "POLYGON") {
      const ring = parseGeoJsonRing(row.polygon);
      if (!ring) {
        console.warn(`[tracking] geofence ${row.id} (${row.name}) has an unreadable polygon`);
        continue;
      }
      fences.push({
        id: row.id,
        name: row.name,
        type: "POLYGON",
        branchId: row.branchId,
        centre: null,
        radiusMetres: null,
        ring,
        debouncePings: row.debouncePings,
      });
      continue;
    }

    if (row.centerLat == null || row.centerLng == null || row.radiusMeters == null) {
      console.warn(`[tracking] geofence ${row.id} (${row.name}) has no centre or radius`);
      continue;
    }

    fences.push({
      id: row.id,
      name: row.name,
      type: "CIRCLE",
      branchId: row.branchId,
      centre: { lat: Number(row.centerLat), lng: Number(row.centerLng) },
      radiusMetres: row.radiusMeters,
      ring: null,
      debouncePings: row.debouncePings,
    });
  }

  globalForCache.trackingFenceCache = {
    value: fences,
    expiresAt: Date.now() + FENCE_TTL_MS,
  };
  return fences;
}

/** Called after a fence is created or edited, so the change lands at once. */
export function invalidateFenceCache(): void {
  globalForCache.trackingFenceCache = undefined;
}

// ────────────────────────────────────────────────────────────
// Branches
// ────────────────────────────────────────────────────────────

/** Every network node that has coordinates, for "nearest known place". */
export async function loadBranchPoints(): Promise<BranchPoint[]> {
  const cached = globalForCache.trackingBranchCache;
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const rows = await prisma.branch.findMany({
    where: { deletedAt: null, isActive: true, latitude: { not: null }, longitude: { not: null } },
    select: { id: true, code: true, name: true, type: true, latitude: true, longitude: true },
  });

  const points = rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type as string,
    point: { lat: Number(row.latitude), lng: Number(row.longitude) },
  }));

  globalForCache.trackingBranchCache = {
    value: points,
    expiresAt: Date.now() + BRANCH_TTL_MS,
  };
  return points;
}

// ────────────────────────────────────────────────────────────
// Trips
// ────────────────────────────────────────────────────────────

/** The statuses in which a vehicle is out on the road and worth tracking. */
export const LIVE_TRIP_STATUSES = [
  "DISPATCHED",
  "IN_TRANSIT",
  "ARRIVED",
  "UNLOADING",
] as const;

export type TripContext = {
  id: string;
  number: string;
  status: string;
  vehicleId: string;
  originBranchId: string;
  destinationBranchId: string;
  routeId: string | null;
  actualDepartureAt: Date | null;
  plannedArrivalAt: Date | null;
  orgId: string;
};

/**
 * The trip a vehicle is currently running, if any.
 *
 * A position with no trip behind it is still worth storing — the live map
 * shows idle vehicles, and a truck that reports from a workshop is useful
 * information — but nothing propagates to a consignment without one.
 */
export async function activeTripForVehicle(vehicleId: string): Promise<TripContext | null> {
  const trip = await prisma.trip.findFirst({
    where: { vehicleId, status: { in: [...LIVE_TRIP_STATUSES] } },
    orderBy: [{ actualDepartureAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      number: true,
      status: true,
      vehicleId: true,
      orgId: true,
      originBranchId: true,
      destinationBranchId: true,
      routeId: true,
      actualDepartureAt: true,
      plannedArrivalAt: true,
    },
  });

  return trip ? { ...trip, status: trip.status as string } : null;
}

/**
 * The planned path for a trip, as a list of points.
 *
 * Three sources, in descending order of honesty: the encoded polylines on
 * the route's legs, the coordinates of the branches those legs connect,
 * and — failing both — a straight line from origin to destination. The last
 * is a poor route and a real one: it gives a remaining distance that is too
 * short rather than an ETA that is missing, and a deviation threshold wide
 * enough that it will not cry wolf. `routeQuality` says which was used, so
 * the screen can be honest about it.
 */
export type PlannedRoute = {
  points: LatLng[];
  quality: "polyline" | "branches" | "straight-line" | "none";
};

export async function plannedRouteForTrip(trip: TripContext): Promise<PlannedRoute> {
  const cache = (globalForCache.trackingRouteCache ??= new Map());
  const cached = cache.get(trip.id);
  // The quality is cached with the points, never re-derived from them. It
  // records *where the path came from* — decoded polylines, the branches a
  // route connects, or a straight line between two ends — and the point
  // count cannot tell those apart: a two-hop lane resolved from branch
  // coordinates has exactly two points and would read back as a straight
  // line, which switches route-deviation detection off entirely. A short
  // decoded polyline would read back as "branches" and get a threshold ten
  // times too wide. Both faults appeared only after the first cache hit,
  // which is the hardest kind of fault to see.
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const resolved = await resolveRoute(trip);
  cache.set(trip.id, { value: resolved, expiresAt: Date.now() + ROUTE_TTL_MS });
  return resolved;
}

async function resolveRoute(trip: TripContext): Promise<PlannedRoute> {
  if (trip.routeId) {
    const legs = await prisma.routeLeg.findMany({
      where: { routeId: trip.routeId },
      orderBy: { sequence: "asc" },
      select: {
        polyline: true,
        originBranch: { select: { latitude: true, longitude: true } },
        destinationBranch: { select: { latitude: true, longitude: true } },
      },
    });

    if (legs.length > 0) {
      const decoded: LatLng[] = [];
      let everyLegHasAPolyline = true;

      for (const leg of legs) {
        const points = decodePolyline(leg.polyline);
        if (points.length >= 2) {
          // Legs share a branch at the join, so the first point of each
          // continuation would otherwise be a duplicate.
          decoded.push(...(decoded.length > 0 ? points.slice(1) : points));
        } else {
          everyLegHasAPolyline = false;
        }
      }

      if (everyLegHasAPolyline && decoded.length >= 2) {
        return { points: decoded, quality: "polyline" };
      }

      const viaBranches = legs
        .flatMap((leg, index) =>
          index === 0 ? [leg.originBranch, leg.destinationBranch] : [leg.destinationBranch],
        )
        .filter((branch) => branch.latitude != null && branch.longitude != null)
        .map((branch) => ({ lat: Number(branch.latitude), lng: Number(branch.longitude) }));

      if (viaBranches.length >= 2) {
        return { points: viaBranches, quality: "branches" };
      }
    }
  }

  const ends = await prisma.branch.findMany({
    where: { id: { in: [trip.originBranchId, trip.destinationBranchId] } },
    select: { id: true, latitude: true, longitude: true },
  });

  const origin = ends.find((b) => b.id === trip.originBranchId);
  const destination = ends.find((b) => b.id === trip.destinationBranchId);

  if (
    origin?.latitude != null &&
    origin.longitude != null &&
    destination?.latitude != null &&
    destination.longitude != null
  ) {
    return {
      points: [
        { lat: Number(origin.latitude), lng: Number(origin.longitude) },
        { lat: Number(destination.latitude), lng: Number(destination.longitude) },
      ],
      quality: "straight-line",
    };
  }

  return { points: [], quality: "none" };
}

export function invalidateRouteCache(tripId?: string): void {
  if (!globalForCache.trackingRouteCache) return;
  if (tripId) globalForCache.trackingRouteCache.delete(tripId);
  else globalForCache.trackingRouteCache.clear();
}

// ────────────────────────────────────────────────────────────
// What is on board
// ────────────────────────────────────────────────────────────

export type CarriedShipment = {
  id: string;
  lrNumber: string;
  manifestId: string | null;
  currentStatus: string;
};

/**
 * Every consignment a trip is carrying.
 *
 * Deliberately duplicated from `@/lib/transport/trip`, where the same query
 * is private to gate-out and gate-in. Exporting it from there would make a
 * background poller a caller of the dispatch service, and the two have very
 * different failure modes: a slow query here must never be able to hold up
 * a clerk at a gate.
 */
export async function shipmentsOnTrip(tripId: string): Promise<CarriedShipment[]> {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    select: {
      ftlShipment: { select: { id: true, lrNumber: true, currentStatus: true } },
      manifests: {
        where: { status: { notIn: ["CANCELLED"] } },
        select: {
          id: true,
          lines: {
            select: {
              shipment: { select: { id: true, lrNumber: true, currentStatus: true } },
            },
          },
        },
      },
    },
  });

  if (!trip) return [];

  if (trip.ftlShipment) {
    return [
      {
        id: trip.ftlShipment.id,
        lrNumber: trip.ftlShipment.lrNumber,
        manifestId: null,
        currentStatus: trip.ftlShipment.currentStatus as string,
      },
    ];
  }

  return trip.manifests.flatMap((manifest) =>
    manifest.lines.map((line) => ({
      id: line.shipment.id,
      lrNumber: line.shipment.lrNumber,
      manifestId: manifest.id,
      currentStatus: line.shipment.currentStatus as string,
    })),
  );
}
