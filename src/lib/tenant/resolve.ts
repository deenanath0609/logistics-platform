import { basePrisma } from "@/lib/prisma-base";
import { getEnv } from "@/lib/env";
import { parseTenantHost } from "@/lib/tenant/host";
import {
  currentTenant,
  isCrossTenantScope,
  TenantContextError,
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

/**
 * The host the *browser* asked for, which is not always the `Host` header.
 *
 * Behind a proxy there are two answers and they disagree in one place that
 * matters. Nginx passes the carrier's host through faithfully, so an
 * ordinary request carries the right `Host`. But when a server action ends
 * in a redirect, Next renders the target page from an internally
 * constructed request: the browser's user agent and every `X-Forwarded-*`
 * header survive, and `Host` becomes the address the process itself listens
 * on — `localhost:3010`. That host belongs to no carrier, so the tenant
 * resolved to nobody and the page 404'd, while the same URL typed again
 * worked perfectly. It cost a day.
 *
 * `X-Forwarded-Host` is right in both cases, which is what it is for.
 *
 * It is trusted only when `TRUSTED_PROXY_HOPS` says a proxy is in front —
 * the same switch, and the same reasoning, as the client-IP resolution in
 * `lib/net/client-ip.ts`. Trusting it unconditionally would let anyone who
 * can reach the app directly name whichever carrier they liked, which is
 * the whole boundary handed over in one header.
 */
export function clientFacingHost(headers: Headers): string | null {
  const hops = getEnv().TRUSTED_PROXY_HOPS;
  if (hops > 0) {
    const forwarded = trustedForwardedHost(headers.get("x-forwarded-host"), hops);
    if (forwarded) return forwarded;
  }

  return headers.get("host");
}

/**
 * The entry of an `X-Forwarded-Host` chain that a configured proxy wrote.
 *
 * ── Which end of the chain, and why it matters ──────────────────────────
 *
 * This used to take `split(",")[0]` — the leftmost entry — on the grounds
 * that "a chain appends, so the first entry is the one the browser asked
 * for". Both halves of that sentence are true and the conclusion does not
 * follow: if the chain appends, then a *client* that sends its own
 * `X-Forwarded-Host` occupies position zero and every proxy in front of us
 * adds itself after it. The leftmost entry is therefore the one value in
 * the whole header that the caller controls, and reading it would have let
 * anyone name whichever carrier they liked — the exact boundary this
 * switch exists to protect, handed over by the reading of it.
 *
 * It never bit, because nginx here replaces the header rather than
 * appending to it, so the chain has one entry and both ends are the same
 * value. That is a property of one deployment's configuration, not of the
 * header, and it stops being true the day a CDN goes in front.
 *
 * So it is counted from the right, exactly as `deriveClientIp` counts
 * `X-Forwarded-For`, and for exactly the same reason: the rightmost entry
 * was written by the proxy nearest to us, the one before it by the proxy
 * before that, and `TRUSTED_PROXY_HOPS` says how far back we may believe.
 * A chain shorter than the configured hop count means the request did not
 * come through the proxies at all — which is what bypassing an internal
 * load balancer looks like — and is refused rather than half-believed.
 * ────────────────────────────────────────────────────────────────────────
 */
export function trustedForwardedHost(
  header: string | null | undefined,
  hops: number,
): string | null {
  if (!header || hops <= 0) return null;

  const chain = header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (chain.length < hops) return null;
  return chain[chain.length - hops] || null;
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
 *
 * A platform operator's support session is **not** a third source either,
 * and the ordering below is the reason. The host names the organisation
 * first; only then is the support credential consulted, and only to answer
 * "does a live grant cover *this* organisation?". A grant for a different
 * carrier changes nothing — it is not honoured, not downgraded, not
 * partially applied. The credential can weaken a session (into read-only)
 * and label it; it can never move it.
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
    host = clientFacingHost(await headers());
  } catch (error) {
    // Swallowing this silently cost a day. "No tenant context" is what the
    // extension reports downstream, and it names two possible causes — a
    // host that resolves to nobody, or code running outside a request — with
    // no way to tell which. They have opposite fixes. Outside a request is
    // the ordinary case for a worker or a script, so this stays quiet at
    // `debug` level rather than becoming noise in every background pass; set
    // `TENANT_DEBUG=on` when a request is the one failing.
    if (process.env.TENANT_DEBUG === "on") {
      console.warn(
        "[tenant] could not read the request host: " +
          (error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
      );
    }
    return null;
  }

  if (!host && process.env.TENANT_DEBUG === "on") {
    console.warn("[tenant] the request carried no Host header.");
  }

  const org = await orgForHost(host);
  if (!org) {
    // The other half of the same ambiguity: the request had a host and no
    // carrier answered to it. On the bare platform domain that is correct
    // and expected; anywhere else it is a missing organisation, a typo in
    // `APP_ROOT_DOMAIN`, or a lookup that returned nothing because the row
    // was invisible to the connection making it.
    if (process.env.TENANT_DEBUG === "on") {
      // The path and the user agent as well as the host. A host that belongs
      // to nobody is only half the story: knowing *which request* carried it
      // is what separates "somebody typed the bare domain" from "something
      // inside this process is calling itself".
      let where = "";
      try {
        const { headers } = await import("next/headers");
        const h = await headers();
        where =
          ` path="${h.get("x-pathname") ?? h.get("next-url") ?? "?"}"` +
          ` ua="${(h.get("user-agent") ?? "none").slice(0, 40)}"` +
          ` fwd="${h.get("x-forwarded-host") ?? "none"}"`;
      } catch {
        // Best effort; the host line below is the part that matters.
      }
      console.warn(`[tenant] no organisation answers to host "${host}".${where}`);
    }
    return null;
  }

  // Imported lazily for the same reason, and because it reaches the
  // database: an ordinary request pays a cookie read and stops there.
  const { impersonationContextForHost } = await import(
    "@/lib/platform/impersonation-session"
  );
  const impersonated = await impersonationContextForHost(org);
  if (impersonated) return impersonated;

  return tenantContextFor(org, "host");
}


/**
 * The current tenant's id, for code that has to write it.
 *
 * Reads never mention the tenant — the extension filters them. Writes are
 * different: `orgId` is a NOT NULL column, so a `create` has to name it, and
 * the generated types say so. Passing it is not trusting it: the extension
 * refuses any write whose `orgId` disagrees with the host-resolved tenant,
 * so an explicit id is a checked assertion rather than an opportunity to get
 * it wrong.
 *
 * Prefer `actor.orgId` where a signed-in user is already in scope — it is
 * the same value without a second resolution.
 */
export async function requireTenantOrgId(): Promise<string> {
  const tenant = await resolveTenant();
  if (!tenant) {
    throw new TenantContextError(
      "No tenant context: the request host resolves to no organisation, or " +
        "this ran outside a request without runWithTenant().",
    );
  }
  return tenant.orgId;
}
