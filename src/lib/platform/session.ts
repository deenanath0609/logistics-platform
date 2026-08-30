import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { getEnv } from "@/lib/env";
import { platformDb } from "@/lib/platform/db";
import { platformCan, type PlatformCapability } from "@/lib/platform/roles";
import { platformSubject, readPlatformSubject } from "@/lib/auth/subject";
import type { PlatformRole } from "@/generated/prisma/client";

/**
 * The platform operator's session — its own module, its own cookie, its
 * own table.
 *
 * The customer portal made this judgement first and it holds harder here.
 * `SessionUser` is not widened with an "isOperator" flag, and Auth.js is
 * not given a fourth provider, because both would put the operator and
 * tenant staff on the same cookie and one refactor away from the same code
 * path. Instead:
 *
 * - **A different cookie.** `platform_session`, host-only on
 *   `admin.<root>`. A browser will not send it to `acme.<root>` at all,
 *   so an operator session is not merely rejected on a carrier's
 *   subdomain — it never arrives there.
 * - **A different audience.** The token is signed with `aud` set to this
 *   console, so a tenant token cannot be presented here and vice versa
 *   even though both are HS256 over `AUTH_SECRET`.
 * - **A different type.** `PlatformOperator` carries no `permissions`,
 *   no `orgId` and no `branchIds`, so it does not typecheck against
 *   `can()`, `authorize()`, `requirePermission()` or `ownedByCustomer()`.
 *   A support login cannot satisfy a tenant permission check because
 *   there is no way to spell the call.
 *
 * The refusals run both ways: `getCurrentUser()` returns null for a
 * `platform:` subject, and this module returns null for anything that is
 * not one.
 */

const COOKIE_NAME = "platform_session";
const AUDIENCE = "platform-console";
const ISSUER = "city-logistics";

/** Twelve hours, matching the tenant session. */
const MAX_AGE_SECONDS = 60 * 60 * 12;

export const PLATFORM_LOGIN_PATH = "/platform/login";
export const PLATFORM_PASSWORD_PATH = "/platform/password";

function secret(): Uint8Array {
  return new TextEncoder().encode(getEnv().AUTH_SECRET);
}

/**
 * The signed-in operator.
 *
 * Note what is absent, as in `CustomerSession`: no permission set, no
 * organisation, no branch scope. What is present is the role, and role
 * checks go through `operatorCan` below rather than through anything in
 * `lib/auth`.
 */
export type PlatformOperator = {
  /** `PlatformAdmin.id`, unwrapped from the namespaced subject. */
  id: string;
  name: string;
  email: string;
  role: PlatformRole;
  mustChangePassword: boolean;
};

/** Issues the operator cookie. Only callable from a server action. */
export async function startPlatformSession(adminId: string): Promise<void> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(platformSubject(adminId))
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // Scoped to the console's own path as well as its own host. Belt and
    // braces: two independent reasons this cookie cannot reach a tenant.
    path: "/platform",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function endPlatformSession(): Promise<void> {
  const store = await cookies();
  store.delete({ name: COOKIE_NAME, path: "/platform" });
}

/**
 * Loads the operator fresh from the database on every request.
 *
 * Same reasoning as `getCurrentUser` and `getCurrentCustomerUser`: an
 * operator deactivated mid-session must lose access on the very next
 * request, and the role must be the one in the table rather than the one
 * that was true when the cookie was minted. React's `cache` keeps it to
 * one query per request.
 */
export const getCurrentOperator = cache(
  async (): Promise<PlatformOperator | null> => {
    const store = await cookies();
    const token = store.get(COOKIE_NAME)?.value;
    if (!token) return null;

    let subject: string | undefined;
    try {
      const { payload } = await jwtVerify(token, secret(), {
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      subject = payload.sub;
    } catch {
      // Expired, tampered with, or signed for a different audience. All
      // three mean "not signed in" — never "signed in as somebody".
      return null;
    }

    const adminId = readPlatformSubject(subject);
    if (!adminId) return null;

    const admin = await platformDb.platformAdmin.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        deletedAt: true,
        mustChangePassword: true,
      },
    });

    if (!admin || admin.deletedAt || !admin.isActive) return null;

    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      mustChangePassword: admin.mustChangePassword,
    };
  },
);

/**
 * Server-component guard for every console page.
 *
 * An operator carrying `mustChangePassword` is bounced to the change
 * screen before reaching anything else — the first admin is created by a
 * script with a password somebody typed into a terminal, and that password
 * must not survive the first session.
 */
export async function requireOperator(
  options: { allowPasswordChange?: boolean; returnTo?: string } = {},
): Promise<PlatformOperator> {
  const operator = await getCurrentOperator();

  if (!operator) {
    redirect(
      options.returnTo
        ? `${PLATFORM_LOGIN_PATH}?next=${encodeURIComponent(options.returnTo)}`
        : PLATFORM_LOGIN_PATH,
    );
  }

  if (operator.mustChangePassword && !options.allowPasswordChange) {
    redirect(PLATFORM_PASSWORD_PATH);
  }

  return operator;
}

export function operatorCan(
  operator: PlatformOperator,
  capability: PlatformCapability,
): boolean {
  return platformCan(operator.role, capability);
}

export class PlatformAuthError extends Error {
  constructor(message = "Not signed in to the operator console.") {
    super(message);
    this.name = "PlatformAuthError";
  }
}

export class PlatformPermissionError extends Error {
  constructor(public capability: PlatformCapability) {
    super(`Operator role lacks: ${capability}`);
    this.name = "PlatformPermissionError";
  }
}

/** Page guard that renders the console's own 403 rather than a blank screen. */
export async function requireCapability(
  capability: PlatformCapability,
): Promise<PlatformOperator> {
  const operator = await requireOperator();
  if (!operatorCan(operator, capability)) redirect("/platform/forbidden");
  return operator;
}

/**
 * Guard for server actions, which must throw rather than redirect.
 *
 * Every mutation in the console starts with this call. It is the only
 * place a capability is checked, so a new action cannot be added that
 * quietly runs as whoever asked.
 */
export async function authorizeOperator(
  capability: PlatformCapability,
): Promise<PlatformOperator> {
  const operator = await getCurrentOperator();
  if (!operator) throw new PlatformAuthError();
  if (operator.mustChangePassword) {
    throw new PlatformAuthError(
      "Change your password before making changes to the platform.",
    );
  }
  if (!operatorCan(operator, capability)) {
    throw new PlatformPermissionError(capability);
  }
  return operator;
}
