import { basePrisma } from "@/lib/prisma-base";
import { runWithTenant, type TenantContext } from "@/lib/tenant/context";
import { tenantContextFor } from "@/lib/tenant/resolve";

/**
 * Running a background pass once per tenant.
 *
 * Every timer in `src/instrumentation.ts` used to be a single sweep over a
 * single-tenant database. None of them can stay that way: the models they
 * read — `OutboxEvent`, `GpsPing`, `Shipment`, `Exception` — now carry an
 * `orgId`, and the Prisma extension throws rather than let a query with no
 * tenant return every organisation's rows. That refusal is the point. One
 * global drain quietly serving fifty customers through one code path is the
 * failure ADR 001 exists to design out.
 *
 * So a job enumerates organisations explicitly and does its work inside
 * `runWithTenant` for each, which is a different guarantee: fifty passes
 * that each cannot see anything but their own tenant, rather than one pass
 * trusted to filter correctly every time.
 */

const ORG_SELECT = {
  id: true,
  slug: true,
  subdomain: true,
  customDomain: true,
  status: true,
} as const;

export type TenantPassOptions = {
  /** Names the job in log lines. Use the same prefix the job already logs. */
  job: string;
  /** Restrict the pass to one tenant — "run now" buttons, replays, tests. */
  orgId?: string;
  /**
   * Include SUSPENDED tenants, which are reachable but read-only.
   *
   * Off by default because every job that uses this writes, and the
   * extension refuses writes for a read-only tenant. Including them would
   * turn a suspended account into a logged failure on every tick rather
   * than a tenant that is simply paused — and the work is not lost: an
   * outbox row still PENDING when the account is reinstated drains then.
   */
  includeReadOnly?: boolean;
};

/** Where a tenant sits in the pass, for work that divides a shared budget. */
export type TenantSlice = {
  /** 0-based position in this pass. */
  index: number;
  /** How many tenants this pass will visit in total. */
  total: number;
};

export type TenantPassResult<T> = {
  results: { orgId: string; slug: string; value: T }[];
  /** Tenants whose work completed. */
  ran: number;
  /** Tenants whose work threw. The pass continued past each one. */
  failed: number;
};

/**
 * The tenants a background pass should visit, as ready-to-use contexts.
 *
 * A CLOSED tenant yields no context at all — `tenantContextFor` returns
 * null for it — so it drops out here rather than every caller remembering
 * to check a status enum.
 */
export async function tenantsForPass(
  options: TenantPassOptions,
): Promise<TenantContext[]> {
  // `basePrisma`, not `prisma`: this is the query that establishes which
  // tenant to act as, so it cannot itself run inside one.
  const orgs = await basePrisma.organization.findMany({
    where: options.orgId ? { id: options.orgId } : {},
    // Stable order, so a log line from two passes ago can be lined up
    // against this one.
    orderBy: { slug: "asc" },
    select: ORG_SELECT,
  });

  const tenants: TenantContext[] = [];
  for (const org of orgs) {
    const tenant = tenantContextFor(org, "job");
    if (!tenant) continue;
    if (tenant.readOnly && !options.includeReadOnly) continue;
    tenants.push(tenant);
  }
  return tenants;
}

/**
 * Runs `work` once per tenant, inside that tenant's context.
 *
 * One tenant's failure never reaches the others. A customer with a corrupt
 * row, an unreachable SMS gateway or a half-finished configuration must not
 * be able to stop everybody else's notifications going out, and a single
 * try/catch around the whole sweep is exactly what would let them.
 */
export async function forEachTenant<T>(
  options: TenantPassOptions,
  work: (tenant: TenantContext, slice: TenantSlice) => Promise<T>,
): Promise<TenantPassResult<T>> {
  const tenants = await tenantsForPass(options);
  const pass: TenantPassResult<T> = { results: [], ran: 0, failed: 0 };

  for (const [index, tenant] of tenants.entries()) {
    try {
      const value = await runWithTenant(tenant, () =>
        work(tenant, { index, total: tenants.length }),
      );
      pass.results.push({ orgId: tenant.orgId, slug: tenant.slug, value });
      pass.ran++;
    } catch (error) {
      pass.failed++;
      console.error(`[${options.job}] tenant "${tenant.slug}" failed`, error);
    }
  }

  return pass;
}
