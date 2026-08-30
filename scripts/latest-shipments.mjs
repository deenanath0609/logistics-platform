/**
 * Shows the most recently booked shipments with their direct URLs.
 *
 *   node scripts/latest-shipments.mjs [count]
 */
import "dotenv/config";
import { announceScope, operatorClient } from "./operator-db.mjs";

const count = Number(process.argv[2] ?? 5);
// Links are built per carrier, not from one base URL: every consignment
// lives on its owner's own host, and a link to the wrong one 404s.
const rootDomain = process.env.APP_ROOT_DOMAIN ?? "localhost";
const fallback = process.env.APP_URL ?? "http://localhost:3010";
const { protocol, port } = (() => {
  try {
    const u = new URL(fallback);
    return { protocol: u.protocol.replace(":", ""), port: u.port };
  } catch {
    return { protocol: "http", port: "3010" };
  }
})();
const originFor = (org) =>
  `${protocol}://${org.customDomain ?? `${org.subdomain}.${rootDomain}`}${port ? `:${port}` : ""}`;

const client = operatorClient();
await client.connect();
announceScope("Recent consignments");

const { rows } = await client.query(
  `SELECT s.id, s."lrNumber", s."currentStatus", s."bookedAt", s.mode,
          s."consignorName", s."consigneeName", s."packageCount",
          s."chargeableWeight", s."grandTotal", s."paymentType",
          o.code AS origin, d.code AS destination,
          u.name AS booked_by,
          org.subdomain, org."customDomain",
          (SELECT count(*)::int FROM shipment_event e WHERE e."shipmentId" = s.id) AS events
     FROM shipment s
     JOIN branch o ON o.id = s."originBranchId"
     JOIN branch d ON d.id = s."destinationBranchId"
     LEFT JOIN app_user u ON u.id = s."bookedById"
     JOIN organization org ON org.id = s."orgId"
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
    const base = originFor(r);
    console.log(`  ${r.lrNumber}   ${r.mode}   ${r.currentStatus}   [${r.subdomain}]`);
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
