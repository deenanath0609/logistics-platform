import { prisma } from "@/lib/prisma";
import { raiseException } from "@/lib/exceptions/service";
import type { ExceptionKind, TrackingAlertKind } from "@/generated/prisma/client";
import { distanceToPolyline, type LatLng } from "./geo";
import { computeEta, type EtaSample } from "./eta";
import {
  DEFAULT_THRESHOLDS,
  detectDeviation,
  detectSignalLoss,
  detectStoppage,
  type PositionSample,
} from "./alerts";
import {
  LIVE_TRIP_STATUSES,
  plannedRouteForTrip,
  type TripContext,
} from "./context";
import { recordSystemAudit } from "./audit";
import type { NormalizedPing } from "./providers/types";

/**
 * The derive stage, and the sweep that runs on nothing.
 *
 * Deviation, stoppage and ETA are computed from the fixes that just
 * arrived. Signal loss cannot be: no ping arrives to trigger it, which is
 * precisely the condition. It gets its own timer, and that asymmetry is the
 * whole reason SIGNAL_LOST is a first-class alert kind rather than a filter
 * over the ping table — the absence of data is an operational signal, and
 * something has to be watching for nothing (docs/BRD.html §A.9).
 *
 * Every alert here is written twice: a `TrackingAlert` row, which is the
 * transport desk's own record with the distances and durations that caused
 * it, and an `Exception` in the control tower, which is where it gets an
 * owner and an escalation clock. The two are joined by `exceptionId`, and
 * the tower raise is allowed to fail without taking the alert with it —
 * a tower that is misconfigured must not silently lose the deviation.
 */

/** How often the derive stage runs per vehicle, however fast pings arrive. */
const DERIVE_INTERVAL_MS = 3 * 60_000;
/** How often an arrival estimate is snapshotted per trip. */
const ETA_SNAPSHOT_INTERVAL_MINUTES = 10;
/** How far back the alert detectors look. */
const HISTORY_MINUTES = 120;
const HISTORY_LIMIT = 240;

const globalForMonitor = globalThis as unknown as {
  trackingLastDerivedAt: Map<string, number> | undefined;
};

/**
 * How long a vehicle's last-derived stamp is worth keeping.
 *
 * Only used to skip a derive that ran less than `DERIVE_INTERVAL_MS` ago,
 * so anything older than that answers the same question as an absent
 * entry. The worker runs for weeks and the map is keyed by vehicle id, so
 * without a sweep it accumulates one entry per vehicle the fleet has ever
 * had — including every vehicle sold, retired or belonging to a carrier
 * onboarded last spring.
 */
const DERIVED_STAMP_TTL_MS = 10 * DERIVE_INTERVAL_MS;

function derivedAt(): Map<string, number> {
  const map = (globalForMonitor.trackingLastDerivedAt ??= new Map());

  // Swept on the way past rather than on a timer of its own: this is
  // called once per vehicle per ping, and a timer for a housekeeping job
  // this small is a second thing that can stop without anybody noticing.
  const horizon = Date.now() - DERIVED_STAMP_TTL_MS;
  if (map.size > 500) {
    for (const [vehicleId, at] of map) {
      if (at < horizon) map.delete(vehicleId);
    }
  }

  return map;
}

// ────────────────────────────────────────────────────────────
// Derive, on a ping
// ────────────────────────────────────────────────────────────

export type DerivationResult = { alerts: number; etaSnapshots: number };

