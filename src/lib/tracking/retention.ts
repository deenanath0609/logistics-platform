import { prisma } from "@/lib/prisma";

/**
 * GPS retention.
 *
 * `gps_ping` is the fastest-growing table in the system by an order of
 * magnitude: a thousand vehicles reporting every thirty seconds is about
 * 2.9 million rows a day, a billion a year. Left alone it eventually costs
 * more to index than the rest of the database put together.
 *
 * The obvious fix — delete anything older than ninety days — throws away
 * the one thing the table is for. A detention claim or an insurance
 * dispute surfaces months after the trip, and "we no longer hold the
 * trail" is a worse answer than a slightly coarse trail. So the policy has
 * three bands rather than two:
 *
 *   · hot     `recordedAt >= now - GPS_RETENTION_DAYS` (default 90)
 *             every fix, untouched. Live map, ETA, geofence debounce and
 *             recent replay all read from here.
 *
 *   · cold    between the retention and archive horizons
 *             downsampled to one fix per five minutes per device, plus
 *             every ignition transition. A five-minute trail still draws a
 *             recognisable route and still shows where a vehicle stood
 *             still for three hours, which is what a detention argument
 *             turns on.
 *
 *   · expired `recordedAt < now - GPS_ARCHIVE_DAYS` (default 400)
 *             deleted. Four hundred days covers a full financial year plus
 *             the month it takes anyone to notice.
 *
 * Two structural decisions matter as much as the policy:
 *
 *  1. **The selection is pure.** `planRetention` takes a set of pings and a
 *     window and says which survive. No clock, no database, no deletion —
 *     which is what makes it testable, and what makes "does this pass
 *     destroy data?" a question with an answer rather than an opinion.
 *
 *  2. **The writes are batched and never transactional.** A retention pass
 *     runs against the hottest table in the system while vehicles are
 *     still reporting into it. Holding one transaction over a million-row
 *     delete would block ingestion for as long as it took and bloat the
 *     table besides. Every delete here is a bounded `deleteMany` by
 *     primary key with a pause between batches, so the pass is
 *     interruptible at any point and simply resumes on the next run.
 *
 * Not wired up here. `src/instrumentation.ts` is the one place that
 * decides what a server process runs; `startRetentionJob()` is exported
 * for it to call.
 */

// ────────────────────────────────────────────────────────────
// Policy
// ────────────────────────────────────────────────────────────

export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_ARCHIVE_DAYS = 400;

/**
 * The downsampled resolution. Five minutes at 60 km/h is five kilometres —
 * coarse enough to shed 90% of the rows, fine enough that the surviving
 * trail still follows the road rather than cutting across the map.
 */
export const DOWNSAMPLE_BUCKET_MINUTES = 5;

/** Rows deleted per statement. Small enough never to hold a lock long. */
const DELETE_BATCH = 1_000;

/** Rows read per page while planning. */
const SCAN_BATCH = 5_000;

/** Breathing room between write batches, so ingestion keeps its turn. */
const PAUSE_MS = 25;

/** A pass gives up after this long and resumes on the next run. */
const DEFAULT_BUDGET_MS = 10 * 60_000;

/**
 * Reads a positive whole number from `process.env`, rather than from
 * `src/lib/env.ts`.
 *
 * Both settings are operational knobs with safe defaults, and a bad value
 * falls back rather than refusing to boot: a typo in
 * `GPS_RETENTION_DAYS` must not be the reason a dispatch server fails to
 * start at five in the morning. It is logged instead.
 */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    console.warn(
      `[tracking] ${name}="${raw}" is not a positive whole number; using ${fallback}.`,
    );
    return fallback;
  }
  return value;
}

export type RetentionPolicy = {
  /** Days of full-resolution pings. */
  retentionDays: number;
  /** Days after which a ping is deleted outright. */
  archiveDays: number;
  /** Downsampled resolution, in minutes. */
  bucketMinutes: number;
};

