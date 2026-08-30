import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import { forEachTenant } from "@/lib/tenant/for-each-tenant";
import { onOutbox } from "@/server/services/outbox";
import { getGpsProvider, isSimulated } from "./providers";
import { isDue, resolvePollProviders } from "./providers/resolve";
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

export type PollFailure = {
  /** The adapter code that failed, for the operator reading the message. */
  code: string;
  message: string;
};

export type PollResult = {
  devices: number;
  fixes: number;
  accepted: number;
  duplicates: number;
  fenceEvents: number;
  shipmentEvents: number;
  alerts: number;
  /** Vendors actually pulled from on this pass. */
  providers: number;
  /** Vendors whose own interval had not elapsed yet. */
  skipped: number;
  /** Vendors that threw. The others were still polled. */
  failures: PollFailure[];
};

export type PollOptions = {
  /**
   * Ignore each vendor's own interval and pull now.
   *
   * The "poll now" button sets this: somebody standing beside a newly fitted
   * device is asking whether it works, and answering "not for another four
   * minutes" is not an answer.
   */
  force?: boolean;
};

const EMPTY_POLL: PollResult = {
  devices: 0,
  fixes: 0,
  accepted: 0,
  duplicates: 0,
  fenceEvents: 0,
  shipmentEvents: 0,
  alerts: 0,
  providers: 0,
  skipped: 0,
  failures: [],
};

/**
 * One pull from **this carrier's own** telematics vendors, straight into
 * the pipeline.
 *
 * Exported so it can be triggered by hand from the provider screen — a
 * "poll now" button is worth a great deal when somebody is standing next to
 * a newly fitted device wondering whether it works — where the request has
 * already established the tenant. The timer supplies one per organisation.
 *
 * Scoping it this way keeps the device list honest: `trackedDeviceIds`
 * returns the tenant's own vehicles, so one carrier cannot be handed a fix
 * for another carrier's truck because two fleets happen to share a device
 * id range. `resolvePollProviders` extends the same rule to the account the
 * fixes are pulled *from* — whose vendor, whose key, whose bill — which
 * until now was one environment variable serving every carrier at once.
 *
 * One vendor's failure is recorded against its row and returned in
 * `failures`; it never stops the others. A carrier on two telematics
 * contracts must not lose half their live map because one vendor is down,
 * and an unknown adapter code — which `getGpsProvider` refuses rather than
 * silently simulating — is the same kind of news.
 */
export async function pollOnce(options: PollOptions = {}): Promise<PollResult> {
  const deviceIds = await trackedDeviceIds();
  if (deviceIds.length === 0) return { ...EMPTY_POLL, failures: [] };

  const configured = await resolvePollProviders();
  const result: PollResult = { ...EMPTY_POLL, devices: deviceIds.length, failures: [] };
  const now = new Date();

  for (const entry of configured) {
    if (!options.force && !isDue(entry, now)) {
      result.skipped += 1;
      continue;
    }

    // Only the simulated adapter gets journeys seeded, and only when it is
    // this carrier's adapter. Seeding on a real vendor's pass would write
    // mock routes for a fleet whose positions are genuine.
    if (isSimulated(entry.code)) await seedSimulatedJourneys();

    try {
      const provider = getGpsProvider(entry.code, entry.credentials);
      const fixes = await provider.fetchPositions(deviceIds);
      result.providers += 1;

      if (fixes.length > 0) {
        const summary = await ingestPings(fixes);
        result.fixes += fixes.length;
        result.accepted += summary.accepted;
        result.duplicates += summary.duplicates;
        result.fenceEvents += summary.fenceEvents;
        result.shipmentEvents += summary.shipmentEvents;
        result.alerts += summary.alerts;
      }

      await noteContact(entry.configId, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Poll failed";
      result.failures.push({ code: entry.code, message });
      console.error(`[tracking] provider "${entry.code}" failed to poll`, error);
      await noteContact(entry.configId, message);
    }
  }

  return result;
}

/**
 * Records the outcome on the provider row, the way the webhook does.
 *
 * `lastPolledAt` is what the due check reads on the next tick, so a vendor
 * that failed is deliberately *not* stamped: it stays due and is retried
 * rather than being parked for its own interval because it was unreachable
 * once. The two fallbacks have no row and nothing to record.
 *
 * Never throws: noting why a poll failed must not be why the next one does.
 */
async function noteContact(
  configId: string | null,
  error: string | null,
): Promise<void> {
  if (!configId) return;

  try {
    await prisma.trackingProviderConfig.update({
      where: { id: configId },
      data: error
        ? { lastError: error.slice(0, 500) }
        : { lastPolledAt: new Date(), lastError: null },
    });
  } catch (updateError) {
    console.error("[tracking] could not record the poll outcome", updateError);
  }
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

      // A vendor that cannot be reached is this carrier's news, not a
      // silent zero on their live map. `pollOnce` has already written it to
      // the provider row, where their own staff can see it; this line is so
      // it is also in the log the operator reads.
      for (const failure of value.failures) {
        console.warn(
          `[tracking] ${slug}: provider "${failure.code}" did not answer — ${failure.message}`,
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

  // The interval is the tick, not the vendor's schedule: each carrier's own
  // provider rows carry their own interval and are skipped on the ticks in
  // between, so this line names the floor rather than the frequency. The
  // provider named is only the fallback for a carrier with no vendor of
  // their own — see `resolvePollProviders`.
  console.info(
    `[tracking] polling every ${env.GPS_POLL_INTERVAL_SECONDS}s, per carrier, ` +
      `falling back to "${env.GPS_PROVIDER}" where none is configured; ` +
      `silence sweep every ${SWEEP_INTERVAL_MS / 60_000} min`,
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
