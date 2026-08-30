import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import { forEachTenant } from "@/lib/tenant/for-each-tenant";
import { onOutbox } from "@/server/services/outbox";
import { getGpsProvider, isSimulated } from "./providers";
import { configureMockJourney, DEFAULT_SPEED_KMPH } from "./providers/mock";
import { ingestPings, trackedDeviceIds } from "./ingest";
import { sweepSignalLoss } from "./monitor";
import {
  LIVE_TRIP_STATUSES,
  invalidateFenceCache,
  invalidateRouteCache,
  plannedRouteForTrip,
} from "./context";

/**
 * Switching the pipeline on.
 *
 * Two entry points, and the split is deliberate. `registerGpsIngestion`
 * subscribes handlers and must run before anything drains; the passes below
 * do the work. Reversing them leaves a window in which events are marked
 * processed with nothing listening, and an outbox row is delivered only
 * once.
 *
 * Neither is called from here. `workers/index.ts` is the one place that
 * decides what runs on a schedule, and a module that starts its own timers
 * on import is a module that starts them in a build, in a test, and in
 * every edge worker that happens to touch it.
 */

const globalForRuntime = globalThis as unknown as {
  gpsPollTimer: NodeJS.Timeout | undefined;
  gpsSweepTimer: NodeJS.Timeout | undefined;
  gpsIngestionRegistered: boolean | undefined;
  gpsPollInFlight: boolean | undefined;
};

/** How often silence is checked for. Slower than polling, by design. */
export const SWEEP_INTERVAL_MS = 5 * 60_000;

/** The configured poll interval, floored so a typo cannot flood a provider. */
export function gpsPollIntervalMs(): number {
  return Math.max(5, getEnv().GPS_POLL_INTERVAL_SECONDS) * 1_000;
}

// ────────────────────────────────────────────────────────────
// Subscriptions
// ────────────────────────────────────────────────────────────

/**
 * Keeps the pipeline's caches honest as the operation moves.
 *
 * A trip that has just gated out gets a fresh route lookup, because the
 * cached "no route yet" from when it was still being planned would
 * otherwise stand for ten minutes — the ten minutes in which its
 * consignments most need an ETA.
 */
export function registerGpsIngestion(): void {
  if (globalForRuntime.gpsIngestionRegistered) return;
  globalForRuntime.gpsIngestionRegistered = true;

  onOutbox("shipment.gate_out", async (event) => {
    const payload = event.payload as { tripId?: string } | null;
    invalidateRouteCache(payload?.tripId);
  });

  onOutbox("shipment.gate_in", async (event) => {
    const payload = event.payload as { tripId?: string } | null;
    invalidateRouteCache(payload?.tripId);
  });
}

// ────────────────────────────────────────────────────────────
// Polling
// ────────────────────────────────────────────────────────────

export type PollResult = {
  devices: number;
  fixes: number;
  accepted: number;
  duplicates: number;
  fenceEvents: number;
  shipmentEvents: number;
  alerts: number;
};

/**
 * One pull from the configured provider, straight into the pipeline, for
 * the **current tenant**.
 *
 * Exported so it can be triggered by hand from the provider screen — a
 * "poll now" button is worth a great deal when somebody is standing next to
 * a newly fitted device wondering whether it works — where the request has
 * already established the tenant. The timer supplies one per organisation.
 *
 * Scoping it this way also keeps the device list honest: `trackedDeviceIds`
 * returns the tenant's own vehicles, so one carrier cannot be handed a fix
 * for another carrier's truck because two fleets happen to share a device
 * id range.
 */
export async function pollOnce(): Promise<PollResult> {
  const env = getEnv();
  const empty: PollResult = {
    devices: 0,
    fixes: 0,
    accepted: 0,
    duplicates: 0,
    fenceEvents: 0,
    shipmentEvents: 0,
    alerts: 0,
  };

  const deviceIds = await trackedDeviceIds();
  if (deviceIds.length === 0) return empty;

  if (isSimulated(env.GPS_PROVIDER)) await seedSimulatedJourneys();

  const provider = getGpsProvider(env.GPS_PROVIDER);
  const fixes = await provider.fetchPositions(deviceIds);
  if (fixes.length === 0) return { ...empty, devices: deviceIds.length };

  const summary = await ingestPings(fixes);

  return {
    devices: deviceIds.length,
    fixes: fixes.length,
    accepted: summary.accepted,
    duplicates: summary.duplicates,
    fenceEvents: summary.fenceEvents,
    shipmentEvents: summary.shipmentEvents,
    alerts: summary.alerts,
  };
}

