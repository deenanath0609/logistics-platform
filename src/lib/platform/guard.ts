import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getEnv } from "@/lib/env";
import { isPlatformHost } from "@/lib/tenant/host";

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
export async function requirePlatformHost(): Promise<void> {
  const host = (await headers()).get("host");
  if (!isPlatformHost(host, getEnv().APP_ROOT_DOMAIN)) notFound();
}
