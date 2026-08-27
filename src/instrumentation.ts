/**
 * Server startup.
 *
 * Next.js calls `register()` once per server process, before any request is
 * handled. This is where the background machinery is switched on.
 *
 * Without this file the outbox accumulates rows and nothing drains them:
 * every notification stays QUEUED and no webhook ever fires. The engines
 * are written and tested, but subscribing them is a separate act, and it
 * is the kind of omission that looks like a working system right up until
 * a customer asks why they never got the delivery SMS.
 */
export async function register() {
  // The edge runtime has no timers or database access. Only the Node
  // server process runs the drain.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const [{ startOutboxDrain }, notifications, webhooks, tracking, sla, retention] =
    await Promise.all([
      import("@/server/services/outbox"),
      import("@/lib/notifications/dispatch"),
      import("@/lib/webhooks/dispatch"),
      import("@/lib/tracking/runtime"),
      import("@/lib/sla/scanner"),
      import("@/lib/tracking/retention"),
    ]);

  // Subscribe handlers BEFORE starting the drain. Reversing this order
  // leaves a window where events are marked DONE with nothing listening,
  // and an outbox row is only delivered once.
  notifications.registerNotificationDispatch();
  webhooks.registerWebhookDispatch();
  tracking.registerGpsIngestion();
  // Also subscribes to shipment.* so a booking gets its due date at once
  // rather than whenever the next sweep happens to run.
  sla.registerSlaScanner();

  startOutboxDrain();
  webhooks.startWebhookDispatch();
  tracking.startGpsPolling();
  sla.startSlaScanner();
  // Downsamples old GPS fixes rather than deleting them: 1,000 vehicles at
  // 30-second intervals is ~2.9M rows a day, but a detention dispute six
  // months old still needs a usable trail.
  retention.startRetentionJob();

  console.info(
    "[startup] outbox drain running; notifications, webhooks, GPS ingestion, " +
      "the SLA scanner and GPS retention subscribed",
  );
}