export function retentionPolicy(
  overrides: Partial<RetentionPolicy> = {},
): RetentionPolicy {
  const retentionDays =
    overrides.retentionDays ?? envPositiveInt("GPS_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
  let archiveDays =
    overrides.archiveDays ?? envPositiveInt("GPS_ARCHIVE_DAYS", DEFAULT_ARCHIVE_DAYS);

  // An archive horizon inside the retention horizon would mean "delete the
  // hot data", which is never what anybody meant to configure. Refuse the
  // deletion rather than perform it.
  if (archiveDays <= retentionDays) {
    console.warn(
      `[tracking] GPS_ARCHIVE_DAYS (${archiveDays}) must exceed GPS_RETENTION_DAYS (${retentionDays}); nothing will be deleted this pass.`,
    );
    archiveDays = Number.POSITIVE_INFINITY;
  }

  return {
    retentionDays,
    archiveDays,
    bucketMinutes: overrides.bucketMinutes ?? DOWNSAMPLE_BUCKET_MINUTES,
  };
}

// ────────────────────────────────────────────────────────────
// The pure selection
// ────────────────────────────────────────────────────────────

/**
 * The columns the decision actually depends on. Deliberately narrow: a
 * plan that cannot see latitude cannot be accused of deciding on it.
 */
export type RetainablePing = {
  id: string;
  deviceId: string;
  recordedAt: Date;
  /** Ignition transitions survive downsampling — see `planRetention`. */
  ignition?: boolean | null;
};

export type RetentionWindow = {
  /** Everything is measured back from here. */
  now: Date;
  retentionDays: number;
  archiveDays: number;
  bucketMinutes: number;
};

export function windowFor(
  policy: RetentionPolicy,
  now: Date = new Date(),
): RetentionWindow {
  return {
    now,
    retentionDays: policy.retentionDays,
    archiveDays: policy.archiveDays,
    bucketMinutes: policy.bucketMinutes,
  };
}

const DAY_MS = 86_400_000;

export type RetentionCutoffs = {
  /** Pings at or after this are hot and untouched. */
  hot: Date;
  /** Pings before this are deleted. */
  archive: Date;
};

export function cutoffsFor(window: RetentionWindow): RetentionCutoffs {
  const hot = new Date(window.now.getTime() - window.retentionDays * DAY_MS);
  const archive = Number.isFinite(window.archiveDays)
    ? new Date(window.now.getTime() - window.archiveDays * DAY_MS)
    : new Date(-8_640_000_000_000_000); // The earliest date JS can hold.
  return { hot, archive };
}

/**
 * Which five-minute slot a fix falls in.
 *
 * Aligned to the epoch rather than to the first ping seen, so the bucket a
 * ping belongs to is a property of the ping alone. That is what makes a
 * second pass over the survivors a no-op instead of a slow grind towards
 * one row per device.
 */
export function bucketKey(recordedAt: Date, bucketMinutes: number): number {
  const size = Math.max(1, bucketMinutes) * 60_000;
  return Math.floor(recordedAt.getTime() / size);
}

/**
 * Carried between pages so a device's trail can be planned in chunks
 * without a bucket straddling the boundary being counted twice.
 */
export type RetentionCarry = {
  /** Last bucket already represented by a survivor, per device. */
  lastBucket: Map<string, number>;
  /** Last ignition state seen, per device. */
  lastIgnition: Map<string, boolean | null>;
};

export function emptyCarry(): RetentionCarry {
  return { lastBucket: new Map(), lastIgnition: new Map() };
}

export type RetentionPlan = {
  /** Hot pings, plus the cold ones chosen to represent their bucket. */
  keep: string[];
  /** Cold pings dropped by downsampling. */
  downsample: string[];
  /** Pings past the archive horizon. */
  expire: string[];
  /** Feed into the next page for the same device. */
  carry: RetentionCarry;
};

/**
 * Given a set of pings and a window, which survive?
 *
 * Three bands, applied in this order:
 *
 *  1. Older than the archive horizon → `expire`. Nothing else is
 *     considered; an expired ping is not a candidate for anything.
 *  2. Inside the retention horizon → `keep`, untouched.
 *  3. In between → one survivor per device per bucket, plus every
 *     ignition transition.
 *
 * The survivor is the *earliest* ping in the bucket, not the median or a
 * sample: earliest is a total order over the input, so the choice does not
 * change when the same rows are replayed in a different page size, and a
 * pass that is interrupted halfway resumes to exactly the same answer.
 *
 * Ignition transitions are kept because a downsampled trail is used to
 * settle detention: "the vehicle switched off at 14:02 and did not move
 * until 17:40" is the claim, and a five-minute grid that happens to miss
 * both edges turns a provable fact into an argument. They cost almost
 * nothing — a transition is rare by definition.
 */
export function planRetention(
  pings: readonly RetainablePing[],
  window: RetentionWindow,
  carry: RetentionCarry = emptyCarry(),
): RetentionPlan {
  const { hot, archive } = cutoffsFor(window);

  const keep: string[] = [];
  const downsample: string[] = [];
  const expire: string[] = [];

  // Sorted rather than assumed sorted. The caller pages by device and
  // time, but a plan that silently depends on its input order is a plan
  // that breaks the first time someone reads with a different `orderBy`.
  const ordered = [...pings].sort((a, b) => {
    if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
    const byTime = a.recordedAt.getTime() - b.recordedAt.getTime();
    if (byTime !== 0) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const lastBucket = new Map(carry.lastBucket);
  const lastIgnition = new Map(carry.lastIgnition);

  for (const ping of ordered) {
    const at = ping.recordedAt.getTime();

    if (at < archive.getTime()) {
      expire.push(ping.id);
      continue;
    }

    if (at >= hot.getTime()) {
      keep.push(ping.id);
      // The hot band still advances the ignition state: a transition that
      // straddles the retention horizon must not be invented on the next
      // pass, when the same ping has gone cold.
      lastIgnition.set(ping.deviceId, ping.ignition ?? null);
      continue;
    }

    const bucket = bucketKey(ping.recordedAt, window.bucketMinutes);
    const previousBucket = lastBucket.get(ping.deviceId);
    const previousIgnition = lastIgnition.has(ping.deviceId)
      ? (lastIgnition.get(ping.deviceId) ?? null)
      : undefined;

    const ignition = ping.ignition ?? null;
    const firstOfBucket = previousBucket !== bucket;
    const ignitionChanged =
      previousIgnition !== undefined && ignition !== previousIgnition;

    if (firstOfBucket || ignitionChanged) {
      keep.push(ping.id);
      lastBucket.set(ping.deviceId, bucket);
    } else {
      downsample.push(ping.id);
    }

    lastIgnition.set(ping.deviceId, ignition);
  }

  return { keep, downsample, expire, carry: { lastBucket, lastIgnition } };
}

/**
 * How much a plan removes, as a fraction. Used by the pass log — a policy
 * change that suddenly starts removing 99% of the trail should be visible
 * in the logs rather than discovered in a dispute.
 */
export function reductionRatio(plan: Pick<RetentionPlan, "keep" | "downsample" | "expire">): number {
  const total = plan.keep.length + plan.downsample.length + plan.expire.length;
  if (total === 0) return 0;
  return (plan.downsample.length + plan.expire.length) / total;
}

// ────────────────────────────────────────────────────────────
// The pass
// ────────────────────────────────────────────────────────────

export type RetentionSummary = {
  startedAt: Date;
  finishedAt: Date;
  policy: RetentionPolicy;
  cutoffs: RetentionCutoffs;
  /** Devices with cold data considered this pass. */
  devices: number;
  /** Cold pings read. */
  scanned: number;
  /** Cold pings kept as the trail. */
  kept: number;
  /** Cold pings removed by downsampling. */
  downsampled: number;
  /** Pings removed for being past the archive horizon. */
  expired: number;
  /** Delete statements issued. */
  batches: number;
  /** True when the budget ran out before the work did. */
  truncated: boolean;
};

export type RetentionOptions = Partial<RetentionPolicy> & {
  /** Overridable for tests; defaults to the wall clock. */
  now?: Date;
  /** Stop and report rather than run for ever. */
  budgetMs?: number;
  /** Plan and report without deleting anything. */
  dryRun?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deletes by primary key, a bounded batch at a time.
 *
 * Never wrapped in a transaction. The batches are independent — losing the
 * process between two of them leaves the table consistent and the next
 * pass simply finishes the job, because `planRetention` is deterministic
 * and will select the same rows again.
 */
async function deleteInBatches(ids: readonly string[]): Promise<number> {
  let batches = 0;
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const slice = ids.slice(i, i + DELETE_BATCH);
    await prisma.gpsPing.deleteMany({ where: { id: { in: slice } } });
    batches++;
    if (i + DELETE_BATCH < ids.length) await sleep(PAUSE_MS);
  }
  return batches;
}

/**
 * One retention pass.
 *
 * Expiry first, downsampling second: the cheapest way to shrink the table
 * is to drop what nobody may look at again, and doing it first means the
 * downsample scan has less to walk.
 */
export async function runRetentionPass(
  options: RetentionOptions = {},
): Promise<RetentionSummary> {
  const startedAt = new Date();
  const policy = retentionPolicy(options);
  const window = windowFor(policy, options.now ?? startedAt);
  const cutoffs = cutoffsFor(window);
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  const summary: RetentionSummary = {
    startedAt,
    finishedAt: startedAt,
    policy,
    cutoffs,
    devices: 0,
    scanned: 0,
    kept: 0,
    downsampled: 0,
    expired: 0,
    batches: 0,
    truncated: false,
  };

  // ── Expiry ────────────────────────────────────────────────
  // Paged by id rather than deleted in one statement: `deleteMany` with a
  // date predicate over four hundred days of pings is a single enormous
  // transaction, which is exactly what this module exists to avoid.
  if (Number.isFinite(policy.archiveDays)) {
    for (;;) {
      if (Date.now() > deadline) {
        summary.truncated = true;
        break;
      }

      const doomed = await prisma.gpsPing.findMany({
        where: { recordedAt: { lt: cutoffs.archive } },
        orderBy: { recordedAt: "asc" },
        take: DELETE_BATCH,
        select: { id: true },
      });
      if (doomed.length === 0) break;

      if (!options.dryRun) {
        await prisma.gpsPing.deleteMany({
          where: { id: { in: doomed.map((row) => row.id) } },
        });
        summary.batches++;
      }
      summary.expired += doomed.length;

      if (options.dryRun) break; // Nothing was removed; the page repeats.
      await sleep(PAUSE_MS);
    }
  }

  // ── Downsampling ──────────────────────────────────────────
  // Device by device, because the unique index is `(deviceId, recordedAt)`
  // and a per-device time scan rides it exactly. A global scan ordered by
  // time would interleave every vehicle in the fleet and make the carry
  // between pages meaningless.
  const devices = await prisma.gpsPing.groupBy({
    by: ["deviceId"],
    where: { recordedAt: { gte: cutoffs.archive, lt: cutoffs.hot } },
  });
  summary.devices = devices.length;

  for (const { deviceId } of devices) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      break;
    }

    let carry = emptyCarry();
    let cursor: Date = cutoffs.archive;

    for (;;) {
      if (Date.now() > deadline) {
        summary.truncated = true;
        break;
      }

      const page = await prisma.gpsPing.findMany({
        where: {
          deviceId,
          recordedAt: { gte: cursor, lt: cutoffs.hot },
        },
        orderBy: { recordedAt: "asc" },
        take: SCAN_BATCH,
        select: { id: true, deviceId: true, recordedAt: true, ignition: true },
      });
      if (page.length === 0) break;

      const plan = planRetention(page, window, carry);
      carry = plan.carry;

      summary.scanned += page.length;
      summary.kept += plan.keep.length;
      summary.downsampled += plan.downsample.length;

      if (!options.dryRun && plan.downsample.length > 0) {
        summary.batches += await deleteInBatches(plan.downsample);
      }

      if (page.length < SCAN_BATCH) break;

      // `(deviceId, recordedAt)` is unique, so the next page starts one
      // millisecond after the last row read — no cursor row is skipped and
      // none is read twice.
      const last = page[page.length - 1].recordedAt;
      const next = new Date(last.getTime() + 1);
      if (next <= cursor) break; // Defensive: never loop on the same page.
      cursor = next;

      await sleep(PAUSE_MS);
    }
  }

  summary.finishedAt = new Date();
  return summary;
}

// ────────────────────────────────────────────────────────────
// The timer
// ────────────────────────────────────────────────────────────

const globalForRetention = globalThis as unknown as {
  gpsRetentionTimer: NodeJS.Timeout | undefined;
  gpsRetentionStartTimer: NodeJS.Timeout | undefined;
  gpsRetentionInFlight: boolean | undefined;
};

/** Once a day is plenty: a day's arrears is a rounding error at this scale. */
const DEFAULT_INTERVAL_HOURS = 24;

/**
 * Waited out before the first pass, so a server that has just come up
 * spends its first minutes serving the depot rather than pruning history.
 */
const FIRST_RUN_DELAY_MS = 5 * 60_000;

function intervalMs(): number {
  const hours = envPositiveInt("GPS_RETENTION_INTERVAL_HOURS", DEFAULT_INTERVAL_HOURS);
  return hours * 3_600_000;
}

/**
 * Starts the daily retention pass. Safe to call repeatedly.
 *
 * Not called from this module, and deliberately not from an import side
 * effect: `src/instrumentation.ts` decides what a process runs, and a
 * module that starts its own timers starts them in builds, in tests, and
 * in every worker that happens to touch it.
 */
export function startRetentionJob(): void {
  if (globalForRetention.gpsRetentionTimer) return;

  const run = async () => {
    if (globalForRetention.gpsRetentionInFlight) return;
    globalForRetention.gpsRetentionInFlight = true;
    try {
      const summary = await runRetentionPass();
      if (summary.downsampled > 0 || summary.expired > 0 || summary.truncated) {
        console.info(
          `[tracking] retention: ${summary.downsampled.toLocaleString("en-IN")} ping(s) downsampled, ` +
            `${summary.expired.toLocaleString("en-IN")} expired, ` +
            `${summary.kept.toLocaleString("en-IN")} kept across ${summary.devices} device(s)` +
            (summary.truncated ? " — budget reached, resuming next pass" : ""),
        );
      }
    } catch (error) {
      console.error("[tracking] retention pass failed", error);
    } finally {
      globalForRetention.gpsRetentionInFlight = false;
    }
  };

  const every = intervalMs();

  globalForRetention.gpsRetentionStartTimer = setTimeout(() => {
    void run();
    globalForRetention.gpsRetentionTimer = setInterval(() => void run(), every);
    globalForRetention.gpsRetentionTimer.unref?.();
  }, FIRST_RUN_DELAY_MS);
  globalForRetention.gpsRetentionStartTimer.unref?.();

  // Claim the slot immediately so a second call during the delay window
  // cannot schedule a second timer.
  globalForRetention.gpsRetentionTimer =
    globalForRetention.gpsRetentionStartTimer;

  const policy = retentionPolicy();
  console.info(
    `[tracking] GPS retention every ${every / 3_600_000}h: full resolution for ${policy.retentionDays} days, ` +
      `then one fix per ${policy.bucketMinutes} min` +
      (Number.isFinite(policy.archiveDays)
        ? `, deleted after ${policy.archiveDays} days`
        : ", nothing deleted"),
  );
}

export function stopRetentionJob(): void {
  if (globalForRetention.gpsRetentionStartTimer) {
    clearTimeout(globalForRetention.gpsRetentionStartTimer);
  }
  if (globalForRetention.gpsRetentionTimer) {
    clearInterval(globalForRetention.gpsRetentionTimer);
  }
  globalForRetention.gpsRetentionStartTimer = undefined;
  globalForRetention.gpsRetentionTimer = undefined;
}
