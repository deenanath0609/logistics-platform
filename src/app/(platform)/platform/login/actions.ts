"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  authenticatePlatformAdmin,
  PLATFORM_LOCKOUT,
} from "@/lib/platform/credentials";
import {
  PLATFORM_PASSWORD_PATH,
  startPlatformSession,
} from "@/lib/platform/session";
import { checkRateLimit, clientKey } from "@/lib/portal/rate-limit";
import type { ConsoleFormState } from "@/components/platform/form-bits";

const schema = z.object({
  email: z.string().trim().email("Enter your operator email address"),
  password: z.string().min(1, "Enter your password"),
});

/**
 * Tighter than the portal's rule. There are a handful of operator logins
 * in existence, so a burst of attempts is never a busy afternoon — it is
 * somebody trying addresses.
 */
const OPERATOR_LOGIN_RULE = { limit: 5, windowMs: 300_000 };

export async function signInOperator(
  _prev: ConsoleFormState,
  formData: FormData,
): Promise<ConsoleFormState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check your details." };
  }

  // Two throttles, as on the portal: the per-account lockout inside
  // `authenticatePlatformAdmin` stops someone grinding one login, and this
  // per-IP limit stops someone spraying one password across many.
  const limit = await checkRateLimit(
    clientKey(await headers(), "platform-login"),
    OPERATOR_LOGIN_RULE,
  );
  if (!limit.ok) {
    return {
      error: `Too many attempts. Try again in ${Math.ceil(
        limit.retryAfterSeconds / 60,
      )} minute(s).`,
    };
  }

  const result = await authenticatePlatformAdmin(
    parsed.data.email,
    parsed.data.password,
  );

  if (!result.ok) {
    return {
      error: `Those details did not match. After ${PLATFORM_LOCKOUT.maxFailedLogins} failed attempts the login locks for ${PLATFORM_LOCKOUT.lockoutMinutes} minutes.`,
    };
  }

  await startPlatformSession(result.adminId);

  const next = String(formData.get("next") ?? "/platform");
  // Only ever inside the console. An open redirect on a sign-in form is
  // how a phishing page borrows somebody else's domain — and this domain
  // belongs to the operator of the whole platform.
  const target = next.startsWith("/platform") ? next : "/platform";

  redirect(result.mustChangePassword ? PLATFORM_PASSWORD_PATH : target);
}
