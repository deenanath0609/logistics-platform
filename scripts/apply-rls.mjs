/**
 * The second isolation mechanism: PostgreSQL row-level security.
 *
 *   node scripts/apply-rls.mjs             print the SQL, change nothing
 *   node scripts/apply-rls.mjs --apply     create the role and the policies
 *
 * ADR 001 §1 asks for two independent mechanisms, and this is the one the
 * application cannot bypass. The Prisma extension is the ergonomic layer —
 * it covers every query the ORM issues, which is almost all of them. This
 * covers the rest: raw SQL, a nested write the extension cannot see, a model
 * that somehow escapes the generated registry. One of the two being enough
 * is the assumption that turns a bug into a breach.
 *
 * ── How it works ────────────────────────────────────────────────────────
 *
 * Policies compare `"orgId"` to `current_setting('app.org_id', true)`. When
 * that setting is absent the comparison is NULL, no row matches, and the
 * query returns nothing. It fails closed, like the extension above it.
 *
 * ── Why a second database role ──────────────────────────────────────────
 *
 * RLS does not apply to a table's owner. If the application connects as the
 * role that ran the migrations, every policy here is decoration. So the app
 * gets its own role with no ownership, and migrations keep using the owner.
 *
 * ── Prerequisites, in order ─────────────────────────────────────────────
 *
 * 1. `APP_DB_PASSWORD` set — the password for the application role.
 * 2. Run this with `--apply`.
 * 3. Point the application's `DATABASE_URL` at the new role, leaving the
 *    owner's URL in `MIGRATE_DATABASE_URL` for Prisma Migrate.
 * 4. Set `TENANT_RLS=on` so the client sets `app.org_id` per statement.
 *
 * Doing 3 without 4, or 4 without 3, produces an application that reads
 * nothing. Both are reversible: `--revoke` drops the policies.
 */
import "dotenv/config";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const REVOKE = process.argv.includes("--revoke");
const ROLE = process.env.APP_DB_ROLE ?? "logistics_app";

/**
 * Carry `orgId` but belong to the platform operator, who reads across every
 * tenant by design. Policies here would break the operator console.
 */
const OPERATOR_OWNED = new Set([
  "impersonation_grant",
  "tenant_usage_snapshot",
  "tenant_onboarding_task",
]);

/** `orgId` is nullable by design: the null row is the platform-wide default. */
const SHARED_DEFAULT_ROWS = new Set(["system_config"]);

async function tenantTables(client) {
  const { rows } = await client.query(`
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'orgId'
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  `);
  return rows.map((r) => r.table_name).filter((name) => !OPERATOR_OWNED.has(name));
}

function policySql(table) {
  // A shared default row is readable by every tenant but writable by none:
  // the USING clause lets it through, the WITH CHECK does not.
  const using = SHARED_DEFAULT_ROWS.has(table)
    ? `"orgId" IS NULL OR "orgId" = current_setting('app.org_id', true)`
    : `"orgId" = current_setting('app.org_id', true)`;

  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS tenant_isolation ON "${table}";`,
    `CREATE POLICY tenant_isolation ON "${table}"
       USING (${using})
       WITH CHECK ("orgId" = current_setting('app.org_id', true));`,
  ];
}

function revokeSql(table) {
  return [
    `DROP POLICY IF EXISTS tenant_isolation ON "${table}";`,
    `ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY;`,
  ];
}

function roleSql(password) {
  return [
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
         CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}';
       END IF;
     END $$;`,
    `GRANT USAGE ON SCHEMA public TO ${ROLE};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};`,
    // Tables created by future migrations must be reachable too, or the
    // first deploy after a new model 500s on a permission error.
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE};`,
  ];
}

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    const tables = await tenantTables(client);
    console.log(
      `\n${REVOKE ? "Revoking" : "Applying"} row-level security on ${tables.length} tenant tables\n`,
    );

    const statements = [];

    if (!REVOKE) {
      const password = process.env.APP_DB_PASSWORD;
      if (!password) {
        throw new Error(
          "APP_DB_PASSWORD is not set. RLS is pointless while the application " +
            "connects as the table owner, so the application role is not optional.",
        );
      }
      if (/['\\]/.test(password)) {
        throw new Error("APP_DB_PASSWORD must not contain a quote or a backslash.");
      }
      statements.push(...roleSql(password));
    }

    for (const table of tables) {
      statements.push(...(REVOKE ? revokeSql(table) : policySql(table)));
    }

    if (!APPLY) {
      // The role statement carries a real password. A dry run exists to be
      // read, pasted into a review, and left in a terminal history — so it
      // prints the shape and not the secret.
      const redacted = statements.map((sql) =>
        sql.replace(/PASSWORD '[^']*'/g, "PASSWORD '<APP_DB_PASSWORD>'"),
      );
      console.log(redacted.join("\n"));
      console.log(
        `\n${statements.length} statements. Nothing was changed — re-run with --apply.\n`,
      );
      return;
    }

    await client.query("BEGIN");
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");

    console.log(`  ${statements.length} statements applied.`);
    console.log(
      REVOKE
        ? "\n  Policies dropped. Isolation now rests on the Prisma extension alone.\n"
        : `\n  Next: point DATABASE_URL at ${ROLE}, keep the owner's URL in ` +
            "MIGRATE_DATABASE_URL, and set TENANT_RLS=on.\n",
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exit(1);
});
