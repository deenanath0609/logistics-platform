import bcrypt from "bcryptjs";
import { platformDb } from "@/lib/platform/db";
import { recordPlatformAudit, requestMeta } from "@/lib/platform/audit";

/**
 * Operator sign-in.
 *
 * A third credential path, against a third table, for the third
 * population. It looks like `authenticate()` in `lib/auth/config.ts` and
 * like `authenticateCustomer()` — lockout, constant answer on failure —
 * and merging any two of them is exactly how a support login ends up
 * holding a tenant session.
 *
 * One thing here is deliberately unlike both: there is no tenant. The
 * lookup is by email across the whole platform, because the operator is
 * not a member of any carrier and the host it signs in on names none.
 */

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export const PLATFORM_LOCKOUT = {
  maxFailedLogins: MAX_FAILED_LOGINS,
  lockoutMinutes: LOCKOUT_MINUTES,
};

/** The minimum a console password may be. Enforced on change, not on check. */
export const MIN_PASSWORD_LENGTH = 12;

export type PlatformCredentialResult =
  | { ok: true; adminId: string; mustChangePassword: boolean }
  | { ok: false };

/**
 * Verifies an email and password against `PlatformAdmin`.
 *
 * Returns the same failure for a wrong password, an unknown address, a
 * deactivated login and a locked one. The caller must not tell them apart:
 * this form is reachable by anyone who can resolve `admin.<root>`, and an
 * answer that distinguishes them turns it into a staff directory for the
 * company that runs the platform.
 */
export async function authenticatePlatformAdmin(
  email: string,
  password: string,
): Promise<PlatformCredentialResult> {
  const normalised = email.trim().toLowerCase();

  const admin = await platformDb.platformAdmin.findUnique({
    where: { email: normalised },
    select: {
      id: true,
      name: true,
      passwordHash: true,
      isActive: true,
      deletedAt: true,
      mustChangePassword: true,
      failedLoginCount: true,
      lockedUntil: true,
    },
  });

  const meta = await requestMeta();

  if (!admin || admin.deletedAt || !admin.isActive) {
    // No audit row for an address that matches nobody: the trail would
    // fill with whatever a scanner typed, and there is no actor to name.
    return { ok: false };
  }

  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    await recordPlatformAudit({
      action: "operator.signin.locked",
      actor: { id: admin.id, name: admin.name },
      ...meta,
    });
    return { ok: false };
  }

  const valid = await bcrypt.compare(password, admin.passwordHash);

  if (!valid) {
    const failed = admin.failedLoginCount + 1;
    await platformDb.platformAdmin.update({
      where: { id: admin.id },
      data: {
        failedLoginCount: failed,
        lockedUntil:
          failed >= MAX_FAILED_LOGINS
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : null,
      },
    });
    await recordPlatformAudit({
      action: "operator.signin.failed",
      actor: { id: admin.id, name: admin.name },
      after: { failedLoginCount: failed },
      ...meta,
    });
    return { ok: false };
  }

  await platformDb.platformAdmin.update({
    where: { id: admin.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  await recordPlatformAudit({
    action: "operator.signin",
    actor: { id: admin.id, name: admin.name },
    ...meta,
  });

  return {
    ok: true,
    adminId: admin.id,
    mustChangePassword: admin.mustChangePassword,
  };
}

export type PasswordChangeResult = { ok: true } | { ok: false; error: string };

/**
 * Changes an operator's own password and clears `mustChangePassword`.
 *
 * The current password is required even though the caller is already
 * signed in — an unattended session is the ordinary way an account is
 * taken over, and a change that needs no secret hands it over permanently.
 */
export async function changeOwnPassword(
  adminId: string,
  currentPassword: string,
  newPassword: string,
): Promise<PasswordChangeResult> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Use at least ${MIN_PASSWORD_LENGTH} characters — this login can suspend a company.`,
    };
  }
  if (newPassword === currentPassword) {
    return { ok: false, error: "Choose a password you have not used here." };
  }

  const admin = await platformDb.platformAdmin.findUnique({
    where: { id: adminId },
    select: { id: true, name: true, passwordHash: true },
  });
  if (!admin) return { ok: false, error: "That login no longer exists." };

  if (!(await bcrypt.compare(currentPassword, admin.passwordHash))) {
    return { ok: false, error: "The current password did not match." };
  }

  await platformDb.platformAdmin.update({
    where: { id: adminId },
    data: {
      passwordHash: await bcrypt.hash(newPassword, 12),
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  await recordPlatformAudit({
    action: "operator.password.change",
    actor: { id: admin.id, name: admin.name },
    entity: "PlatformAdmin",
    entityId: admin.id,
    ...(await requestMeta()),
  });

  return { ok: true };
}
