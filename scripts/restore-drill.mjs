/**
 * Proves a backup can be restored — and that the isolation comes back with
 * it.
 *
 *   node scripts/restore-drill.mjs             take a dump, restore it, check
 *   node scripts/restore-drill.mjs --keep      leave the scratch database behind
 *
 * A backup nobody has restored is a hope, not a backup. This one is worth
 * rehearsing for a reason beyond the usual: **`pg_dump` does not dump
 * roles**. Roles are cluster-wide objects and live in `pg_dumpall
 * --globals-only`. So a restore onto a fresh server brings back every table,
 * every row and every policy, and the policies then reference a
 * `logistics_app` role that does not exist. Postgres will not create it for
 * you, the application cannot connect, and — this is the part that should
 * worry somebody — if the operator's instinct at 3am is to make the
 * application connect as the owner instead, every policy in the restored
 * database becomes decoration, because RLS does not apply to a table's
 * owner. The system comes back up looking healthy with its tenant isolation
 * switched off.
 *
 * The drill therefore checks four things in order, and the last two are the
 * ones nobody thinks to check:
 *
 *   1. the dump restores at all;
 *   2. the row counts match, table by table;
 *   3. `rowsecurity` is still on for every tenant-owned table; and
 *   4. every policy is present, and the grants the application role needs
 *      came back with them.
 *
 * It restores into a scratch database on the same server and drops it
 * afterwards. Nothing it does touches the live one.
 *
 * Postgres client tools are found on PATH, or under `PG_BIN`, or in the
 * default Windows install — `pg_dump` is not on PATH in a standard
 * PostgreSQL install on Windows, which is a thirty-second problem the first
 * time and an unpleasant surprise during an actual restore.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const KEEP = process.argv.includes("--keep");

const OWNER_URL = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!OWNER_URL) {
  console.error(
    "MIGRATE_DATABASE_URL is not set. The drill dumps and restores as the " +
      "database owner; the application's restricted role cannot create a " +
      "database or restore a schema.",
  );
  process.exit(1);
}

const APP_ROLE = process.env.APP_DB_ROLE ?? "logistics_app";
const SOURCE_DB = decodeURIComponent(new URL(OWNER_URL).pathname.replace(/^\//, ""));
const SCRATCH_DB = `${SOURCE_DB}_restore_drill`;

let failures = 0;
let passes = 0;

function check(label, ok, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

// ────────────────────────────────────────────────────────────
// Finding the client tools
// ────────────────────────────────────────────────────────────

/**
 * Where `pg_dump` and friends actually are.
 *
 * PATH first, because a developer who has put them there means it. Then
 * `PG_BIN`, then the default Windows install, newest major first — a box
 * with 16 and 17 side by side must not dump a 17 database with 16's
 * `pg_dump`, which refuses rather than producing something subtly wrong.
 */
