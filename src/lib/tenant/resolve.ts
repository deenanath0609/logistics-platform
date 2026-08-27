import { basePrisma } from "@/lib/prisma-base";
import { getEnv } from "@/lib/env";
import { parseTenantHost } from "@/lib/tenant/host";
import {
  currentTenant,
  isCrossTenantScope,
  type TenantContext,
} from "@/lib/tenant/context";
import type { TenantStatus } from "@/generated/prisma/client";

/**
 * Turning a request into a tenant.
 *
 * The lookup is deliberately small — id, slug, subdomain, status — because
 * it runs before everything else on every request. Branding is loaded
 * separately, by the layouts that actually render it.
 */
export type ResolvedOrg = {
  id: string;
  slug: string;
  subdomain: string;
  customDomain: string | null;
  status: TenantStatus;
};

/**
 * Hosts change rarely and are read constantly, so the resolution is cached
 * in process for a short window. The window is short on purpose: suspending
 * a tenant has to take effect in seconds, not on the next deploy.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { org: ResolvedOrg | null; expires: number }>();

/** Called after a tenant's host or status changes, so the next request sees it. */
export function bustTenantCache(host?: string): void {
  if (host) cache.delete(host);
  else cache.clear();
}

async function lookupOrg(host: string): Promise<ResolvedOrg | null> {
  const parsed = parseTenantHost(host, getEnv().APP_ROOT_DOMAIN);
  if (!parsed) return null;

  const where =
    parsed.kind === "subdomain"
      ? { subdomain: parsed.value }
      : { customDomain: parsed.value };

  return basePrisma.organization.findFirst({
    where,
    select: {
      id: true,
      slug: true,
      subdomain: true,
      customDomain: true,
      status: true,
    },
  });
}

/** Host → organisation, or null when no tenant owns that host. */
export async function orgForHost(host: string | null): Promise<ResolvedOrg | null> {
  if (!host) return null;
  const key = host.toLowerCase();

  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.org;

  const org = await lookupOrg(key);
  cache.set(key, { org, expires: Date.now() + TTL_MS });
  return org;
}

/**
 * A CLOSED tenant is refused sign-in entirely; a SUSPENDED one stays
 * reachable but cannot be written to, so an operations team can still read
 * their own consignment history while a payment dispute is settled.
 */
export function tenantContextFor(
  org: ResolvedOrg,
  source: TenantContext["source"],
): TenantContext | null {
  if (org.status === "CLOSED") return null;
  return {
    orgId: org.id,
    slug: org.slug,
    subdomain: org.subdomain,
    status: org.status,
    source,
    readOnly: org.status === "SUSPENDED",
  };
}

/**
 * The tenant for the work currently running, or null.
 *
 * Two sources, in this order:
 *
 * 1. An explicit `runWithTenant()` — background jobs, scripts and tests,
 *    which have no request to read a host from.
 * 2. The request's `Host` header. Next's `headers()` is request-scoped, so
 *    this works in server components, server actions and route handlers
 *    alike without threading anything through the call tree.
 *
 * Deliberately not a third source: the signed-in user's `orgId`. Trusting
 * the session would mean a user of one tenant could operate on another
 * tenant's subdomain, and the host would stop being the boundary. The
 * session is checked *against* the host instead — see `assertUserBelongsToTenant`.
 */
export async function resolveTenant(): Promise<TenantContext | null> {
  const explicit = currentTenant();
  if (explicit) return explicit;
  if (isCrossTenantScope()) return null;

  let host: string | null = null;
  try {
    // Imported lazily: `next/headers` throws outside a request, and this
    // module is also loaded by workers and scripts.
    const { headers } = await import("next/headers");
    host = (await headers()).get("host");
  } catch {
    return null;
  }

  const org = await orgForHost(host);
  if (!org) return null;

  return tenantContextFor(org, "host");
}
