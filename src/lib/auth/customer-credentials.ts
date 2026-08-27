import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { customerSubject } from "@/lib/auth/subject";

/**
 * Portal sign-in.
 *
 * Deliberately a separate code path from `authenticate()` in config.ts,
 * against a separate table. The two flows look similar — lockout, activity
 * log, constant answer on failure — but merging them is exactly how a
 * customer ends up holding a staff session six months later.
 */

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

/**
 * `LoginActivity.userId` is a foreign key into `app_user`, so a portal
 * attempt can never fill it. The identifier carries a marker instead, which
 * keeps the two populations separable in the activity report and stops a
 * customer email colliding with a staff mobile number.
 */
export const PORTAL_IDENTIFIER_PREFIX = "portal:";

type PortalOutcome = "SUCCESS" | "BAD_CREDENTIALS" | "LOCKED" | "INACTIVE";

async function recordPortalAttempt(email: string, outcome: PortalOutcome) {
  await prisma.loginActivity.create({
    data: {
      identifier: `${PORTAL_IDENTIFIER_PREFIX}${email}`,
      outcome,
      // Never set: this column points at staff, and a customer is not one.
      userId: null,
    },
  });
}

export type CustomerCredentialResult = {
  /** Namespaced subject — never a bare CustomerUser id. */
  id: string;
  name: string;
  email: string;
};

/**
 * Verifies an email and password against `CustomerUser`.
 *
 * Returns null for wrong password, unknown email, deactivated account and
 * locked account alike. The caller must not tell them apart, or the sign-in
 * form becomes a customer directory.
 */
export async function authenticateCustomer(
  email: string,
  password: string,
): Promise<CustomerCredentialResult | null> {
  const normalised = email.trim().toLowerCase();

  const user = await prisma.customerUser.findUnique({
    where: { email: normalised },
    select: {
      id: true,
      name: true,
      email: true,
      passwordHash: true,
      isActive: true,
      deletedAt: true,
      failedLoginCount: true,
      lockedUntil: true,
      customer: { select: { isActive: true, deletedAt: true } },
    },
  });

  if (!user || user.deletedAt || !user.passwordHash) {
    await recordPortalAttempt(normalised, "BAD_CREDENTIALS");
    return null;
  }

  // The account behind the login matters as much as the login: a customer
  // whose relationship has been closed loses the portal with it.
  if (!user.isActive || !user.customer.isActive || user.customer.deletedAt) {
    await recordPortalAttempt(normalised, "INACTIVE");
    return null;
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await recordPortalAttempt(normalised, "LOCKED");
    return null;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);

  if (!valid) {
    const failed = user.failedLoginCount + 1;
    await prisma.customerUser.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failed,
        lockedUntil:
          failed >= MAX_FAILED_LOGINS
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : null,
      },
    });
    await recordPortalAttempt(normalised, "BAD_CREDENTIALS");
    return null;
  }

  await prisma.customerUser.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  // Stamps the invitation as taken up, once. `updateMany` with the null
  // guard keeps the original acceptance date on every later sign-in.
  await prisma.customerUser.updateMany({
    where: { id: user.id, acceptedAt: null },
    data: { acceptedAt: new Date() },
  });

  await recordPortalAttempt(normalised, "SUCCESS");

  return {
    id: customerSubject(user.id),
    name: user.name,
    email: user.email,
  };
}

export const PORTAL_LOCKOUT = {
  maxFailedLogins: MAX_FAILED_LOGINS,
  lockoutMinutes: LOCKOUT_MINUTES,
};
