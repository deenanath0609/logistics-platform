import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantStatus } from "@/generated/prisma/client";

/**
 * The tenant a request belongs to.
 *
 * Resolved once, at the edge of the request, and carried implicitly from
 * there. Nothing below this layer takes an `orgId` argument — passing it by
 * hand is how one forgotten parameter becomes a cross-tenant leak, which is
 * the failure this whole layer exists to make impossible.
 *
 * See docs/adr/001-multi-tenancy.md.
 */
export type TenantContext = {
  orgId: string;
  slug: string;
  subdomain: string;
  status: TenantStatus;
  /**
   * How this tenant was established. Kept because the answer changes what
   * is allowed: a tenant resolved from a signed-in user's own row is
   * trusted differently from one an operator opened a support session on.
   */
  source: "host" | "session" | "job" | "impersonation";
  /**
   * Refuses writes. Set for a SUSPENDED tenant (reachable, read-only) and
   * for an operator support session that did not ask for write access.
   */
  readOnly: boolean;
  /** Present only while a platform operator is acting inside the tenant. */
  impersonation?: {
    grantId: string;
    platformAdminId: string;
  };
};

/**
 * Deliberate absence of a tenant.
 *
 * Some work genuinely spans tenants — the platform operator console, the
 * outbox drain, a nightly usage snapshot, the seed. Rather than let those
 * paths run with no context at all (indistinguishable from a bug), they
 * declare themselves, with a reason that shows up in errors and logs.
 */
export type CrossTenantContext = {
  crossTenant: true;
  reason: string;
};

type Store = TenantContext | CrossTenantContext;

const storage = new AsyncLocalStorage<Store>();

function isCrossTenant(store: Store): store is CrossTenantContext {
  return "crossTenant" in store;
}

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

export class TenantReadOnlyError extends Error {
  constructor(public readonly orgId: string) {
    super("This organisation is read-only and cannot accept writes.");
    this.name = "TenantReadOnlyError";
  }
}

/** Runs `fn` with every query inside it scoped to one tenant. */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Runs `fn` with tenant scoping switched off.
 *
 * Every call site is a decision to be able to read every tenant's data, so
 * the reason is required and is not optional documentation — it is what an
 * auditor greps for. Use it for the operator console, background passes
 * that iterate orgs explicitly, and the tenant-resolution query itself.
 */
export function runCrossTenant<T>(reason: string, fn: () => T): T {
  return storage.run({ crossTenant: true, reason }, fn);
}

/** The current tenant, or null when there is none or scoping is off. */
export function currentTenant(): TenantContext | null {
  const store = storage.getStore();
  if (!store || isCrossTenant(store)) return null;
  return store;
}

/** True when the caller has explicitly opted out of tenant scoping. */
export function isCrossTenantScope(): boolean {
  const store = storage.getStore();
  return Boolean(store && isCrossTenant(store));
}

/**
 * The current tenant, or a thrown error.
 *
 * The error is the point. A tenant-scoped query reaching the database with
 * no tenant established must fail loudly, not fall back to "all rows" and
 * not fall back to a default organisation.
 */
export function requireTenant(): TenantContext {
  const store = storage.getStore();
  if (!store) {
    throw new TenantContextError(
      "No tenant context. A tenant-scoped query ran outside a request. " +
        "Wrap it in runWithTenant(), or declare it with runCrossTenant(reason).",
    );
  }
  if (isCrossTenant(store)) {
    throw new TenantContextError(
      `Cross-tenant scope is active (${store.reason}); there is no single tenant to use.`,
    );
  }
  return store;
}

/** The current tenant's id, for code that only needs the id. */
export function currentOrgId(): string {
  return requireTenant().orgId;
}

/**
 * Guard for anything that writes. Called by the Prisma extension on every
 * mutating operation, so a suspended tenant cannot be written to even by a
 * code path that forgot to check.
 */
export function assertTenantWritable(): void {
  const tenant = currentTenant();
  if (tenant?.readOnly) throw new TenantReadOnlyError(tenant.orgId);
}

/**
 * Whether the caller is already inside a transaction that has set the
 * PostgreSQL session variable row-level security reads.
 *
 * The extension sets `app.org_id` per statement by wrapping each query in
 * its own transaction. Inside an interactive `$transaction` that is both
 * wrong and impossible — the statement is already on a connection, in a
 * transaction, and opening another would deadlock. `tenantTransaction()`
 * sets the variable once at the top of the transaction and raises this
 * flag so the extension knows to leave it alone.
 */
const transactionScope = new AsyncLocalStorage<true>();

export function runInTenantTransaction<T>(fn: () => T): T {
  return transactionScope.run(true, fn);
}

export function isInTenantTransaction(): boolean {
  return transactionScope.getStore() === true;
}
