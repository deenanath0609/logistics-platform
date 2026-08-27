"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  authorizeCustomer,
  CustomerAuthError,
} from "@/lib/auth/customer-session";
import {
  hashPassword,
  passwordSchema,
  verifyPassword,
} from "@/lib/portal/passwords";

export type PasswordState = { error?: string; fieldErrors?: Record<string, string> };

const schema = z
  .object({
    current: z.string().min(1, "Enter your current password"),
    next: passwordSchema,
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
 * Forced first change, and the everyday change afterwards.
 *
 * An invited sub-user signs in with a password their account owner chose
 * and read down a phone. `mustChangePassword` keeps that credential from
 * outliving the first session, and `requireCustomerUser` bounces every
 * other portal page here until it is done.
 */
export async function changePortalPassword(
  _prev: PasswordState,
  formData: FormData,
): Promise<PasswordState> {
  try {
    const session = await authorizeCustomer();

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

    const user = await prisma.customerUser.findUnique({
      where: { id: session.id },
      select: { passwordHash: true },
    });

    if (!(await verifyPassword(parsed.data.current, user?.passwordHash ?? null))) {
      return {
        error: "That is not your current password.",
        fieldErrors: { current: "Incorrect" },
      };
    }

    await prisma.customerUser.update({
      where: { id: session.id },
      data: {
        passwordHash: await hashPassword(parsed.data.next),
        mustChangePassword: false,
        // A successful change clears any lockout the old password earned.
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
  } catch (error) {
    if (error instanceof CustomerAuthError) {
      return { error: "Your session has expired. Sign in again." };
    }
    console.error("[portal password]", error);
    return { error: "Something went wrong. Your password was not changed." };
  }

  redirect("/portal");
}
