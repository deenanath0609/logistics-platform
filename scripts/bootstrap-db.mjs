/**
 * Creates the logistics database on the local PostgreSQL server if it
 * does not exist, and reports whether PostGIS is available.
 *
 *   node scripts/bootstrap-db.mjs
 *
 * Safe to re-run. Never drops anything.
 */
import "dotenv/config";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
  process.exit(1);
}

const parsed = new URL(url);
const targetDb = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

// Connect to the maintenance database to create the target.
const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";

const admin = new pg.Client({ connectionString: adminUrl.toString() });

try {
  await admin.connect();

  const { rows } = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [targetDb],
  );

  if (rows.length > 0) {
    console.log(`· database "${targetDb}" already exists`);
  } else {
    // Identifiers cannot be parameterised; targetDb comes from our own
    // DATABASE_URL, and we quote it defensively.
    await admin.query(`CREATE DATABASE "${targetDb.replace(/"/g, '""')}"`);
    console.log(`✓ created database "${targetDb}"`);
  }
} catch (error) {
  console.error("✗ could not create database:", error.message);
  process.exit(1);
} finally {
  await admin.end();
}

// Report PostGIS availability. Needed from Phase 7 (geofencing) only,
// so its absence is a warning today, not a failure.
const target = new pg.Client({ connectionString: url });
try {
  await target.connect();

  const { rows } = await target.query(
    "SELECT default_version, installed_version FROM pg_available_extensions WHERE name = 'postgis'",
  );

  if (rows.length === 0) {
    console.log(
      "⚠ PostGIS is not available on this server.\n" +
        "  Not needed until Phase 7 (geofencing). Install PostGIS, or point\n" +
        "  DATABASE_URL at a PostGIS-enabled server, before that phase.",
    );
  } else if (rows[0].installed_version) {
    console.log(`· PostGIS installed (${rows[0].installed_version})`);
  } else {
    await target.query("CREATE EXTENSION IF NOT EXISTS postgis");
    console.log(`✓ enabled PostGIS (${rows[0].default_version})`);
  }
} catch (error) {
  console.log(`⚠ PostGIS check skipped: ${error.message}`);
} finally {
  await target.end();
}
