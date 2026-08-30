import { cache } from "react";
import { basePrisma } from "@/lib/prisma-base";
import { MODULES } from "@/lib/modules/modules";
import { modulesForPlan, type ModuleKey } from "@/lib/modules/registry";
import { resolveTenant } from "@/lib/tenant/resolve";

/**
 * What this carrier bought, resolved once per request.
 *
 * Sits beside the tenant rather than inside it: `TenantContext` is answered
 * from the host alone and is used on paths that never touch a plan (public
 * tracking, the login form), so folding a plan lookup into it would add a
 * query to requests that have no use for one.
 *
 * `basePrisma` for the same reason `getBranding` uses it — `Organization`
 * and `TenantPlan` are global tables the tenant extension does not filter,
 * and this runs before a session exists. Passing `orgId` explicitly is what
 * scopes it, and the caller always has one: the host resolved it, or the
 * session carries it.
 */
export const modulesForOrg = cache(
  async (orgId: string): Promise<ReadonlySet<ModuleKey>> => {
    const org = await basePrisma.organization.findUnique({
      where: { id: orgId },
      select: { plan: { select: { features: true } } },
    });

    // `TenantPlan.isActive` is deliberately not consulted. It means "still
    // offered to new carriers", not "this carrier is paid up" — retiring a
    // plan from the price list must not switch off the modules of everyone
    // already on it. Non-payment is expressed as a SUSPENDED tenant, which
    // `tenantContextFor` already turns into read-only access.
    return modulesForPlan(org?.plan?.features, MODULES);
  },
);

/**
 * The modules of the tenant this request arrived for.
 *
 * A host that names no organisation gets the `alwaysOn` set. Nothing renders
 * on such a host anyway — `requireTenantPage()` has already 404'd — so the
 * value only matters for code that asks before that check, and the narrow
 * answer is the safe one.
 */
export async function getTenantModules(): Promise<ReadonlySet<ModuleKey>> {
  const tenant = await resolveTenant();
  if (!tenant) return modulesForPlan(null, MODULES);
  return modulesForOrg(tenant.orgId);
}

/** Convenience for a call site that knows which module it needs. */
export async function hasModule(key: ModuleKey): Promise<boolean> {
  return (await getTenantModules()).has(key);
}
