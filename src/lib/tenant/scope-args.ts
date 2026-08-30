import { TenantContextError } from "@/lib/tenant/context";

/**
 * Turning a caller's Prisma arguments into tenant-scoped ones.
 *
 * Split out of the extension because this is where isolation is actually
 * decided, and it is pure: given a caller's arguments and a tenant, it
 * either produces arguments that cannot reach another tenant's rows or it
 * throws. That makes it directly testable, which matters more here than
 * anywhere else in the codebase — a subtle bug in `mergeWhere` is not a
 * wrong answer, it is one carrier reading another's consignments.
 */

export type AnyArgs = Record<string, unknown> | undefined;

export const WRITE_OPERATIONS = new Set([
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

/**
 * Writes a read-only tenant is still allowed to make.
 *
 * "Read-only" means a suspended carrier can read their own consignment
 * history while a payment dispute is settled — which they cannot do if they
 * cannot sign in, and signing in writes: a login attempt, a failed-attempt
 * counter, a one-time password. Refusing those would turn a suspension into
 * a lockout, and would quietly disable brute-force protection along the way.
 * None of these tables holds operational data.
 */
export const READ_ONLY_EXEMPT_MODELS = new Set([
  "loginActivity",
  "otpToken",
  "session",
  "verificationToken",
  "auditLog",
]);

/** `model Shipment` is reached as `prisma.shipment`. */
export function clientKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

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
export function mergeWhere(
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
export function readFilter(orgId: string, optional: boolean): Record<string, unknown> {
  return optional ? { OR: [{ orgId }, { orgId: null }] } : { orgId };
}

export function assertNoForeignOrg(data: unknown, orgId: string): void {
  if (!data || typeof data !== "object") return;
  const given = (data as Record<string, unknown>).orgId;
  if (given !== undefined && given !== null && given !== orgId) {
    throw new TenantContextError(
      `Refusing to write a row for organisation ${String(given)} while acting as ${orgId}.`,
    );
  }
}

export function stampCreate(data: unknown, orgId: string): unknown {
  if (Array.isArray(data)) return data.map((row) => stampCreate(row, orgId));
  if (!data || typeof data !== "object") return data;
  assertNoForeignOrg(data, orgId);
  return { ...(data as Record<string, unknown>), orgId };
}

export function applyTenant(
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
