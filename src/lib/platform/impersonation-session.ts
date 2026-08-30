import { cache } from "react";
import { getEnv } from "@/lib/env";
import { platformDb } from "@/lib/platform/db";
import { normaliseHost, tenantOrigin } from "@/lib/tenant/host";
import {
  HANDOFF_AUDIENCE,
  HANDOFF_TTL_SECONDS,
  IMPERSONATION_COOKIE,
  IMPERSONATION_CONSOLE_PATH,
  IMPERSONATION_ENTER_PATH,
  SESSION_AUDIENCE,
  SESSION_MAX_SECONDS,
  grantIsUsable,
  impersonationContext,
  readGrantToken,
  signGrantToken,
  type GrantOrg,
} from "@/lib/platform/impersonation-credential";
import type { TenantContext } from "@/lib/tenant/context";

/**
 * Reading the support credential inside a request.
 *
 * The rules live next door in `impersonation-credential.ts`, which knows
 * nothing about cookies or the database. This module is the half that
 * touches both, and its whole job is to make sure the grant **row** — not
 * the token — decides whether a support session exists.
 *
 * That is why `loadOpenGrant` runs on every request rather than trusting
 * the cookie's own `exp`. Ending a session from the console, from the
 * banner, or by the clock has to take effect on the very next request, and
 * a token cannot be recalled. Same reasoning as `getCurrentUser()` loading
 * permissions fresh; the stakes here are higher.
 */

/** A grant that is open *right now*, with the operator behind it. */
export type LiveGrant = {
  id: string;
  orgId: string;
  platformAdminId: string;
  asUserId: string | null;
  reason: string;
  allowWrites: boolean;
  startedAt: Date;
  expiresAt: Date;
  endedAt: null;
  operator: { id: string; name: string; email: string };
};

/**
 * The grant row, re-read and re-checked.
 *
 * Returns null for every way a session can already be over: the row is
 * gone, it was ended, it expired, or the operator behind it was
 * deactivated. The last one mirrors `getCurrentOperator()` — an operator
 * switched off mid-session loses the console on their next request, and it
 * would be strange for them to keep a customer's app.
 */
export async function loadOpenGrant(
  grantId: string,
  now: Date = new Date(),
): Promise<LiveGrant | null> {
  const grant = await platformDb.impersonationGrant.findUnique({
    where: { id: grantId },
    select: {
      id: true,
      orgId: true,
      platformAdminId: true,
      asUserId: true,
      reason: true,
      allowWrites: true,
      startedAt: true,
      expiresAt: true,
      endedAt: true,
      platformAdmin: {
        select: {
          id: true,
          name: true,
          email: true,
          isActive: true,
          deletedAt: true,
        },
      },
    },
  });

  if (!grant) return null;
  if (grant.endedAt !== null) return null;
  if (grant.expiresAt.getTime() <= now.getTime()) return null;

  const admin = grant.platformAdmin;
  if (!admin || !admin.isActive || admin.deletedAt) return null;

  return {
    id: grant.id,
    orgId: grant.orgId,
    platformAdminId: grant.platformAdminId,
    asUserId: grant.asUserId,
    reason: grant.reason,
    allowWrites: grant.allowWrites,
    startedAt: grant.startedAt,
    expiresAt: grant.expiresAt,
    endedAt: null,
    operator: { id: admin.id, name: admin.name, email: admin.email },
  };
}

