/**
 * Everything the web server does at startup that needs Node.
 *
 * Split out of `instrumentation.ts` for a bundler reason rather than a
 * design one: Next builds `instrumentation.ts` for the **edge** runtime as
 * well as for Node, and Turbopack follows dynamic imports when it does. The
 * `NEXT_RUNTIME !== "nodejs"` guard stops this code *running* on the edge; it
 * does not stop it being bundled. So `pg` was traced into the edge bundle,
 * failed to resolve `node:util/types`, and took `/api/health` and every
 * `/api/v1` route down with a 500 that named none of this.
 *
 * One dynamic import of one node-only module is the shape Turbopack
 * tree-shakes out of the edge build. Keep it that way — move an import back
 * up into `instrumentation.ts` and the edge bundle grows a database driver
 * again.
 */
export async function startNodeInstrumentation(): Promise<void> {
  if (process.env.RUN_JOBS_IN_WEB === "true") {
    await runJobsInThisProcess();
    return;
  }

  const { startWorkerWatchdog, START_WORKER_ADVICE } = await import(
    "@/server/services/worker-watchdog"
  );

  console.warn(`
[startup] ${START_WORKER_ADVICE}
`);
  startWorkerWatchdog();
}
/**
 * The opt-in single-process mode.
 *
 * Identical to what this file used to do, and it keeps working, so a
 * deployment that is genuinely one box does not have to run two processes
 * to send an SMS. The handlers are subscribed before the drain starts: the
 * other order leaves a window in which events are marked DONE with nothing
 * listening, and an outbox row is delivered only once.
 */
async function runJobsInThisProcess(): Promise<void> {
  // Names the connections so `scripts/check-pipeline.mjs` can tell a web
  // server that is draining the outbox from a worker that is. Set before
  // the imports below, because the first of them opens the pool.
  process.env.PGAPPNAME ??= "logistics-web-jobs";

  const [outbox, notifications, webhooks, tracking, sla, retention] =
    await Promise.all([
      import("@/server/services/outbox"),
      import("@/lib/notifications/dispatch"),
      import("@/lib/webhooks/dispatch"),
      import("@/lib/tracking/runtime"),
      import("@/lib/sla/scanner"),
      import("@/lib/tracking/retention"),
    ]);

  notifications.registerNotificationDispatch();
  webhooks.registerWebhookDispatch();
  tracking.registerGpsIngestion();
  sla.registerSlaScanner();

  outbox.startOutboxDrain();
  webhooks.startWebhookDispatch();
  tracking.startGpsPolling();
  sla.startSlaScanner();
  retention.startRetentionJob();

  console.warn(
    "[startup] RUN_JOBS_IN_WEB=true — the outbox drain, webhooks, GPS polling, " +
      "the SLA scan and GPS retention are running INSIDE this web server. " +
      "Exactly one instance may do this: a second one duplicates every poll " +
      "and every scan. Prefer `npm run worker`.",
  );
}
