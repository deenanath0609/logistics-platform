// The unextended Prisma client.
//
// Almost nothing should import this. Application code imports `prisma` from
// `@/lib/prisma`, which is this client wrapped in tenant isolation. This
// module exists for the three things that legitimately run before or
// outside a tenant: resolving which tenant a host belongs to, the platform
// operator console, and migrations/seeds.
//
// Import from `client` rather than the folder: prisma generate does not
// emit an index barrel, and adding one by hand is wiped on regeneration.
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const globalForPrisma = globalThis as unknown as {
  basePrisma: PrismaClient | undefined;
  pgPool: pg.Pool | undefined;
};

function createPrismaClient() {
  const pool =
    globalForPrisma.pgPool ??
    new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX ?? 20),
      min: Number(process.env.DB_POOL_MIN ?? 2),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

  if (process.env.NODE_ENV !== "production") globalForPrisma.pgPool = pool;

  return new PrismaClient({
    adapter: new PrismaPg(pool),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const basePrisma = globalForPrisma.basePrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.basePrisma = basePrisma;

/**
 * Postgres advisory-lock helper.
 *
 * Document numbering must never hand two clerks the same LR number,
 * so the counter read/increment runs inside a transaction holding a
 * lock keyed on the series. The lock releases when the transaction
 * commits or rolls back.
 */
export async function withAdvisoryLock<T>(
  tx: Pick<PrismaClient, "$executeRaw">,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  // hashtext() maps the key to an int4 that pg_advisory_xact_lock accepts.
  // $executeRaw because the function returns void, which the driver adapter
  // cannot deserialise as a result column.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  return fn();
}