export async function runDerivations(input: {
  vehicle: { id: string; orgId: string; registrationNumber: string };
  trip: TripContext | null;
  latest: NormalizedPing;
  insideFence: boolean;
}): Promise<DerivationResult> {
  const { vehicle, trip, latest } = input;

  // A vehicle with no trip has nowhere it is supposed to be, so there is
  // nothing to deviate from and no arrival to estimate. Its position is
  // still on the map; it simply raises nothing.
  if (!trip) return { alerts: 0, etaSnapshots: 0 };

  const last = derivedAt().get(vehicle.id) ?? 0;
  if (Date.now() - last < DERIVE_INTERVAL_MS) return { alerts: 0, etaSnapshots: 0 };
  derivedAt().set(vehicle.id, Date.now());

  const since = new Date(latest.recordedAt.getTime() - HISTORY_MINUTES * 60_000);
  const history = await prisma.gpsPing.findMany({
    where: { vehicleId: vehicle.id, recordedAt: { gte: since, lte: latest.recordedAt } },
    orderBy: { recordedAt: "asc" },
    take: HISTORY_LIMIT,
    select: { latitude: true, longitude: true, speedKmph: true, recordedAt: true },
  });

  const samples: PositionSample[] = history.map((row) => ({
    at: row.recordedAt,
    point: { lat: Number(row.latitude), lng: Number(row.longitude) },
    speedKmph: row.speedKmph === null ? null : Number(row.speedKmph),
    // Approximated from the vehicle's fence set as it stands now. Storing a
    // fence set per ping would be exact and would double the width of the
    // hottest table in the system for a detail that changes an alert
    // boundary by one polling interval.
    insideFence: input.insideFence,
  }));

  const route = await plannedRouteForTrip(trip);
  const point: LatLng = { lat: latest.lat, lng: latest.lng };

  let alerts = 0;

  // ── Route deviation ───────────────────────────────────────
  // Only against a route worth measuring: a straight line between two
  // branches is not a road, and holding a truck to it would raise a
  // deviation on every lane that bends.
  if (route.quality === "polyline" || route.quality === "branches") {
    const distances = samples.map((sample) => distanceToPolyline(sample.point, route.points));
    const threshold =
      route.quality === "branches"
        ? { ...DEFAULT_THRESHOLDS, deviationMetres: DEFAULT_THRESHOLDS.deviationMetres * 10 }
        : DEFAULT_THRESHOLDS;

    const finding = detectDeviation(distances, threshold);
    if (finding) {
      const raised = await raiseAlert({
        kind: "ROUTE_DEVIATION",
        vehicle,
        trip,
        point,
        detectedAt: latest.recordedAt,
        deviationMetres: finding.worstMetres,
        title: `${vehicle.registrationNumber} is ${formatKm(finding.worstMetres)} off the planned route`,
        detail: `${finding.consecutive} consecutive fixes more than ${formatKm(threshold.deviationMetres)} from the lane for trip ${trip.number}.`,
        details: { consecutive: finding.consecutive, routeQuality: route.quality },
      });
      if (raised) alerts++;
    } else {
      await resolveAlerts(vehicle.id, "ROUTE_DEVIATION", "back on the planned route");
    }
  }

  // ── Stoppage ──────────────────────────────────────────────
  const stoppage = detectStoppage(samples, DEFAULT_THRESHOLDS, latest.recordedAt);
  if (stoppage) {
    const raised = await raiseAlert({
      kind: "STOPPAGE",
      vehicle,
      trip,
      point: stoppage.at,
      detectedAt: latest.recordedAt,
      durationMinutes: stoppage.minutes,
      title: `${vehicle.registrationNumber} has been stationary for ${formatMinutes(stoppage.minutes)}`,
      detail: `Stopped since ${stoppage.since.toISOString()} outside any known geofence, on trip ${trip.number}.`,
      details: { since: stoppage.since.toISOString() },
    });
    if (raised) alerts++;
  } else {
    await resolveAlerts(vehicle.id, "STOPPAGE", "moving again");
  }

  // Pings are arriving, so any open silence alert is over.
  await resolveAlerts(vehicle.id, "SIGNAL_LOST", "pings resumed");

  // ── Arrival estimate ──────────────────────────────────────
  const etaSnapshots = await snapshotEta({
    trip,
    point,
    now: latest.recordedAt,
    history: samples.map<EtaSample>((s) => ({ at: s.at, point: s.point })),
    route: route.points,
  });

  return { alerts, etaSnapshots };
}

// ────────────────────────────────────────────────────────────
// ETA snapshots
// ────────────────────────────────────────────────────────────