function toolPath(name) {
  const candidates = [];

  if (process.env.PG_BIN) candidates.push(join(process.env.PG_BIN, name));

  for (const major of [18, 17, 16, 15]) {
    candidates.push(`C:\\Program Files\\PostgreSQL\\${major}\\bin\\${name}.exe`);
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Bare name: let the OS resolve it on PATH, and fail loudly if it cannot.
  return name;
}

function run(tool, args, options = {}) {
  return execFileSync(toolPath(tool), args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    ...options,
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

function urlFor(database) {
  const url = new URL(OWNER_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function query(database, sql, params = []) {
  const client = new pg.Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    const { rows } = await client.query(sql, params);
    return rows;
  } finally {
    await client.end();
  }
}

// ────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `\nRestore drill — "${SOURCE_DB}" → "${SCRATCH_DB}"\n` +
      "  A backup nobody has restored is a hope, not a backup.\n",
  );

  // ── The tools ─────────────────────────────────────────────
  console.log("Tools");
  let version = "";
  try {
    version = run("pg_dump", ["--version"]).trim();
    check("pg_dump is available", true, version);
  } catch {
    check(
      "pg_dump is available",
      false,
      "not on PATH, not under PG_BIN, and not in the default install. " +
        "Set PG_BIN to the bin directory of your PostgreSQL installation.",
    );
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), "logistics-restore-"));
  const dumpFile = join(workDir, `${SOURCE_DB}.dump`);
  const globalsFile = join(workDir, "globals.sql");

  try {
    // ── Take the backup ─────────────────────────────────────
    console.log("\nBackup");

    // Custom format, which is what a real backup should be: it restores
    // selectively and in parallel, and a plain SQL file cannot.
    run("pg_dump", ["--format=custom", "--file", dumpFile, urlFor(SOURCE_DB)]);
    const dumpSize = statSync(dumpFile).size;
    check("a dump was taken", dumpSize > 0, `${(dumpSize / 1024).toFixed(0)} KB`);

    // The half everybody forgets. `--globals-only` is roles and their
    // passwords; without this file the restored policies name a role that
    // does not exist.
    run("pg_dumpall", ["--globals-only", "--file", globalsFile, "--dbname", urlFor("postgres")]);
    const globals = statSync(globalsFile).size;
    check("the cluster's roles were dumped too", globals > 0, `${(globals / 1024).toFixed(0)} KB`);

    // ── What the source looks like ──────────────────────────
    const sourceCounts = await tableCounts(SOURCE_DB);
    const sourcePolicies = await policyCount(SOURCE_DB);
    const sourceSecured = await securedTables(SOURCE_DB);

    console.log(
      `\n  Source: ${sourceCounts.size} tables, ${sourcePolicies} policies, ` +
        `${sourceSecured} tables with row-level security on.\n`,
    );

    // ── Restore ─────────────────────────────────────────────
    console.log("Restore");

    await query("postgres", `DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await query("postgres", `CREATE DATABASE "${SCRATCH_DB}"`);

    // `--no-owner` is deliberately NOT passed. Ownership is what decides
    // whether RLS applies at all, and a restore that quietly reassigns every
    // table to whoever ran it is the failure this drill exists to catch.
    run("pg_restore", ["--dbname", urlFor(SCRATCH_DB), "--exit-on-error", dumpFile]);

    check("the dump restored without error", true);

    // ── Is the data there ───────────────────────────────────
    console.log("\nData");

    const restoredCounts = await tableCounts(SCRATCH_DB);

    check(
      "every table came back",
      restoredCounts.size === sourceCounts.size,
      `${restoredCounts.size} of ${sourceCounts.size}`,
    );

    const mismatched = [];
    for (const [table, count] of sourceCounts) {
      if (restoredCounts.get(table) !== count) {
        mismatched.push(`${table} ${count}→${restoredCounts.get(table) ?? "missing"}`);
      }
    }
    check(
      "every row came back",
      mismatched.length === 0,
      mismatched.slice(0, 5).join(", "),
    );

    // ── Is the isolation there ──────────────────────────────
    console.log("\nIsolation");

    const restoredPolicies = await policyCount(SCRATCH_DB);
    check(
      "every policy came back",
      restoredPolicies === sourcePolicies,
      `${restoredPolicies} of ${sourcePolicies}`,
    );

    const restoredSecured = await securedTables(SCRATCH_DB);
    check(
      "row-level security is still enabled on every table that had it",
      restoredSecured === sourceSecured,
      `${restoredSecured} of ${sourceSecured}`,
    );

    // The role is cluster-wide, so on this server it is still here. On a
    // *fresh* server it would not be, which is the whole point of the
    // globals file above — so this check reports which of the two situations
    // it is looking at rather than passing quietly.
    const roleRows = await query(
      "postgres",
      "SELECT rolname FROM pg_roles WHERE rolname = $1",
      [APP_ROLE],
    );
    check(
      `the application role "${APP_ROLE}" exists`,
      roleRows.length > 0,
      roleRows.length > 0
        ? "on this cluster it survived because roles are cluster-wide; on a new " +
            "server it comes only from the globals file"
        : `restore ${globalsFile} first — the policies below name a role nothing will recreate`,
    );

    const grants = await query(
      SCRATCH_DB,
      `SELECT count(*)::int AS n
         FROM information_schema.role_table_grants
        WHERE grantee = $1 AND privilege_type = 'SELECT'`,
      [APP_ROLE],
    );
    check(
      "the application role can still read the restored tables",
      (grants[0]?.n ?? 0) > 0,
      `${grants[0]?.n ?? 0} table grant(s)`,
    );

    // ── The check that matters most ─────────────────────────
    //
    // Every table restored as owned by the role that ran the restore. If
    // that role is also the one the application connects as, RLS is off in
    // effect and nothing above would have said so.
    const owned = await query(
      SCRATCH_DB,
      `SELECT count(*)::int AS n
         FROM pg_tables
        WHERE schemaname = 'public' AND tableowner = $1`,
      [APP_ROLE],
    );
    check(
      "the application role owns none of the restored tables",
      (owned[0]?.n ?? 0) === 0,
      (owned[0]?.n ?? 0) === 0
        ? "policies apply to it, as intended"
        : `${owned[0].n} table(s) are owned by ${APP_ROLE} — RLS does not apply to a ` +
            "table's owner, so isolation is off in this restore",
    );
  } finally {
    if (!KEEP) {
      await query("postgres", `DROP DATABASE IF EXISTS "${SCRATCH_DB}"`).catch(() => {});
      rmSync(workDir, { recursive: true, force: true });
    } else {
      console.log(`\n  Kept: ${SCRATCH_DB}, and the dump in ${workDir}`);
    }
  }

  console.log(
    "\nThe order a real restore has to happen in:\n" +
      "  1. psql -f globals.sql      the roles, or the policies name nobody\n" +
      "  2. createdb logistics       as the owner, not as the application role\n" +
      "  3. pg_restore --dbname logistics logistics.dump\n" +
      "  4. point DATABASE_URL at the application role, TENANT_RLS=on\n" +
      "  5. run this drill against the restored database before letting traffic in\n",
  );
}

async function tableCounts(database) {
  const tables = await query(
    database,
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );

  const counts = new Map();
  for (const { tablename } of tables) {
    const rows = await query(
      database,
      `SELECT count(*)::int AS n FROM "${tablename.replace(/"/g, '""')}"`,
    );
    counts.set(tablename, rows[0].n);
  }
  return counts;
}

async function policyCount(database) {
  const rows = await query(
    database,
    `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`,
  );
  return rows[0].n;
}

async function securedTables(database) {
  const rows = await query(
    database,
    `SELECT count(*)::int AS n
       FROM pg_tables t
       JOIN pg_class c ON c.relname = t.tablename
      WHERE t.schemaname = 'public' AND c.relrowsecurity`,
  );
  return rows[0].n;
}

main()
  .then(() => {
    console.log(`${passes} passed, ${failures} failed.\n`);
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error("\nThe drill could not complete:\n", error.message ?? error);
    process.exit(1);
  });
