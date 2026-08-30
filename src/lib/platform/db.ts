import { basePrisma } from "@/lib/prisma-base";

/**
 * The database handle for the operator console.
 *
 * Every query in this folder spans tenants by design — a list of carriers,
 * a usage table across all of them, an audit trail that must outlive the
 * tenant it describes. There are two correct ways to say so: wrap the work
 * in `runCrossTenant()`, or go straight to the unextended client. This
 * console uses the unextended client, everywhere, for two reasons:
 *
 * 1. The console renders on `admin.<root>`, a host that resolves to **no**
 *    tenant. The extended client would throw on the first scoped read, so
 *    "declare cross-tenant scope" would not be a choice here so much as a
 *    ceremony performed before every query.
 * 2. The three operator-owned tables that carry `orgId` —
 *    `ImpersonationGrant`, `TenantUsageSnapshot`, `TenantOnboardingTask` —
 *    are already excluded from the tenant extension and from RLS
 *    (`scripts/apply-rls.mjs`, OPERATOR_OWNED). Routing them through a
 *    filter that does not apply to them reads as protection that is not
 *    there.
 *
 * The alias exists so the choice is visible at the call site: `platformDb`
 * says "this is deliberately unfiltered" in a way that `prisma` never
 * could. Nothing outside `lib/platform` should import it.
 */
export const platformDb = basePrisma;

/**
 * A console read that reaches *inside* one named tenant.
 *
 * Most of what the operator does stays above the tenant boundary — the
 * carrier list, the usage table, the audit trail. A few things do not: the
 * "act as" picker has to list a carrier's own staff, and opening a grant
 * has to check that the named user really belongs to the carrier being
 * entered.
 *
 * Those reads are correct, but under row-level security they return
 * nothing, because the console's connection has no tenant set on its
 * session. Naming the tenant here is what makes them work — and it is also
 * the honest description of what they are: not a cross-tenant read, but a
 * read scoped to exactly one carrier the operator has just named.
 *
 * The setting is transaction-local, so a pooled connection cannot carry it
 * into the next request.
 */
export async function readingTenant<T>(
  orgId: string,
  fn: (tx: Omit<typeof basePrisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">) => Promise<T>,
): Promise<T> {
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, TRUE)`;
    return fn(tx);
  });
}