async function snapshotEta(input: {
  trip: TripContext;
  point: LatLng;
  now: Date;
  history: EtaSample[];
  route: LatLng[];
}): Promise<number> {
  const cutoff = new Date(input.now.getTime() - ETA_SNAPSHOT_INTERVAL_MINUTES * 60_000);
  const recent = await prisma.etaSnapshot.findFirst({
    where: { tripId: input.trip.id, computedAt: { gte: cutoff } },
    select: { id: true },
  });
  if (recent) return 0;

  const eta = computeEta({
    now: input.now,
    position: input.point,
    route: input.route,
    history: input.history,
  });

  // Only a real estimate is stored. "We could not say" is a fact worth
  // showing on a screen but not worth a row per trip per ten minutes for
  // the life of the trip — and a snapshot table full of non-answers makes
  // "what did we promise?" harder to answer, not easier.
  if (!eta.ok) return 0;

  await prisma.etaSnapshot.create({
    data: {
      // The trip this estimate is about owns it.
      orgId: input.trip.orgId,
      tripId: input.trip.id,
      estimatedArrivalAt: eta.estimatedArrivalAt,
      remainingKm: eta.remainingKm.toFixed(2),
      averageSpeedKmph: eta.averageSpeedKmph.toFixed(2),
      method: "gps",
      confidence: eta.confidence,
      computedAt: input.now,
    },
  });

  return 1;
}

// ────────────────────────────────────────────────────────────
// Alerts
// ────────────────────────────────────────────────────────────

const EXCEPTION_KIND: Partial<Record<TrackingAlertKind, ExceptionKind>> = {
  ROUTE_DEVIATION: "ROUTE_DEVIATION",
  STOPPAGE: "VEHICLE_STOPPED",
  SIGNAL_LOST: "NO_GPS_UPDATE",
};

/**
 * Writes an alert, unless the same one is already open.
 *
 * Without the open-alert check this fires every polling interval for as
 * long as the condition lasts: a truck stopped overnight becomes nine
 * hundred rows, and the transport desk stops opening the screen. One row
 * per occurrence, resolved when the condition clears.
 */
async function raiseAlert(input: {
  kind: TrackingAlertKind;
  vehicle: { id: string; orgId: string; registrationNumber: string };
  trip: TripContext | null;
  point: LatLng | null;
  detectedAt: Date;
  title: string;
  detail: string;
  deviationMetres?: number;
  durationMinutes?: number;
  speedKmph?: number;
  details?: Record<string, unknown>;
}): Promise<boolean> {
  const open = await prisma.trackingAlert.findFirst({
    where: { vehicleId: input.vehicle.id, kind: input.kind, resolvedAt: null },
    select: { id: true },
  });
  if (open) return false;

  let exceptionId: string | null = null;
  const kind = EXCEPTION_KIND[input.kind];

  if (kind) {
    try {
      const raised = await raiseException({
        orgId: input.vehicle.orgId,
        kind,
        title: input.title,
        detail: input.detail,
        tripId: input.trip?.id ?? null,
        vehicleId: input.vehicle.id,
        branchId: input.trip?.originBranchId ?? null,
        detectedAt: input.detectedAt,
        source: "gps",
        // Stable for as long as this occurrence lasts: the tower gets one
        // row, not one every three minutes.
        dedupeKey: `gps:${input.kind}:${input.vehicle.id}:${input.trip?.id ?? "none"}:${Math.floor(
          input.detectedAt.getTime() / (60 * 60_000),
        )}`,
      });
      exceptionId = raised.exception.id;
    } catch (error) {
      // The tower is not available — very likely a missing number series.
      // The alert still lands; somebody still sees it.
      console.error("[tracking] could not raise exception for alert", error);
    }
  }

  const alert = await prisma.trackingAlert.create({
    data: {
      // Same source the exception above was raised against, so an alert and
      // its exception cannot end up in two different tenants.
      orgId: input.vehicle.orgId,
      kind: input.kind,
      vehicleId: input.vehicle.id,
      tripId: input.trip?.id ?? undefined,
      latitude: input.point?.lat ?? undefined,
      longitude: input.point?.lng ?? undefined,
      deviationMetres: input.deviationMetres ?? undefined,
      durationMinutes: input.durationMinutes ?? undefined,
      speedKmph: input.speedKmph ?? undefined,
      detectedAt: input.detectedAt,
      exceptionId: exceptionId ?? undefined,
      details: {
        title: input.title,
        detail: input.detail,
        ...(input.details ?? {}),
      },
    },
    select: { id: true },
  });

  await recordSystemAudit({
    action: "CREATE",
    entity: "TrackingAlert",
    entityId: alert.id,
    entityRef: `${input.kind} ${input.vehicle.registrationNumber}`,
    orgId: input.vehicle.orgId,
    after: {
      kind: input.kind,
      vehicle: input.vehicle.registrationNumber,
      trip: input.trip?.number ?? null,
      title: input.title,
      exceptionId,
    },
    reason: "Detected from GPS",
  });

  return true;
}

