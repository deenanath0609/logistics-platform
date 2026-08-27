/**
 * Lists the pincodes bookings can be made to.
 *
 *   node scripts/list-pincodes.mjs
 */
import "dotenv/config";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `SELECT p.code, p."areaName", c.name AS city, p."isOda", p."isServiceable",
          b.code AS branch
     FROM pincode p
     JOIN city c ON c.id = p."cityId"
     LEFT JOIN branch b ON b.id = p."servingBranchId"
    ORDER BY c.name, p.code`,
);

console.log(`\nPincodes in the network (${rows.length})\n`);
let city = "";
for (const r of rows) {
  if (r.city !== city) {
    city = r.city;
    console.log(`  ${city}`);
  }
  const flags = [
    r.isServiceable ? null : "BLOCKED",
    r.isOda ? "ODA" : null,
  ].filter(Boolean);
  console.log(
    `    ${r.code}  ${String(r.areaName ?? "").padEnd(26)} ${String(r.branch ?? "unassigned").padEnd(9)} ${flags.join(" ")}`,
  );
}
console.log("");

await client.end();
