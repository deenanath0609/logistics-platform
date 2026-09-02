import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getEnv } from "@/lib/env";
import { isPlatformHost } from "@/lib/tenant/host";
import { clientFacingHost } from "@/lib/tenant/resolve";

/**
 * The other half of the host boundary.
 *
 * `admin` is a reserved first label, so `parseTenantHost` already refuses
 * to resolve it to a carrier and any tenant page rendered on it 404s. This
 * is the mirror: the operator console refuses to render anywhere except
 * `admin.<APP_ROOT_DOMAIN>`, so a carrier's own subdomain can never serve
 * it — not the sign-in form, not a tenant list, not a stack trace that
 * names another carrier.
 *
 * Called from the console's outermost layout, which covers sign-in too. A
 * route group has a 404 boundary to render into; the root layout does not,
 * which is why this lives one level down.
 *
 * In development the console is `admin.localhost:3010`, exercising exactly
 * the code path production uses.
 */
/**
 * ── Which host, exactly ─────────────────────────────────────────────────
 *
 * `clientFacingHost`, not `Host`, and for the reason spelled out at length
 * in `tenant/resolve.ts`: when a server action ends in a redirect, Next
 * renders the target page from an internally constructed request whose
 * `Host` is the address the process itself listens on — `localhost:3010` —
 * rather than the address the browser asked for.
 *
 * This guard read `Host` directly, so behind a proxy in production every
 * console page reached that way 404'd. Both of the console's redirecting
 * actions land there: signing in, and provisioning a carrier — which
 * would have 404'd on the one page showing the new owner's password,
 * moments after creating a tenant nobody could then sign into.
 *
 * It has never been seen in development, and could not have been: with
 * `APP_ROOT_DOMAIN=localhost` the fallback host is accidentally the right
 * answer. The two host resolutions are the same rule now, which is what
 * stops them disagreeing again — and the rule still refuses
 * `X-Forwarded-Host` unless `TRUSTED_PROXY_HOPS` says a proxy is in front,
 * so this does not become a header anyone can send to reach the console.
 * ────────────────────────────────────────────────────────────────────────
 */
export async function requirePlatformHost(): Promise<void> {
  const host = clientFacingHost(await headers());
  if (!isPlatformHost(host, getEnv().APP_ROOT_DOMAIN)) notFound();
}