/** The cookie's raw value, or null outside a request. */
async function readCookie(): Promise<string | null> {
  try {
    // Imported lazily for the same reason `resolveTenant` does it:
    // `next/headers` throws outside a request, and the tenant layer is
    // also loaded by workers, scripts and tests.
    const { cookies } = await import("next/headers");
    return (await cookies()).get(IMPERSONATION_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * The support session this request is carrying, if any.
 *
 * Cached per request because `resolveTenant()` is called once per Prisma
 * statement and `getCurrentUser()` needs the same answer. The cookie is
 * checked before the database, so an ordinary tenant request — every
 * request that is not a support session — costs nothing but a cookie read.
 */
export const currentImpersonation = cache(async (): Promise<LiveGrant | null> => {
  const token = await readCookie();
  if (!token) return null;

  const grantId = await readGrantToken(token, SESSION_AUDIENCE);
  if (!grantId) return null;

  return loadOpenGrant(grantId);
});

/**
 * The tenant context for a host, when a support session covers it.
 *
 * Called by `resolveTenant()` after the host has already named an
 * organisation. The organisation comes from the host and never from the
 * credential: a grant for a different carrier simply produces null here
 * and the request continues as an ordinary — signed-out — visit to this
 * host.
 */
export async function impersonationContextForHost(
  org: GrantOrg,
): Promise<TenantContext | null> {
  const grant = await currentImpersonation();
  if (!grant) return null;
  return impersonationContext(org, grant);
}

/** A cookie the caller attaches to its own response. */
export type CookieWrite = {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    sameSite: "lax";
    secure: boolean;
    path: string;
    maxAge: number;
  };
};

/**
 * The session cookie for a grant, or null if the grant is already over.
 *
 * Returned rather than set, so the enter route can attach it to the
 * redirect it is already building — one response, no chance of a cookie
 * being written for a redirect that then fails.
 *
 * Host-only (no `Domain`) and path `/`: it must reach every page of this
 * carrier's app so the banner cannot be escaped, and it must reach no
 * other host at all.
 */
export async function impersonationCookie(
  grant: { id: string; expiresAt: Date },
  now: Date = new Date(),
): Promise<CookieWrite | null> {
  const token = await signGrantToken(
    grant,
    SESSION_AUDIENCE,
    SESSION_MAX_SECONDS,
    now,
  );
  if (!token) return null;

  const seconds = Math.floor(
    Math.min(
      SESSION_MAX_SECONDS * 1000,
      grant.expiresAt.getTime() - now.getTime(),
    ) / 1000,
  );

  return {
    name: IMPERSONATION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: Math.max(seconds, 1),
    },
  };
}

/** The same cookie, emptied — attached to the response that leaves. */
export function clearedImpersonationCookie(): CookieWrite {
  return {
    name: IMPERSONATION_COOKIE,
    value: "",
    options: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    },
  };
}

/** The grant id the cookie names, without touching the database. */
export async function grantIdFromCookie(): Promise<string | null> {
  return readGrantToken(await readCookie(), SESSION_AUDIENCE);
}

/**
 * Scheme and port of the request that is being served.
 *
 * The console and the carrier share a deployment, so the link out of one
 * into the other has to be built from where we actually are: `https` and
 * no port in production, `http://…:3010` in development. Guessing either
 * produces a link that silently goes nowhere.
 */
async function currentOrigin(): Promise<{ protocol: string; port?: string }> {
  const { headers } = await import("next/headers");
  const list = await headers();
  const forwarded = list.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol =
    forwarded ?? (getEnv().NODE_ENV === "production" ? "https" : "http");

  const host = list.get("host") ?? "";
  // `normaliseHost` drops the port; what is left over is the port, if any.
  const bare = normaliseHost(host);
  const port =
    bare && host.toLowerCase().startsWith(bare) && host.length > bare.length
      ? host.slice(bare.length + 1)
      : undefined;

  return { protocol, port };
}

/**
 * The one-minute hand-off link into a carrier's app.
 *
 * Built on the console's host, followed by the operator's own browser,
 * consumed on the carrier's host. Everything the link carries is the
 * hand-off token, and the token carries a grant id.
 */
export async function handoffUrl(
  org: { subdomain: string; customDomain: string | null },
  grant: { id: string; expiresAt: Date },
): Promise<string | null> {
  const token = await signGrantToken(grant, HANDOFF_AUDIENCE, HANDOFF_TTL_SECONDS);
  if (!token) return null;

  const { protocol, port } = await currentOrigin();
  const origin = tenantOrigin(org, getEnv().APP_ROOT_DOMAIN, protocol, port);
  return `${origin}${IMPERSONATION_ENTER_PATH}?t=${encodeURIComponent(token)}`;
}

/** The grant id a hand-off link names, or null. */
export async function readHandoffToken(
  token: string | null | undefined,
): Promise<string | null> {
  return readGrantToken(token, HANDOFF_AUDIENCE);
}

/**
 * Where an ended support session returns to.
 *
 * The console, on its own host — an operator who has just left a customer
 * should land somewhere that says so, not on the carrier's login page.
 */
export async function consoleUrl(): Promise<string> {
  const { protocol, port } = await currentOrigin();
  const root = getEnv().APP_ROOT_DOMAIN.trim().toLowerCase();
  return `${protocol}://admin.${root}${port ? `:${port}` : ""}${IMPERSONATION_CONSOLE_PATH}`;
}

export { grantIsUsable };
