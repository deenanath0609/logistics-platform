"use server";

import { headers } from "next/headers";
import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn } from "@/lib/auth";
import { PORTAL_LOCKOUT } from "@/lib/auth/customer-credentials";
import {
  checkRateLimit,
  clientKey,
  PORTAL_LOGIN_RULE,
} from "@/lib/portal/rate-limit";

export type PortalLoginState = { error?: string };

const schema = z.object({
  email: z.string().trim().email("Enter the email address you were invited on"),
  password: z.string().min(1, "Enter your password"),
});

/**
 * Portal sign-in.
 *
 * Two throttles, deliberately: the per-account lockout in
 * `authenticateCustomer` stops someone grinding one login, and the per-IP
 * limit here stops someone spraying one password across many.
 */
export async function signInCustomer(
  _prev: PortalLoginState,
  formData: FormData,
): Promise<PortalLoginState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check your details." };
  }

  const limit = checkRateLimit(
    clientKey(await headers(), "portal-login"),
    PORTAL_LOGIN_RULE,
  );

  if (!limit.ok) {
    return {
      error: `Too many attempts. Try again in ${Math.ceil(
        limit.retryAfterSeconds / 60,
      )} minute(s).`,
    };
  }

  const next = String(formData.get("next") ?? "/portal");

  try {
    await signIn("customer", {
      email: parsed.data.email,
      password: parsed.data.password,
      // Only ever inside the portal — an open redirect on a sign-in form
      // is how a phishing page borrows someone else's domain.
      redirectTo: next.startsWith("/portal") ? next : "/portal",
    });
  } catch (error) {
    // A successful redirect is signalled by throwing; let that through.
    if (error instanceof AuthError) {
      return {
        error: `Those details did not match. After ${PORTAL_LOCKOUT.maxFailedLogins} failed attempts the login locks for ${PORTAL_LOCKOUT.lockoutMinutes} minutes.`,
      };
    }
    throw error;
  }

  return {};
}
