/**
 * Shows the most recently booked shipments with their direct URLs.
 *
 *   node scripts/latest-shipments.mjs [count]
 */
import "dotenv/config";
import pg from "pg";

const count = Number(process.argv[2] ?? 5);
const base = process.env.APP_URL ?? "http://localhost:3010";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `SELECT s.id, s."lrNumber", s."currentStatus", s."bookedAt", s.mode,
          s."consignorName", s."consigneeName", s."packageCount",
          s."chargeableWeight", s."grandTotal", s."paymentType",
          o.code AS origin, d.code AS destination,
          u.name AS booked_by,
          (SELECT count(*)::int FROM shipment_event e WHERE e."shipmentId" = s.id) AS events
     FROM shipment s
     JOIN branch o ON o.id = s."originBranchId"
     JOIN branch d ON d.id = s."destinationBranchId"
     LEFT JOIN app_user u ON u.id = s."bookedById"
    WHERE s."deletedAt" IS NULL
    ORDER BY s."bookedAt" DESC
    LIMIT $1`,
  [count],
);

if (rows.length === 0) {
  console.log("\nNo shipments yet.\n");
} else {
  console.log(`\nMost recent ${rows.length} shipment(s)\n`);
  for (const r of rows) {
    const when = new Date(r.bookedAt).toLocaleString("en-IN");
    console.log(`  ${r.lrNumber}   ${r.mode}   ${r.currentStatus}`);
    console.log(`    ${r.origin} → ${r.destination} · ${r.consignorName} → ${r.consigneeName}`);
    console.log(`    ${r.packageCount} pkg · ${r.chargeableWeight} kg · ₹${r.grandTotal} · ${r.paymentType}`);
    console.log(`    booked ${when} by ${r.booked_by ?? "portal customer"} · ${r.events} event(s)`);
    console.log(`    internal : ${base}/shipments/${r.id}`);
    console.log(`    print LR : ${base}/shipments/${r.id}/print`);
    console.log(`    public   : ${base}/track/${r.lrNumber}`);
    console.log("");
  }
}

await client.end();
