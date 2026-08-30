import { SignJWT, jwtVerify } from "jose";
import { getEnv } from "@/lib/env";
import type { TenantContext } from "@/lib/tenant/context";
import type { TenantStatus } from "@/generated/prisma/client";

/**
 * The credential that carries a support grant across the host boundary.
 *
 * The operator's own `platform_session` cookie is host-only on
 * `admin.<root>` and path-scoped to `/platform`, which is deliberate: a
 * browser will not send it to `acme.<root>` at all. That is the property
 * that makes the console safe, and handing a support session to a tenant
 * must not weaken it. So nothing about the operator's cookie changes —
 * a *second*, much smaller credential is minted instead:
 *
 * - **Grant-scoped, not identity-scoped.** The token's only claim is a
 *   grant id, behind a `grant:` subject prefix that no cuid can produce
 *   and that `readPlatformSubject()` / `getCurrentUser()` both refuse.
 *   There is no operator id, no user id and no permission set in it, so
 *   there is nothing in it that another verifier could mistake for a
 *   login.
 * - **Its own audience.** Signed HS256 over `AUTH_SECRET` like the other
 *   two cookies, but `aud` is neither `platform-console` nor the tenant
 *   session's, so none of the three can be replayed as another.
 * - **Never outliving the grant.** The token's `exp` is capped at
 *   `ImpersonationGrant.expiresAt`, so even a stolen token dies with the
 *   grant it names.
 * - **Never trusted on its own.** A valid signature proves only "somebody
 *   was handed grant X". Whether X is still open, and whether it belongs
 *   to the organisation the *host* resolved to, is read from the row on
 *   every single request (see `impersonation-session.ts`).
 *
 * Two audiences, not one, because the credential has to travel through a
 * URL once. The console lives on a different origin and cannot set a
 * host-only cookie on a carrier's subdomain, so the hand-off is a redirect
 * carrying a token in the query string — and query strings end up in
 * proxy logs, browser history and `Referer` headers. The **hand-off**
 * token therefore lives for a minute and is spent immediately; what it is
 * exchanged for is the **session** token, which is only ever in a cookie.
 *
 * This module is deliberately free of database and request access so the
 * rules below are directly testable. See `impersonation-credential.test.ts`.
 */

/** Host-only on the carrier's own subdomain, set by the enter route. */
export const IMPERSONATION_COOKIE = "impersonation_session";

const ISSUER = "city-logistics";

/** Spent once, in the redirect from the console to the carrier's host. */
export const HANDOFF_AUDIENCE = "tenant-impersonation-handoff";

/** Held in the cookie for the life of the support session. */
export const SESSION_AUDIENCE = "tenant-impersonation";

/**
 * How long a hand-off link is worth anything. Long enough for one redirect
 * on a bad connection, short enough that a URL in a log is already dead.
 */
export const HANDOFF_TTL_SECONDS = 60;

/**
 * A hard ceiling on the cookie, independent of the grant.
 *
 * `MAX_MINUTES` for a grant is four hours; a cookie is also re-checked
 * against the row on every request, so this exists only so that the token
 * itself is never a long-lived bearer secret.
 */
export const SESSION_MAX_SECONDS = 60 * 60;

/**
 * Namespaces the subject so it cannot be read as an identity.
 *
 * `platform:` and `customer:` already mean "not staff"; `grant:` means
 * "not anybody at all". A cuid cannot contain a colon, so none of the four
 * subject spaces can collide.
 */
const GRANT_SUBJECT_PREFIX = "grant:";

/** Where a hand-off link lands on the carrier's host. */
export const IMPERSONATION_ENTER_PATH = "/impersonation/enter";

/** Where the banner's "end session" posts, on the carrier's host. */
export const IMPERSONATION_EXIT_PATH = "/impersonation/exit";

/** Where an ended session returns to, on the console's host. */
export const IMPERSONATION_CONSOLE_PATH = "/platform/impersonation";

/**
 * The `SessionUser.id` of a tenant-wide support session.
 *
 * Prefixed for the same reason the subject is: it must not collide with a
 * `User.id`, and anything that reaches for "rows this user owns" must find
 * none rather than somebody else's.
 */
export const IMPERSONATION_USER_ID_PREFIX = "impersonation:";

function secret(): Uint8Array {
  return new TextEncoder().encode(getEnv().AUTH_SECRET);
}

/** Everything the credential rules need to know about a grant row. */
export type GrantFacts = {
  id: string;
  orgId: string;
  platformAdminId: string;
  asUserId: string | null;
  allowWrites: boolean;
  expiresAt: Date;
  endedAt: Date | null;
};

/** The host-resolved organisation a grant is being checked against. */
export type GrantOrg = {
  id: string;
  slug: string;
  subdomain: string;
  status: TenantStatus;
};

