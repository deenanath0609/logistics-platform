import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { isTenantModel } from "./models";

/**
 * The tenant-scoped Prisma client.
 *
 * Layer one of three. Isolation is not left to 118 files remembering to
 * write `orgId` into a where clause — the one that forgets is the one that
 * ships. This extension puts it there, and refuses the query outright when
 * it cannot.
 *
 * The other two layers, deliberately independent of this one:
 *
 *   2. Row-level security in Postgres, so a raw query, a psql session, or
 *      a future ORM cannot read across tenants even with this bypassed.
 *   3. Host-based tenant resolution plus a session cross-check, so a valid
 *      session for tenant A presented on tenant B's host is refused before
 *      any query runs at all.
 *
 * A leak needs all three to fail, and they fail for different reasons.
 *
 * ## Why findUnique becomes findFirst
 *
 * Prisma's `findUnique` accepts only unique fields in `where`, so
 * `{ id, orgId }` will not typecheck or run. Leaving `findUnique` alone
 * would mean any row fetched by id — which is most detail pages — comes
 * back regardless of who owns it. The operation is therefore rewritten to
 * `findFirst`, which takes the same argument shape and accepts the extra
 * filter. Same index, same plan, one row.
 */

/** Operations whose `where` we filter. */
const FILTERED = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "updateMany",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** Operations that create rows and must be stamped with the tenant. */
const CREATING = new Set(["create", "createMany", "createManyAndReturn"]);

/**
 * Operations addressing one row by unique key. Rewritten so the tenant
 * filter can be applied, since a unique `where` will not accept it.
 */
const BY_UNIQUE: Record<string, string> = {
  findUnique: "findFirst",
  findUniqueOrThrow: "findFirstOrThrow",
};

/**
 * Single-row writes by unique key.
 *
 * These cannot be rewritten the way reads can — `updateMany` returns a
 * count rather than the row, and callers use the row. They are instead
 * checked: the tenant filter is added to `where`, which Prisma accepts on
 * `update`/`delete` as long as a unique field is present alongside it.
 */
const SINGLE_WRITE = new Set(["update", "delete", "upsert"]);

export class CrossTenantError extends Error {
  constructor(
    public readonly model: string,
    public readonly operation: string,
  ) {
    super(
      `Refused a ${operation} on ${model} without a tenant. This is a bug: ` +
        `use the client from forTenant(orgId), never the bare prisma client, ` +
        `for anything a tenant owns.`,
    );
    this.name = "CrossTenantError";
  }
}

function withOrg(where: unknown, orgId: string): Record<string, unknown> {
  return { ...((where as Record<string, unknown>) ?? {}), orgId };
}

/**
 * Returns a client that can only see one tenant's rows.
 *
 * Cached per `orgId`: `$extends` builds a new client, and building one per
 * request would leak the connection-pool bookkeeping that hangs off it.
 * The extension itself is stateless, so sharing is safe.
 */
const clientCache = new Map<string, TenantClient>();

export type TenantClient = ReturnType<typeof buildTenantClient>;

function buildTenantClient(orgId: string) {
  return prisma.$extends({
    name: `tenant:${orgId}`,
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          if (!model || !isTenantModel(model)) return query(args);

          if (FILTERED.has(operation)) {
            return query({ ...args, where: withOrg(args?.where, orgId) });
          }

          if (BY_UNIQUE[operation]) {
            // Rewriting the operation means calling through the base client:
            // `query()` is bound to the operation the caller asked for.
            const rewritten = BY_UNIQUE[operation];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const delegate = (prisma as any)[
              model.charAt(0).toLowerCase() + model.slice(1)
            ];
            return delegate[rewritten]({
              ...args,
              where: withOrg(args?.where, orgId),
            });
          }

          if (SINGLE_WRITE.has(operation)) {
            const next = { ...args, where: withOrg(args?.where, orgId) };
            if (operation === "upsert") {
              next.create = { ...(args?.create ?? {}), orgId };
            }
            return query(next);
          }

          if (CREATING.has(operation)) {
            const data = args?.data;
            if (Array.isArray(data)) {
              return query({
                ...args,
                data: data.map((row: Record<string, unknown>) => ({
                  ...row,
                  orgId,
                })),
              });
            }
            return query({ ...args, data: { ...(data ?? {}), orgId } });
          }

          // Anything not named above touches a tenant table in a way this
          // extension has not been taught to scope. Refusing is the only
          // safe default: a new Prisma operation must not silently arrive
          // unscoped.
          throw new CrossTenantError(model, operation);
        },
      },
    },
  });
}

export function forTenant(orgId: string): TenantClient {
  if (!orgId) throw new Error("forTenant() needs an orgId.");

  const cached = clientCache.get(orgId);
  if (cached) return cached;

  const client = buildTenantClient(orgId);
  clientCache.set(orgId, client);
  return client;
}

/**
 * Clears the cache. Only for tests, which build many short-lived tenants
 * and would otherwise hold a client per tenant for the run.
 */
export function resetTenantClients(): void {
  clientCache.clear();
}

/**
 * Runs `fn` with the tenant set on the database session, so row-level
 * security applies to raw SQL too.
 *
 * `SET LOCAL` is scoped to the transaction, which is what makes this safe
 * on a pooled connection: the setting cannot outlive the transaction and
 * be picked up by whoever gets that connection next. A plain `SET` here
 * would be a cross-tenant leak with a very long fuse.
 */
export async function withTenantSession<T>(
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    return fn(tx);
  });
}
