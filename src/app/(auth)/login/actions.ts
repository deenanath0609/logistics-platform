"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signIn } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { issueOtp } from "@/lib/auth/otp";
import { deliverLoginCode } from "@/lib/auth/otp-delivery";

export type LoginState = {
  error?: string;
  /** Development only: the code, so field flows are testable without SMS. */
  devCode?: string;
  otpSentTo?: string;
};

const mobileSchema = z.string().regex(/^\d{10}$/, "Enter a 10-digit mobile number");

/**
 * Where a successful sign-in lands, as a path and never as a URL.
 *
 * Auth.js is asked not to redirect at all, and this is why. Given
 * `redirectTo`, it resolves that path against a base URL it works out for
 * itself — and in a production build behind a proxy it worked out
 * `http://localhost:3010`, the port the process listens on, no matter what
 * the request's `Host` said and no matter that `trustHost` was set. Every
 * carrier's sign-in was therefore answered inside a request whose host
 * belonged to no carrier: the tenant resolved to nobody, the user lookup
 * was refused, and the browser was handed a 404. The session had already
 * been issued, so typing the address again worked, which is what made it
 * look like a routing bug for most of a day.
 *
 * `next/navigation`'s `redirect` takes a path and stays on whatever host the
 * request arrived on, which is the only host that can be right here. There
 * is nothing to configure and nothing to keep in step with DNS.
 *
 * The path is still checked: an open redirect on a sign-in form is how a
 * phishing page borrows somebody's login.
 */
function landing(next: string): string {
  return next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}

export async function signInWithPassword(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const mobile = String(formData.get("mobile") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");

  if (!mobileSchema.safeParse(mobile).success) {
    return { error: "Enter a 10-digit mobile number." };
  }
  if (!password) {
    return { error: "Enter your password." };
  }

  try {
    // `redirect: false`, and then our own redirect. See `landing()` below.
    await signIn("password", { mobile, password, redirect: false });
  } catch (error) {
    if (error instanceof AuthError) {
      return {
        error:
          "Those details did not match. After 5 failed attempts the account locks for 15 minutes.",
      };
    }
    throw error;
  }

  redirect(landing(next));
}

export async function requestOtp(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const mobile = String(formData.get("mobile") ?? "").trim();

  if (!mobileSchema.safeParse(mobile).success) {
    return { error: "Enter a 10-digit mobile number." };
  }

  // `findFirst`, not `findUnique`: a mobile number is unique within a tenant,
  // not across the platform, so the same number can belong to a driver at two
  // carriers. The tenant filter is what makes this a single row again.
  const user = await prisma.user.findFirst({
    where: { mobile },
    select: { id: true, status: true, deletedAt: true },
  });

  // Do not reveal whether the number belongs to a user — that turns this
  // endpoint into a staff directory. Report success either way.
  if (!user || user.deletedAt || user.status !== "ACTIVE") {
    return { otpSentTo: mobile };
  }

  const { code, expiresAt } = await issueOtp({ destination: mobile, purpose: "LOGIN" });

  // Never logged. A login code printed to stdout is not a second factor —
  // it is the whole of authentication for this flow, sitting in a log
  // aggregator next to the mobile number it belongs to. `devCode` below is
  // the only place the code is returned, and it is gated on development.
  //
  // The send goes out on the carrier's own gateway account. It used to go
  // nowhere at all outside development, which meant a field user — created
  // without a password on purpose, because a driver should not be typing
  // one at a loading bay — could not sign in to a deployed system.
  const delivery = await deliverLoginCode({ mobile, code, expiresAt });

  if (!delivery.delivered) {
    // Deliberately not surfaced. Whether this number belongs to a staff
    // member is not something a sign-in form may reveal, and "we could not
    // send you a code" reveals it as plainly as "no such user" would. The
    // reason is in the log, where the people who can act on it will look.
    console.error("[auth] a login code could not be delivered", {
      reason: delivery.reason,
    });
  }

  return {
    otpSentTo: mobile,
    devCode: process.env.NODE_ENV === "development" ? code : undefined,
  };
}

export async function signInWithOtp(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const mobile = String(formData.get("mobile") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  const next = String(formData.get("next") ?? "/dashboard");

  if (!code) return { otpSentTo: mobile, error: "Enter the code you received." };

  try {
    await signIn("otp", { mobile, code, redirect: false });
  } catch (error) {
    if (error instanceof AuthError) {
      return {
        otpSentTo: mobile,
        error: "That code is not valid. Request a new one and try again.",
      };
    }
    throw error;
  }

  redirect(landing(next));
}
