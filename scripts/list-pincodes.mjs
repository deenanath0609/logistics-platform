/**
 * Lists the pincodes bookings can be made to.
 *
 *   node scripts/list-pincodes.mjs
 */
import "dotenv/config";
import { announceScope, operatorClient } from "./operator-db.mjs";

const client = operatorClient();
await client.connect();
announceScope("Serviceable PIN codes");

const { rows } = await client.query(
  // Grouped by carrier first: geography is per-tenant, so the same PIN
  // legitimately appears once for each company that serves it, and a flat
  // list reads as duplicate rows.
  `SELECT o.subdomain, p.code, p."areaName", c.name AS city, p."isOda",
          p."isServiceable", b.code AS branch
     FROM pincode p
     JOIN city c ON c.id = p."cityId"
     JOIN organization o ON o.id = p."orgId"
     LEFT JOIN branch b ON b.id = p."servingBranchId"
    ORDER BY o.subdomain, c.name, p.code`,
);

console.log(`Pincodes across every network (${rows.length})\n`);
let city = "";
let carrier = "";
for (const r of rows) {
  if (r.subdomain !== carrier) {
    carrier = r.subdomain;
    city = "";
    console.log(`  ${carrier}`);
  }
  if (r.city !== city) {
    city = r.city;
    console.log(`    ${city}`);
  }
  const flags = [
    r.isServiceable ? null : "BLOCKED",
    r.isOda ? "ODA" : null,
  ].filter(Boolean);
  console.log(
    `      ${r.code}  ${String(r.areaName ?? "").padEnd(26)} ${String(r.branch ?? "unassigned").padEnd(9)} ${flags.join(" ")}`,
  );
}
console.log("");

await client.end();
