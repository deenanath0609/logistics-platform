/**
 * Reports what the background pipeline has actually done, and who did it.
 *
 *   node scripts/check-pipeline.mjs
 *
 * A queue that never drains and a notification log that never fills both
 * look exactly like a working system from the UI, so this asks the
 * database directly.
 *
 * It also answers the question the process split created. "Is the outbox
 * draining?" used to have one possible answer, because there was one
 * possible drainer: the web server. Now there are three states that look
 * identical from the rows alone — the worker is draining it, a web server
 * with `RUN_JOBS_IN_WEB=true` is draining it, or nobody is and the queue
 * happens to be empty. They call for completely different actions, so the
 * report names which one it is.
 *
 * The evidence is `pg_stat_activity`. Both processes label their
 * connections (`PGAPPNAME`), which means this works from any machine that
 * can reach the database rather than only from the box the worker is on —
 * a heartbeat file would not.
 */
import "dotenv/config";
import { announceScope, operatorClient } from "./operator-db.mjs";

/** Must match `WORKER_APP_NAME` in workers/index.ts. */
const WORKER_APP_NAME = "logistics-worker";
/** Must match the name set by `RUN_JOBS_IN_WEB` in src/instrumentation.ts. */
const WEB_JOBS_APP_NAME = "logistics-web-jobs";

const client = operatorClient();
await client.connect();
announceScope("Outbox and notification pipeline");

const queries = [
  ["Shipments", "SELECT count(*)::int AS n FROM shipment"],
  ["Shipment events", "SELECT count(*)::int AS n FROM shipment_event"],
  ["Audit rows", "SELECT count(*)::int AS n FROM audit_log"],
];

console.log("\nPipeline state\n");

for (const [label, sql] of queries) {
  const { rows } = await client.query(sql);
  console.log(`  ${label.padEnd(24, ".")} ${rows[0].n}`);
}

for (const [label, table] of [
  ["Outbox", "outbox_event"],
  ["Notification log", "notification_log"],
  ["Webhook deliveries", "webhook_delivery"],
]) {
  const { rows } = await client.query(
    `SELECT status, count(*)::int AS n FROM ${table} GROUP BY status ORDER BY status`,
  );
  const summary =
    rows.length === 0
      ? "empty"
      : rows.map((r) => `${r.status} ${r.n}`).join(", ");
  console.log(`  ${label.padEnd(24, ".")} ${summary}`);
}

// ────────────────────────────────────────────────────────────
// Who is draining it
// ────────────────────────────────────────────────────────────

/**
 * Connections each background process has open, and how long the oldest of
 * them has been up.
 *
 * `backend_start` rather than any application-level uptime: it needs no
 * cooperation from the process being asked about, so it still answers for a
 * worker that is wedged and no longer logging.
 */
const { rows: processes } = await client.query(
  `SELECT application_name,
          count(*)::int AS connections,
          floor(extract(epoch FROM now() - min(backend_start)))::int AS oldest_seconds
     FROM pg_stat_activity
    WHERE datname = current_database()
      AND application_name = ANY($1::text[])
    GROUP BY application_name`,
  [[WORKER_APP_NAME, WEB_JOBS_APP_NAME]],
);

const found = new Map(processes.map((row) => [row.application_name, row]));

function uptime(seconds) {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

console.log("\nWho is running the background jobs\n");

for (const [label, name] of [
  ["Background worker", WORKER_APP_NAME],
  ["Jobs inside the web", WEB_JOBS_APP_NAME],
]) {
  const row = found.get(name);
  console.log(
    `  ${label.padEnd(24, ".")} ` +
      (row
        ? `connected — ${row.connections} connection(s), up ${uptime(row.oldest_seconds)}`
        : "not connected") +
      `   [${name}]`,
  );
}

const worker = found.get(WORKER_APP_NAME);
const webJobs = found.get(WEB_JOBS_APP_NAME);

if (worker && webJobs) {
  console.log(
    "\n  ⚠ Both are connected. Two drains are competing for the same rows.\n" +
      "    They will not double-deliver — every claim is guarded — but every\n" +
      "    GPS poll and every SLA scan is running twice. Unset RUN_JOBS_IN_WEB\n" +
      "    on the web server, or stop the worker. Not both.",
  );
}

// ────────────────────────────────────────────────────────────
// Is it keeping up
// ────────────────────────────────────────────────────────────

// A backlog of PENDING rows older than a minute means nothing is draining —
// the single most important thing to notice about this system.
const { rows: stale } = await client.query(
  `SELECT count(*)::int AS n FROM outbox_event
   WHERE status = 'PENDING' AND "createdAt" < now() - interval '1 minute'`,
);

// PROCESSING rows past their claim lease were taken by a process that then
// stopped. The next drain reclaims them, so this is a symptom rather than a
// wound — but a number that keeps growing means something is killing the
// worker mid-pass, and that is worth knowing before a customer finds out.
const { rows: stalled } = await client.query(
  `SELECT count(*)::int AS n FROM outbox_event
   WHERE status = 'PROCESSING' AND "nextAttemptAt" < now()`,
);

console.log("");

if (stalled[0].n > 0) {
  console.log(
    `  ${stalled[0].n} event(s) claimed by a process that stopped before finishing.\n` +
      "    The next drain puts them back. If this number keeps growing, something\n" +
      "    is killing the worker mid-pass — check for an OOM or too short a\n" +
      "    shutdown grace period on the host.",
  );
}

if (stale[0].n === 0) {
  console.log(
    worker || webJobs
      ? "  Drain is keeping up — no stale pending events.\n"
      : "  No stale pending events, but nothing is connected to drain them\n" +
          "    either. An empty queue and a dead pipeline look identical from\n" +
          "    here. Start the worker before you trust this line:\n\n" +
          "        npm run worker\n",
  );
} else if (worker || webJobs) {
  console.log(
    `  ⚠ ${stale[0].n} event(s) pending for over a minute, and a drain IS\n` +
      `    connected (${worker ? WORKER_APP_NAME : WEB_JOBS_APP_NAME}). This is a drain that is failing,\n` +
      "    not a drain that is missing — read its log and the lastError column:\n\n" +
      "        SELECT \"eventType\", attempts, \"lastError\" FROM outbox_event\n" +
      "         WHERE status = 'PENDING' ORDER BY \"createdAt\" LIMIT 20;\n",
  );
} else {
  console.log(
    `  ⚠ ${stale[0].n} event(s) pending for over a minute and NOTHING is\n` +
      "    connected to drain them. No notification is being sent and no\n" +
      "    webhook is firing. Start the worker:\n\n" +
      "        npm run worker\n",
  );
}

await client.end();
