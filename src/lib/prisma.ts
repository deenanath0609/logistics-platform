// The application's Prisma client.
//
// Everything under `src/` imports `prisma` from here, and what it gets is
// the base client wrapped in tenant isolation: every query on a
// tenant-owned model is filtered by the current organisation, and one that
// runs with no tenant established throws rather than returning every
// tenant's rows. See src/lib/tenant/prisma-tenant.ts and
// docs/adr/001-multi-tenancy.md.
//
// Code that legitimately spans tenants — the platform operator console, the
// outbox drain, the seed — declares itself with `runCrossTenant(reason)`
// rather than reaching for `basePrisma`.
import { basePrisma, withAdvisoryLock } from "@/lib/prisma-base";
import { withTenantIsolation } from "@/lib/tenant/prisma-tenant";
import { runInTenantTransaction } from "@/lib/tenant/context";
import { requireTenantOrgId } from "@/lib/tenant/resolve";

export const prisma = withTenantIsolation(basePrisma);

export { basePrisma, withAdvisoryLock };

/**
 * The application's client type, and the transaction client derived from it.
 *
 * An extended client is not the same type as `PrismaClient`, and the client
 * handed to a `$transaction` callback is not the same type as either — it is
 * the extended client minus the methods that cannot run inside a
 * transaction. Service functions that accept "a client or a transaction"
 * need to say so with these rather than `Prisma.TransactionClient`, which
 * describes the unextended client and no longer matches anything the app
 * actually passes.
 */
export type Db = typeof prisma;

export type Tx = Omit<
  Db,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

/** What a service should accept when it may be called inside a transaction. */
export type DbOrTx = Db | Tx;

/**
 * An interactive transaction that row-level security can see into.
 *
 * Use this instead of `prisma.$transaction(fn)` anywhere the callback
 * touches tenant-owned data. It sets the tenant on the session once, at the
 * top, and tells the extension not to wrap each statement in a transaction
 * of its own — which inside an interactive transaction would deadlock on the
 * connection already held.
 *
 * With RLS switched off this is `$transaction` plus one cheap statement, so
 * there is no reason to reach for the plain form.
 */
export async function tenantTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  const orgId = await requireTenantOrgId();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, TRUE)`;
    return runInTenantTransaction(() => fn(tx as Tx));
  }, options);
}