/**
 * Gives every simulated device a real trip to drive.
 *
 * Without this the mock provider walks a default Delhi–Jaipur lane and the
 * live map shows a fleet that has nothing to do with the trips on the
 * dispatch board. With it, the simulation follows the actual operation:
 * planned route, actual departure time, real origin and destination
 * geofences — which is what makes it a demonstration rather than a toy.
 */
async function seedSimulatedJourneys(): Promise<void> {
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
      plannedDepartureAt: true,
      createdAt: true,
      vehicle: { select: { gpsDeviceId: true } },
    },
  });

  for (const trip of trips) {
    const deviceId = trip.vehicle.gpsDeviceId;
    if (!deviceId) continue;

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

    if (route.points.length < 2) continue;

    configureMockJourney({
      deviceId,
      route: route.points,
      startedAt: trip.actualDepartureAt ?? trip.plannedDepartureAt ?? trip.createdAt,
      speedKmph: DEFAULT_SPEED_KMPH,
    });
  }
}

/**
 * One poll across every tenant.
 *
 * The in-flight guard matters more than it looks: a poll that takes longer
 * than its interval — forty vehicles on a cold connection pool — would
 * otherwise overlap itself, and two passes racing over the same fixes turn
 * a debounce count into a coin toss. It lives inside the pass so it holds
 * however the pass is scheduled. Never throws.
 */
export async function gpsPollPass(): Promise<void> {
  if (globalForRuntime.gpsPollInFlight) return;
  globalForRuntime.gpsPollInFlight = true;

  try {
    const pass = await forEachTenant({ job: "tracking poll" }, () => pollOnce());

    for (const { slug, value } of pass.results) {
      if (value.fenceEvents > 0 || value.shipmentEvents > 0 || value.alerts > 0) {
        console.info(
          `[tracking] ${slug}: ${value.fenceEvents} fence event(s), ${value.shipmentEvents} shipment event(s), ${value.alerts} alert(s)`,
        );
      }
    }
  } catch (error) {
    // A provider timing out for one tenant is caught inside the pass, so
    // this only fires when the organisation list itself is unreadable.
    console.error("[tracking] poll failed", error);
  } finally {
    globalForRuntime.gpsPollInFlight = false;
  }
}

/** One silence sweep across every tenant. Never throws. */
export async function signalLossPass(): Promise<void> {
  try {
    const pass = await forEachTenant({ job: "tracking sweep" }, () =>
      sweepSignalLoss(),
    );

    for (const { slug, value } of pass.results) {
      if (value.raised > 0) {
        console.warn(`[tracking] ${slug}: ${value.raised} vehicle(s) have gone quiet`);
      }
    }
  } catch (error) {
    console.error("[tracking] signal-loss sweep failed", error);
  }
}

/**
 * Starts the poll and the silence sweep inside whatever process calls it.
 *
 * Only reached when `RUN_JOBS_IN_WEB=true`; the worker schedules the two
 * passes itself. Safe to call repeatedly.
 */
export function startGpsPolling(): void {
  if (globalForRuntime.gpsPollTimer) return;

  const env = getEnv();

  globalForRuntime.gpsPollTimer = setInterval(
    () => void gpsPollPass(),
    gpsPollIntervalMs(),
  );
  globalForRuntime.gpsSweepTimer = setInterval(
    () => void signalLossPass(),
    SWEEP_INTERVAL_MS,
  );

  // Do not keep the process alive just to watch an empty yard.
  globalForRuntime.gpsPollTimer.unref?.();
  globalForRuntime.gpsSweepTimer.unref?.();

  console.info(
    `[tracking] polling "${env.GPS_PROVIDER}" every ${env.GPS_POLL_INTERVAL_SECONDS}s; silence sweep every ${SWEEP_INTERVAL_MS / 60_000} min`,
  );
}

export function stopGpsPolling(): void {
  if (globalForRuntime.gpsPollTimer) clearInterval(globalForRuntime.gpsPollTimer);
  if (globalForRuntime.gpsSweepTimer) clearInterval(globalForRuntime.gpsSweepTimer);
  globalForRuntime.gpsPollTimer = undefined;
  globalForRuntime.gpsSweepTimer = undefined;
}

/** Called by the geofence editor so a new fence applies on the next ping. */
export { invalidateFenceCache };