export function grantSubject(grantId: string): string {
  return `${GRANT_SUBJECT_PREFIX}${grantId}`;
}

/**
 * The grant id inside a subject, or null.
 *
 * Null means "not a support credential" and never "some support
 * credential" — the refusal is the point, exactly as in `lib/auth/subject`.
 */
export function readGrantSubject(subject: string | null | undefined): string | null {
  if (typeof subject !== "string") return null;
  if (!subject.startsWith(GRANT_SUBJECT_PREFIX)) return null;
  const id = subject.slice(GRANT_SUBJECT_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * The moment a credential for this grant must stop verifying.
 *
 * `expiresAt` on the row is the ceiling and is never exceeded, so a token
 * cannot outlive the grant even if the row is never read again. `ttl` only
 * ever shortens it.
 */
export function credentialExpiry(
  grant: Pick<GrantFacts, "expiresAt">,
  ttlSeconds: number,
  now: Date = new Date(),
): Date {
  const ceiling = grant.expiresAt.getTime();
  const wanted = now.getTime() + ttlSeconds * 1000;
  return new Date(Math.min(ceiling, wanted));
}

/**
 * Signs a token naming one grant.
 *
 * Returns null when the grant has already expired: minting a credential
 * that is dead on arrival would only produce a confusing 404 later, and
 * the caller has a better error to give.
 */
export async function signGrantToken(
  grant: Pick<GrantFacts, "id" | "expiresAt">,
  audience: string,
  ttlSeconds: number,
  now: Date = new Date(),
): Promise<string | null> {
  const expiry = credentialExpiry(grant, ttlSeconds, now);
  if (expiry.getTime() <= now.getTime()) return null;

  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(grantSubject(grant.id))
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(expiry)
    .sign(secret());
}

/**
 * The grant id a token names, or null.
 *
 * Expired, tampered with, or signed for the other audience all come back
 * as null. A caller must treat null as "no support session" — there is no
 * shape of failure here that means "some support session".
 */
export async function readGrantToken(
  token: string | null | undefined,
  audience: string,
): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience,
    });
    return readGrantSubject(payload.sub);
  } catch {
    return null;
  }
}

/**
 * Whether a grant row may still be acted on, for this host's organisation.
 *
 * Three independent refusals, and the third is the one that matters most:
 * a grant opened against Acme, presented on Bravo's subdomain, is ignored
 * entirely rather than downgraded to a read-only Bravo session. Honouring
 * it in any form would make the credential — not the host — the boundary,
 * which is the inversion ADR 001 §2 exists to prevent.
 */
export function grantIsUsable(
  grant: Pick<GrantFacts, "orgId" | "expiresAt" | "endedAt">,
  orgId: string,
  now: Date = new Date(),
): boolean {
  if (grant.orgId !== orgId) return false;
  if (grant.endedAt !== null) return false;
  return grant.expiresAt.getTime() > now.getTime();
}

/**
 * Whether a grant may write at all.
 *
 * `allowWrites` is necessary but not sufficient. A write has to be
 * attributable to somebody: `AuditLog.userId` is a foreign key into
 * `app_user`, so the only actor an impersonated write can name is the
 * tenant user the grant adopted. A grant with no `asUserId` has nobody to
 * name, so it is read-only whatever the box said — which is also what the
 * console's own hint promises ("leaving it blank is tenant-wide and
 * read-only").
 */
export function grantMayWrite(
  grant: Pick<GrantFacts, "allowWrites" | "asUserId">,
): boolean {
  return grant.allowWrites && grant.asUserId !== null;
}

/**
 * The tenant context a live grant produces, or null when it produces none.
 *
 * Null is returned for every reason a support session must not exist —
 * wrong organisation, ended, expired, closed tenant — and a null here is
 * simply "no impersonation", which leaves the ordinary host-resolved
 * context to answer instead. It never widens into "some other tenant".
 */
export function impersonationContext(
  org: GrantOrg,
  grant: GrantFacts,
  now: Date = new Date(),
): TenantContext | null {
  if (!grantIsUsable(grant, org.id, now)) return null;

  // A CLOSED tenant refuses sign-in entirely, and `openGrant` refuses to
  // open a session into one. Re-checked here because a tenant can be
  // closed *while* a session is open, and the session must die with it.
  if (org.status === "CLOSED") return null;

  return {
    orgId: org.id,
    slug: org.slug,
    subdomain: org.subdomain,
    status: org.status,
    source: "impersonation",
    // Suspension still wins. A read-only carrier stays read-only even for
    // an operator who ticked "allow writes": the tenant's own state is not
    // something a support grant is allowed to argue with.
    readOnly: !grantMayWrite(grant) || org.status === "SUSPENDED",
    impersonation: {
      grantId: grant.id,
      platformAdminId: grant.platformAdminId,
    },
  };
}
