import "dotenv/config";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let failures = 0;
const report = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log("\nAppend-only enforcement\n");

await client.query("BEGIN");
try {
  await client.query(
    `INSERT INTO audit_log (id, action, entity, "entityId", "createdAt")
     VALUES ('trigger-probe', 'CREATE', 'TriggerProbe', 'probe', now())`,
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
