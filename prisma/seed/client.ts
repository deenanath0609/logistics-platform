import "dotenv/config";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

// The owner connection, not the application's.
//
// Once row-level security is on, `DATABASE_URL` points at a restricted role
// that owns nothing and sees only the tenant named on its session. The seed
// has no session and writes across every tenant — it is the thing that
// creates them — so under that role its first `role.create` is refused by
// the policy. Migrations keep the owner connection for the same reason, in
// `MIGRATE_DATABASE_URL`; the seed belongs on the same side of that line.
const pool = new pg.Pool({
  connectionString: process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL,
});

/**
 * A raw client, deliberately not `src/lib/prisma`.
 *
 * Do not "fix" this by importing the app client. That one carries the tenant
 * extension, which injects `orgId` into every write from an ambient request
 * context — and the seed has no request, no host, and no tenant: it is the
 * thing that creates the organisations in the first place. Every write in
 * `prisma/seed/**` therefore passes `orgId` explicitly, and the modules take
 * it as a parameter so that seeding a second tenant is a second call rather
 * than a second copy of the file.
 */
export const db = new PrismaClient({ adapter: new PrismaPg(pool) });

export async function disconnect() {
  await db.$disconnect();
  await pool.end();
}

export function step(label: string) {
  process.stdout.write(`  ${label.padEnd(42, ".")} `);
}

export function done(count: number | string) {
  console.log(typeof count === "number" ? `${count}` : count);
}
