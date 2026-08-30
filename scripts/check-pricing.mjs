/**
 * Did booking actually price itself?
 *
 *   node scripts/check-pricing.mjs
 *
 * A booking that quietly prices at zero looks identical to a working
 * system until the first invoice run. This asks the database whether a
 * FreightCalculation was written and whether a rate card matched.
 */
import "dotenv/config";
import { announceScope, operatorClient } from "./operator-db.mjs";

const client = operatorClient();
await client.connect();
  announceScope("Booking pricing");

const { rows: cards } = await client.query(
  `SELECT count(*)::int AS n FROM rate_card`,
);
const { rows: versions } = await client.query(
  `SELECT count(*)::int AS n FROM rate_card_version WHERE "isApproved" = true`,
);

console.log("\nPricing\n");
console.log(`  Rate cards................ ${cards[0].n}`);
console.log(`  Approved versions......... ${versions[0].n}`);

const { rows: calcs } = await client.query(
  `SELECT stage, count(*)::int AS n FROM freight_calculation GROUP BY stage ORDER BY stage`,
);
console.log(
  `  Freight calculations...... ${
    calcs.length === 0 ? "none" : calcs.map((c) => `${c.stage} ${c.n}`).join(", ")
  }`,
);

const { rows: unrated } = await client.query(
  `SELECT count(*)::int AS n FROM freight_calculation
   WHERE trace->>'unrated' = 'true'`,
);
console.log(`  Of which unrated.......... ${unrated[0].n}`);

const { rows: recent } = await client.query(
  `SELECT s."lrNumber", s."grandTotal",
          (SELECT count(*)::int FROM freight_calculation f WHERE f."shipmentId" = s.id) AS calcs,
          (SELECT count(*)::int FROM shipment_charge c WHERE c."shipmentId" = s.id) AS charges
     FROM shipment s
    WHERE s."deletedAt" IS NULL
    ORDER BY s."bookedAt" DESC
    LIMIT 5`,
);

console.log("\n  Most recent bookings");
for (const r of recent) {
  console.log(
    `    ${r.lrNumber}  ₹${r.grandTotal}  ${r.calcs} calculation(s), ${r.charges} charge line(s)`,
  );
}

if (versions[0].n === 0) {
  console.log(
    "\n  No approved rate card exists yet, so every booking is correctly\n" +
      "  flagged unrated rather than priced at zero. Create one under\n" +
      "  Finance → Rate cards, approve it, and book again.\n",
  );
} else {
  console.log("");
}

await client.end();
