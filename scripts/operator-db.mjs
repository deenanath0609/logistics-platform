/**
 * The connection the operator diagnostics use.
 *
 * These scripts answer questions about the platform as a whole — is the
 * outbox draining, did booking actually price itself, what are the most
 * recent consignments — so they read across every carrier by design.
 *
 * That means they must not use the application's own connection. Once
 * row-level security is on, the application connects as a role that owns
 * nothing and sees only the tenant named on its session; a diagnostic
 * running as that role would report an empty outbox and a healthy silence.
 * They use the owner connection instead, and say so when they start, so
 * nobody reads a cross-tenant total as one carrier's number.
 */
import pg from "pg";

export function operatorConnectionString() {
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }
  return url;
}

export function operatorClient() {
  return new pg.Client({ connectionString: operatorConnectionString() });
}

/** Printed once, so a cross-tenant total is never mistaken for a tenant's. */
export function announceScope(what) {
  console.log(`\n${what} — every organisation on this platform\n`);
}
