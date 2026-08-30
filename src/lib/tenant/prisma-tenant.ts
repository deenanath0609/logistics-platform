import type { PrismaClient } from "@/generated/prisma/client";
import {
  isCrossTenantScope,
  isInTenantTransaction,
  TenantContextError,
  TenantReadOnlyError,
} from "@/lib/tenant/context";
import { resolveTenant } from "@/lib/tenant/resolve";
import {
  TENANT_OPTIONAL_MODELS,
  TENANT_SCOPED_MODELS,
} from "@/lib/tenant/scoped-models.generated";
import {
  applyTenant,
  clientKey,
  READ_ONLY_EXEMPT_MODELS,
  WRITE_OPERATIONS,
  type AnyArgs,
} from "@/lib/tenant/scope-args";

/**
 * Tenant isolation, applied to every Prisma call in the application.
 *
 * This is the ergonomic half of the two mechanisms in ADR 001. Callers
 * write `prisma.shipment.findMany({ where: { status: "IN_TRANSIT" } })` and
 * never mention the tenant; the filter is added here. PostgreSQL RLS is the
 * other half, and exists precisely because this half can be bypassed — by
 * raw SQL, by a nested write, by a model that slipped out of the generated
 * list. One of the two being enough is the assumption that turns a bug into
 * a breach, so we run both.
 *
 * Three behaviours are worth knowing about:
 *
 * - **It fails closed.** A scoped query with no tenant established throws,
 *   rather than returning every tenant's rows. Every background job, script
 *   and test therefore has to say which tenant it is acting as.
 * - **It refuses writes for a read-only tenant**, so a suspended account
 *   cannot be written to through a code path that forgot to check.
 * - **It will not let a caller write another tenant's id**, even explicitly.
 */

/**
 * Whether PostgreSQL row-level security is switched on for this deployment.
 *
 * When it is, every scoped statement carries the tenant into the database
 * session so the policies in `scripts/apply-rls.mjs` can see it. That costs
 * a transaction per statement, which is why it is a deployment decision
 * rather than always-on: it belongs wherever the application connects as a
 * non-owner role, and is pointless where it connects as the table owner
 * because RLS does not apply to owners.
 */
const RLS_ENABLED = process.env.TENANT_RLS === "on";

export function withTenantIsolation<T extends PrismaClient>(client: T) {
  return client.$extends({
    name: "tenant-isolation",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const key = clientKey(model);
          const scoped = TENANT_SCOPED_MODELS.has(key);
          const optional = TENANT_OPTIONAL_MODELS.has(key);

          // Child rows isolated through a foreign key, the global tables,
          // and the platform-operator tables all pass through untouched.
          if (!scoped && !optional) return query(args);

          // An explicit, reasoned opt-out — the operator console, the
          // outbox drain, the seed. See runCrossTenant().
          if (isCrossTenantScope()) return query(args);

          const tenant = await resolveTenant();
          if (!tenant) {
            throw new TenantContextError(
              `No tenant context for ${model}.${operation}. Either the request's ` +
                "host does not resolve to an organisation, or this ran outside a " +
                "request without runWithTenant() / runCrossTenant().",
            );
          }

          if (
            tenant.readOnly &&
            WRITE_OPERATIONS.has(operation) &&
            !READ_ONLY_EXEMPT_MODELS.has(key)
          ) {
            throw new TenantReadOnlyError(tenant.orgId);
          }

          // Cast because `query` is typed as the union of every operation's
          // argument shape across every model; the narrowing that would
          // satisfy it is not expressible for a handler that is deliberately
          // generic over all of them.
          const scopedArgs = applyTenant(
            operation,
            args as AnyArgs,
            tenant.orgId,
            optional,
          ) as Parameters<typeof query>[0];

          // Inside an interactive transaction the variable was already set
          // once, at the top — see `tenantTransaction()`. Opening another
          // transaction around this statement would deadlock on the
          // connection it is already holding.
          if (!RLS_ENABLED || isInTenantTransaction()) return query(scopedArgs);

          // TRUE makes the setting local to this transaction, so a pooled
          // connection cannot carry one tenant's id into the next request.
          const [, result] = await client.$transaction([
            client.$executeRaw`SELECT set_config('app.org_id', ${tenant.orgId}, TRUE)`,
            query(scopedArgs),
          ]);
          return result;
        },
      },
    },
  });
}

export type TenantScopedPrisma = ReturnType<typeof withTenantIsolation<PrismaClient>>;
