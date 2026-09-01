"use server";

import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/session";
import { recordAudit } from "@/server/services/audit";

export type StaffPasswordState = {
  error?: string;
  fieldErrors?: Record<string, string>;
};

/**
 * Staff password rules, in one place.
 *
 * The floor is eight characters because that is what `createUser` and
 * `resetPassword` already enforce on the password an administrator hands
 * out — a change screen that demanded more than the credential it replaces
 * would refuse people the password they were just given as their "current"
 * one, and the first thing anyone would do is ask the administrator to set
 * a longer temporary one, which is the opposite of the point.
 */
const MIN_LENGTH = 8;

const schema = z
  .object({
    current: z.string().min(1, "Enter your current password"),
    next: z
      .string()
      .min(MIN_LENGTH, `At least ${MIN_LENGTH} characters`)
      .max(200, "That is too long")
      .refine((value) => /[a-z]/i.test(value), "Include at least one letter")
      .refine((value) => /\d/.test(value), "Include at least one digit"),
    confirm: z.string(),
  })
  .refine((value) => value.next === value.confirm, {
    message: "The two passwords do not match",
    path: ["confirm"],
  })
  .refine((value) => value.next !== value.current, {
    message: "Choose a password you have not used here before",
    path: ["next"],
  });

/**
 * ── The forced first change, and the everyday one ────────────────────────
 *
 * `createUser` writes `mustChangePassword: true` for anybody given a
 * password, and `resetPassword` says out loud "They must change it at next
 * sign-in". Neither statement was true: no screen existed for carrier
 * staff, nothing read the flag on the tenant side, and the temporary
 * password an administrator read down a telephone stayed the account's
 * real password for as long as the account existed. `/platform/password`
 * is the operator console's, on another host, behind another session.
 *
 * The flag is now enforced in `requireUser`, which every ops and field page
 * goes through, and this is the one screen it lets past.
 * ────────────────────────────────────────────────────────────────────────
 */
export async function changeStaffPassword(
  _prev: StaffPasswordState,
  formData: FormData,
): Promise<StaffPasswordState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Your session has expired. Sign in again." };

  try {
    const parsed = schema.safeParse({
      current: formData.get("current"),
      next: formData.get("next"),
      confirm: formData.get("confirm"),
    });

    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return { error: "Check the highlighted fields.", fieldErrors };
    }

    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    // A field user signs in with a one-time code and has no password at
    // all, so there is nothing here to change and no "current" to prove.
    // Refusing is the honest answer — the alternative is letting anyone who
    // borrows an unlocked phone set a password on a driver's account.
    if (!row?.passwordHash) {
      return {
        error:
          "This account signs in with a one-time code, so it has no password to change.",
      };
    }

    if (!(await bcrypt.compare(parsed.data.current, row.passwordHash))) {
      return {
        error: "That is not your current password.",
        fieldErrors: { current: "Incorrect" },
      };
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(parsed.data.next, 10),
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        // A successful change clears whatever lockout the old password
        // earned on the way here.
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    // The new hash is never in the row — `recordAudit` redacts
    // `passwordHash` — so this records that it happened and when, which is
    // what a later "who changed this account's password" question needs.
    await recordAudit({
      user,
      action: "UPDATE",
      entity: "User",
      entityId: user.id,
      entityRef: user.mobile,
      reason: "Password changed by the account holder",
      after: { passwordChangedAt: new Date().toISOString() },
    });
  } catch (error) {
    console.error("[staff password]", error);
    return { error: "Something went wrong. Your password was not changed." };
  }

  // Back to where that person actually works. A delivery agent whose
  // password an administrator reset is bounced here like anyone else, and
  // sending them to the operations dashboard would land them on a screen
  // built for a desk.
  redirect(user.isFieldUser ? "/delivery" : "/dashboard");
}
