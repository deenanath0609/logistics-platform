import type { PrismaClient } from "@/generated/prisma/client";
import { isCrossTenantScope, TenantContextError, TenantReadOnlyError } from "@/lib/tenant/context";
import { resolveTenant } from "@/lib/tenant/resolve";
import {
  TENANT_OPTIONAL_MODELS,
  TENANT_SCOPED_MODELS,
} from "@/lib/tenant/scoped-models.generated";

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

const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

/** `model Shipment` is reached as `prisma.shipment`. */
function clientKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

type AnyArgs = Record<string, unknown> | undefined;

/**
 * Adds the tenant predicate under `AND` rather than spreading it into the
 * top level. Spreading would silently clobber a caller's own `AND`, and a
 * top-level `OR` would escape a spread predicate entirely — the filter has
 * to bind tighter than anything the caller wrote.
 *
 * The caller's own top-level keys are preserved, which is what lets this
 * work on `findUnique`/`update`/`delete`, where Prisma still needs to see a
 * unique field at the top of `where`.
 */
function mergeWhere(
  where: unknown,
  filter: Record<string, unknown>,
): Record<string, unknown> {
  const current = (where ?? {}) as Record<string, unknown>;
  const existing = current.AND;
  const and = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  return { ...current, AND: [...and, filter] };
}

/**
 * A null `orgId` on `SystemConfig` is the platform-wide default, which every
 * tenant may read but none may edit — hence the asymmetry: reads match the
 * tenant's own rows *or* the shared default, writes always stamp the tenant.
 */
function readFilter(orgId: string, optional: boolean): Record<string, unknown> {
  return optional ? { OR: [{ orgId }, { orgId: null }] } : { orgId };
}

function assertNoForeignOrg(data: unknown, orgId: string): void {
  if (!data || typeof data !== "object") return;
  const given = (data as Record<string, unknown>).orgId;
  if (given !== undefined && given !== null && given !== orgId) {
    throw new TenantContextError(
      `Refusing to write a row for organisation ${String(given)} while acting as ${orgId}.`,
    );
  }
}

function stampCreate(data: unknown, orgId: string): unknown {
  if (Array.isArray(data)) return data.map((row) => stampCreate(row, orgId));
  if (!data || typeof data !== "object") return data;
  assertNoForeignOrg(data, orgId);
  return { ...(data as Record<string, unknown>), orgId };
}

function applyTenant(
  operation: string,
  rawArgs: AnyArgs,
  orgId: string,
  optional: boolean,
): AnyArgs {
  const args: Record<string, unknown> = { ...(rawArgs ?? {}) };
  const filter = readFilter(orgId, optional);

  switch (operation) {
    case "create":
      args.data = stampCreate(args.data, orgId);
      return args;

    case "createMany":
    case "createManyAndReturn":
      args.data = stampCreate(args.data, orgId);
      return args;

    case "upsert":
      assertNoForeignOrg(args.update, orgId);
      args.where = mergeWhere(args.where, filter);
      args.create = stampCreate(args.create, orgId);
      return args;

    case "update":
    case "updateMany":
    case "updateManyAndReturn":
      assertNoForeignOrg(args.data, orgId);
      args.where = mergeWhere(args.where, filter);
      return args;

    case "findUnique":
    case "findUniqueOrThrow":
    case "findFirst":
    case "findFirstOrThrow":
    case "findMany":
    case "delete":
    case "deleteMany":
    case "count":
    case "aggregate":
    case "groupBy":
      args.where = mergeWhere(args.where, filter);
      return args;

    default:
      // An operation this code has not seen. Refusing is the only safe
      // answer: passing it through unfiltered is exactly the leak the
      // extension exists to prevent.
      throw new TenantContextError(
        `Unrecognised Prisma operation "${operation}" on a tenant-scoped model; ` +
          "the tenant filter could not be applied.",
      );
  }
}

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

          if (tenant.readOnly && WRITE_OPERATIONS.has(operation)) {
            throw new TenantReadOnlyError(tenant.orgId);
          }

          return query(
            applyTenant(operation, args as AnyArgs, tenant.orgId, optional),
          );
        },
      },
    },
  });
}

export type TenantScopedPrisma = ReturnType<typeof withTenantIsolation<PrismaClient>>;
