/**
 * Host header → tenant, with no database access.
 *
 * Kept separate from the lookup so it can be unit-tested exhaustively and
 * so the edge proxy — which cannot reach Postgres — can use the same
 * parsing the app uses. Getting this wrong in either direction is bad:
 * a host that resolves to the wrong tenant serves another company's data,
 * and a host that fails to resolve takes a customer offline.
 */

export type HostTenant =
  | { kind: "subdomain"; value: string }
  | { kind: "customDomain"; value: string };

/**
 * Reserved first labels that are the platform itself, never a tenant.
 * `admin` is the operator console; the rest are conventional and are
 * blocked so a tenant cannot be provisioned onto one by accident.
 */
export const RESERVED_SUBDOMAINS = new Set([
  "admin",
  "api",
  "app",
  "assets",
  "cdn",
  "console", 
  "dashboard",
  "docs",
  "help",
  "mail",
  "platform",
  "static",
  "status",
  "support",
  "www",
]);

/** Strips the port and lower-cases. `Acme.Platform.com:3000` → `acme.platform.com`. */
export function normaliseHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return null;
  // IPv6 literals arrive bracketed: [::1]:3000
  const withoutPort = trimmed.startsWith("[")
    ? trimmed.slice(0, trimmed.indexOf("]") + 1)
    : trimmed.split(":")[0];
  return withoutPort || null;
}

/**
 * Which tenant a host names, or null if the host is the bare platform
 * domain, a reserved label, or unparseable.
 *
 * `rootDomain` is the platform's own domain — `platform.com` in production,
 * `localhost` in development, so `acme.localhost:3010` works the same way
 * a real subdomain does and nobody develops against a code path that does
 * not exist in production.
 */
export function parseTenantHost(
  rawHost: string | null | undefined,
  rootDomain: string,
): HostTenant | null {
  const host = normaliseHost(rawHost);
  if (!host) return null;

  const root = rootDomain.trim().toLowerCase();

  if (host === root) return null;

  if (root && host.endsWith(`.${root}`)) {
    const prefix = host.slice(0, -(root.length + 1));
    // Only the first label identifies the tenant. A deeper name
    // (`a.b.platform.com`) is not a tenant — refusing it is safer than
    // guessing which label was meant.
    if (!prefix || prefix.includes(".")) return null;
    if (RESERVED_SUBDOMAINS.has(prefix)) return null;
    if (!isValidSubdomain(prefix)) return null;
    return { kind: "subdomain", value: prefix };
  }

  // Anything else is a tenant's own domain, matched whole.
  return { kind: "customDomain", value: host };
}

/** DNS label rules, plus a length floor so one- and two-letter grabs fail. */
export function isValidSubdomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(value) && value.length >= 3;
}

/** The public origin a tenant is reached on — used in links inside emails and SMS. */
export function tenantOrigin(
  org: { subdomain: string; customDomain: string | null },
  rootDomain: string,
  protocol = "https",
  port?: string,
): string {
  const host = org.customDomain ?? `${org.subdomain}.${rootDomain}`;
  return `${protocol}://${host}${port ? `:${port}` : ""}`;
}

/**
 * Hosts the operator console renders on.
 *
 * The **bare platform domain is the console** — `localhost:3010` in
 * development, `platform.com` in production — and every carrier lives on a
 * subdomain of it. `admin.<domain>` is accepted as well, for anyone who
 * later wants the console on a separate name.
 *
 * The security property this rests on is unchanged: a carrier's own host
 * can never serve the console, because `parseTenantHost` resolves a tenant
 * only from a first label, so neither the bare domain nor the reserved
 * `admin` label can ever be a carrier.
 */
export function isPlatformHost(
  rawHost: string | null | undefined,
  rootDomain: string,
): boolean {
  const host = normaliseHost(rawHost);
  if (!host) return false;
  const root = rootDomain.trim().toLowerCase();
  return host === root || host === `admin.${root}`;
}
