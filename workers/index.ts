/**
 * The background worker.
 *
 *   npm run worker          # tsx watch, for development
 *   node --import tsx workers/index.ts
 *
 * Everything this platform does on a schedule happens here, in a process of
 * its own: the outbox drain, webhook delivery, GPS polling and its
 * signal-loss sweep, the SLA scan, and GPS retention.
 *
 * ─── Why it is not in the web server ────────────────────────────────────
 *
 * It used to be, started from `src/instrumentation.ts`. Three things were
 * wrong with that, and none of them show up until the day they matter:
 *
 *  · A deploy or a crash of the web tier stopped all five. The queue does
 *    not stop filling because the drain stopped; it fills faster.
 *  · Every web instance ran its own copy. Two instances meant two GPS polls
 *    per interval per tenant, two SLA scans, and two dispatchers racing for
 *    the same webhook deliveries.
 *  · Nothing could be scaled, restarted or reasoned about on its own. "Is
 *    the drain running?" had no answer that was not "is any web server up?"
 *
 * ─── Why it is still a timer and not a queue ───────────────────────────
 *
 * There is no Redis on this machine and no way to run one, so `REDIS_URL`
 * points at a port nothing is listening on. Writing BullMQ wiring now would
 * mean shipping code that has never been executed. The process boundary is
 * the part that can be built and proved today, so it is the part that was
 * built; the queue swap is a documented, single-file change waiting for a
 * Redis that exists. See docs/adr/002-background-worker.md, which names
 * exactly which file changes and what stays the same.
 *
 * ─── Tenancy ───────────────────────────────────────────────────────────
 *
 * Not one job here holds a view of every carrier's rows. Each pass
 * enumerates organisations through `forEachTenant`, which runs the work
 * inside each tenant's own context, so one tenant's failure cannot stop the
 * rest and no query can accidentally span them. See
 * docs/adr/001-multi-tenancy.md.
 */
import "dotenv/config";
import { Supervisor, type Job } from "./supervisor";

/**
 * How this process identifies itself on its database connections.
 *
 * Set before anything opens the pool — `pg` reads `PGAPPNAME` when it
 * builds connection parameters — which is why every application import
 * below is dynamic. It is what lets `scripts/check-pipeline.mjs` answer
 * "is the *worker* draining the outbox, or is a web server doing it?"
 * against `pg_stat_activity`, from any machine that can reach the database.
 */
export const WORKER_APP_NAME = "logistics-worker";

/**
 * How long a shutdown waits for in-flight passes.
 *
 * Thirty seconds because that is what most orchestrators allow between
 * SIGTERM and SIGKILL; there is no point promising more than the platform
 * will give us. An outbox pass is a batch of fifty per tenant and finishes
 * in well under that.
 */
const SHUTDOWN_GRACE_MS = Number(process.env.WORKER_SHUTDOWN_GRACE_MS ?? 30_000);

function humanInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

async function main(): Promise<void> {
  process.env.PGAPPNAME ??= WORKER_APP_NAME;

  const [outbox, notifications, webhooks, tracking, sla, retention, prismaBase, env] =
    await Promise.all([
      import("@/server/services/outbox"),
      import("@/lib/notifications/dispatch"),
      import("@/lib/webhooks/dispatch"),
      import("@/lib/tracking/runtime"),
      import("@/lib/sla/scanner"),
      import("@/lib/tracking/retention"),
      import("@/lib/prisma-base"),
      import("@/lib/env"),
    ]);

  // Subscribe handlers BEFORE the first drain. Reversing this order leaves
  // a window in which events are marked DONE with nothing listening, and an
  // outbox row is only ever delivered once.
  notifications.registerNotificationDispatch();
  webhooks.registerWebhookDispatch();
  tracking.registerGpsIngestion();
  // Also subscribes to shipment.*, so a booking gets its due date the
  // moment it is created rather than whenever the next sweep happens.
  sla.registerSlaScanner();

  const gpsPollMs = tracking.gpsPollIntervalMs();
  const retentionMs = retention.retentionIntervalMs();

  const jobs: Job[] = [
    {
      name: "outbox drain",
      everyMs: outbox.DRAIN_INTERVAL_MS,
      run: outbox.outboxPass,
    },
    {
      name: "webhook delivery",
      everyMs: webhooks.DISPATCH_INTERVAL_MS,
      run: webhooks.webhookPass,
    },
    {
      name: "GPS poll",
      everyMs: gpsPollMs,
      run: tracking.gpsPollPass,
    },
    {
      name: "GPS signal-loss sweep",
      everyMs: tracking.SWEEP_INTERVAL_MS,
      run: tracking.signalLossPass,
    },
    {
      name: "SLA scan",
      everyMs: sla.SCAN_INTERVAL_MS,
      run: sla.slaPass,
    },
    {
      name: "GPS retention",
      everyMs: retentionMs,
      firstRunDelayMs: retention.FIRST_RUN_DELAY_MS,
      run: retention.retentionPass,
    },
  ];

  banner(jobs, {
    provider: env.getEnv().GPS_PROVIDER,
    retention: retention.retentionBanner(retentionMs),
  });

  const supervisor = new Supervisor();
  supervisor.start(jobs);

  installShutdown(supervisor, prismaBase.disconnectDb);
}

