import "dotenv/config";
import { announceScope, operatorClient } from "./operator-db.mjs";

const client = operatorClient();
await client.connect();
announceScope("Append-only enforcement");

let failures = 0;
const report = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};

await client.query("BEGIN");
try {
  // Every audit row now names the carrier it belongs to, so the probe has to
  // borrow one. Any organisation will do — the whole transaction is rolled
  // back, and what is under test is the trigger, not the row.
  const { rows: orgs } = await client.query(
    `SELECT id FROM organization ORDER BY "createdAt" LIMIT 1`,
  );
  if (!orgs[0]) {
    console.error("  No organisation exists yet — run the seed first.\n");
    process.exit(1);
  }

  await client.query(
    `INSERT INTO audit_log (id, "orgId", action, entity, "entityId", "createdAt")
     VALUES ('trigger-probe', $1, 'CREATE', 'TriggerProbe', 'probe', now())`,
    [orgs[0].id],
  );
  report("INSERT is allowed", true);

  for (const [label, sql] of [
    ["UPDATE is blocked", `UPDATE audit_log SET entity = 'Tampered' WHERE id = 'trigger-probe'`],
    ["DELETE is blocked", `DELETE FROM audit_log WHERE id = 'trigger-probe'`],
  ]) {
    // Each attempt needs its own savepoint: a raised exception aborts the
    // surrounding transaction block otherwise.
    await client.query("SAVEPOINT probe");
    try {
      await client.query(sql);
      report(label, false, "the statement succeeded");
      await client.query("ROLLBACK TO SAVEPOINT probe");
    } catch (error) {
      report(label, true, error.message.split("\n")[0]);
      await client.query("ROLLBACK TO SAVEPOINT probe");
    }
  }

  const { rows } = await client.query(
    `SELECT entity FROM audit_log WHERE id = 'trigger-probe'`,
  );
  report("row survived both attempts unmodified", rows[0]?.entity === "TriggerProbe");
} finally {
  // Undo the probe insert — the table will not let us delete it.
  await client.query("ROLLBACK");
  await client.end();
}

console.log(failures === 0 ? "\nEnforced.\n" : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
