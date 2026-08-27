/**
 * Reports what the background pipeline has actually done.
 *
 *   node scripts/check-pipeline.mjs
 *
 * A queue that never drains and a notification log that never fills both
 * look exactly like a working system from the UI, so this asks the
 * database directly.
 */
import "dotenv/config";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

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

// A backlog of PENDING rows older than a minute means the drain is not
// running — the single most important thing to notice about this system.
const { rows: stale } = await client.query(
  `SELECT count(*)::int AS n FROM outbox_event
   WHERE status = 'PENDING' AND "createdAt" < now() - interval '1 minute'`,
);

console.log(
  stale[0].n === 0
    ? "\n  Drain is keeping up — no stale pending events.\n"
    : `\n  ⚠ ${stale[0].n} event(s) pending for over a minute. Is the drain running?\n`,
);

await client.end();