function banner(
  jobs: readonly Job[],
  detail: { provider: string; retention: string },
): void {
  const width = Math.max(...jobs.map((job) => job.name.length)) + 2;
  const database = (process.env.DATABASE_URL ?? "").replace(/\/\/[^@]*@/, "//");

  const lines = [
    "",
    "──────────────────────────────────────────────────────────────",
    `  City Logistics — background worker   pid ${process.pid}   ${process.version}`,
    `  ${database || "DATABASE_URL is not set"}`,
    "──────────────────────────────────────────────────────────────",
    ...jobs.map((job) => {
      const first = job.firstRunDelayMs
        ? `  (first run in ${humanInterval(job.firstRunDelayMs)})`
        : "";
      return `  ${job.name.padEnd(width, ".")} every ${humanInterval(job.everyMs)}${first}`;
    }),
    "",
    `  GPS provider: ${detail.provider}`,
    `  ${detail.retention}`,
    "",
    "  Handlers subscribed: notifications, webhook fan-out, GPS ingestion, SLA",
    "  Every pass runs once per tenant, inside that tenant's own context.",
    `  Ctrl-C or SIGTERM stops scheduling and waits up to ${humanInterval(SHUTDOWN_GRACE_MS)}`,
    "  for the pass already running, so no outbox row is left claimed.",
    "──────────────────────────────────────────────────────────────",
    "",
  ];

  console.info(lines.join("\n"));
}

/**
 * Turns a signal into an orderly stop.
 *
 * The disconnect only happens on a clean shutdown. If the grace window
 * expired there is still a query in flight, and closing the pool underneath
 * it is exactly the tearing-out this is meant to avoid — better to let the
 * process end and Postgres reclaim the connection than to raise a
 * connection error inside a half-finished pass.
 */
function installShutdown(
  supervisor: Supervisor,
  disconnect: () => Promise<void>,
): void {
  let started = false;

  const stop = async (reason: string) => {
    if (started) {
      console.warn(`[worker] already shutting down (${reason}); waiting.`);
      return;
    }
    started = true;

    const running = supervisor.running();
    console.info(
      `[worker] ${reason} — no new passes will start` +
        (running.length > 0 ? `; waiting for ${running.join(", ")}` : ""),
    );

    const report = await supervisor.shutdown(SHUTDOWN_GRACE_MS);

    if (report.clean) {
      await disconnect();
      console.info("[worker] stopped cleanly.");
      process.exit(0);
    }

    console.error(
      `[worker] grace window expired with ${report.abandoned.join(", ")} still running. ` +
        "Anything claimed and unfinished is recovered by the outbox claim lease " +
        "on the next start.",
    );
    process.exit(1);
  };

  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  // Windows cannot deliver a catchable SIGTERM to a child process, so the
  // end-to-end proof in `scripts/verify-worker.ts` forks this file and asks
  // for the shutdown over the IPC channel instead. Same function, same
  // guarantee — only the way the request arrives differs.
  process.on("message", (message) => {
    if (message === "shutdown") void stop("shutdown requested");
  });
}

void main().catch((error: unknown) => {
  console.error("[worker] failed to start", error);
  process.exit(1);
});