/** Closes any open alert of this kind for a vehicle. */
async function resolveAlerts(
  vehicleId: string,
  kind: TrackingAlertKind,
  reason: string,
): Promise<number> {
  const { count } = await prisma.trackingAlert.updateMany({
    where: { vehicleId, kind, resolvedAt: null },
    data: { resolvedAt: new Date() },
  });

  if (count > 0) {
    await recordSystemAudit({
      action: "UPDATE",
      entity: "TrackingAlert",
      entityId: vehicleId,
      entityRef: `${kind} resolved`,
      after: { kind, resolved: count, reason },
      reason: `Condition cleared: ${reason}`,
    });
  }

  return count;
}

// ────────────────────────────────────────────────────────────
// Signal loss sweep
// ────────────────────────────────────────────────────────────

export type SweepResult = { checked: number; raised: number; resolved: number };

/**
 * Looks for vehicles that have gone quiet.
 *
 * Runs on a timer rather than on a ping, because the whole point is that no
 * ping is arriving. Scoped to vehicles on live trips: a truck parked in the
 * yard with a device switched off is not an operational problem, and
 * alerting on it would bury the one in transit that has genuinely dropped
 * off the map.
 */
export async function sweepSignalLoss(now = new Date()): Promise<SweepResult> {
  const trips = await prisma.trip.findMany({
    where: { status: { in: [...LIVE_TRIP_STATUSES] } },
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
      vehicle: { select: { registrationNumber: true, gpsDeviceId: true, orgId: true } },
    },
  });

  let raised = 0;
  let resolved = 0;
  let checked = 0;

  for (const trip of trips) {
    // A vehicle with no device fitted is not silent, it is untracked. That
    // is a fleet-master fact, not an alert repeated every five minutes for
    // the length of the trip.
    if (!trip.vehicle.gpsDeviceId) continue;
    checked++;

    const location = await prisma.vehicleLocation.findUnique({
      where: { vehicleId: trip.vehicleId },
      select: { recordedAt: true, latitude: true, longitude: true },
    });

    const finding = detectSignalLoss(location?.recordedAt ?? null, now);

    if (!finding) {
      // Either it is reporting, or it has never reported at all. Neither is
      // an open silence alert.
      resolved += await resolveAlerts(trip.vehicleId, "SIGNAL_LOST", "pings resumed");
      continue;
    }

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

    const wasRaised = await raiseAlert({
      kind: "SIGNAL_LOST",
      vehicle: {
        id: trip.vehicleId,
        orgId: trip.vehicle.orgId,
        registrationNumber: trip.vehicle.registrationNumber,
      },
      trip: context,
      point:
        location && location.latitude != null && location.longitude != null
          ? { lat: Number(location.latitude), lng: Number(location.longitude) }
          : null,
      detectedAt: now,
      durationMinutes: finding.minutesSilent,
      title: `No GPS from ${trip.vehicle.registrationNumber} for ${formatMinutes(finding.minutesSilent)}`,
      detail: `Trip ${trip.number} is running and the device has not reported since ${
        location?.recordedAt?.toISOString() ?? "never"
      }.`,
      details: { lastSeenAt: location?.recordedAt?.toISOString() ?? null },
    });

    if (wasRaised) raised++;
  }

  return { checked, raised, resolved };
}

// ────────────────────────────────────────────────────────────

function formatKm(metres: number): string {
  return metres >= 1_000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
