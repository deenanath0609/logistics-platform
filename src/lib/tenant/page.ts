import { notFound } from "next/navigation";
import { getBranding, type TenantBranding } from "@/lib/tenant/branding";
import { resolveTenant } from "@/lib/tenant/resolve";
import type { TenantContext } from "@/lib/tenant/context";

/**
 * The tenant a page is being rendered for, or a 404.
 *
 * Called from each route group's layout rather than the root layout, so
 * that `notFound()` has a boundary to render into. An unresolvable host is
 * a 404 and never a fallback to a default tenant: silently serving one
 * carrier's consignments under another's address is the worst failure this
 * system has (ADR 001 §2).
 */
export async function requireTenantPage(): Promise<{
  tenant: TenantContext;
  branding: TenantBranding;
}> {
  const tenant = await resolveTenant();
  if (!tenant) notFound();

  const branding = await getBranding(tenant.orgId);
  if (!branding) notFound();

  return { tenant, branding };
}

/**
 * Branding for surfaces that must render even when the host names no
 * tenant — the root layout, which has no boundary to 404 into.
 */
export async function optionalBranding(): Promise<TenantBranding | null> {
  const tenant = await resolveTenant();
  if (!tenant) return null;
  return getBranding(tenant.orgId);
}
