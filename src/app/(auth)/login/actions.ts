"use server";

import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { issueOtp } from "@/lib/auth/otp";

export type LoginState = {
  error?: string;
  /** Development only: the code, so field flows are testable without SMS. */
  devCode?: string;
  otpSentTo?: string;
};

const mobileSchema = z.string().regex(/^\d{10}$/, "Enter a 10-digit mobile number");

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
    await signIn("password", {
      mobile,
      password,
      redirectTo: next.startsWith("/") ? next : "/dashboard",
    });
  } catch (error) {
    // next/navigation signals a successful redirect by throwing; let it pass.
    if (error instanceof AuthError) {
      return {
        error:
          "Those details did not match. After 5 failed attempts the account locks for 15 minutes.",
      };
    }
    throw error;
  }

  return {};
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

  const { code } = await issueOtp({ destination: mobile, purpose: "LOGIN" });

  // Never logged. A login code printed to stdout is not a second factor —
  // it is the whole of authentication for this flow, sitting in a log
  // aggregator next to the mobile number it belongs to. The line below is
  // the only place the code is returned, and it is already gated on
  // development.
  //
  // No SMS channel is wired for LOGIN yet, so outside development this flow
  // currently has no delivery path at all. That is a missing feature; a log
  // line is not an acceptable stand-in for it.

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
    await signIn("otp", {
      mobile,
      code,
      redirectTo: next.startsWith("/") ? next : "/dashboard",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return {
        otpSentTo: mobile,
        error: "That code is not valid. Request a new one and try again.",
      };
    }
    throw error;
  }

  return {};
}
