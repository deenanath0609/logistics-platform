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

  const user = await prisma.user.findUnique({
    where: { mobile },
    select: { id: true, status: true, deletedAt: true },
  });

  // Do not reveal whether the number belongs to a user — that turns this
  // endpoint into a staff directory. Report success either way.
  if (!user || user.deletedAt || user.status !== "ACTIVE") {
    return { otpSentTo: mobile };
  }

  const { code } = await issueOtp({ destination: mobile, purpose: "LOGIN" });

  // Phase 5 replaces this with the SMS channel.
  console.info(`[otp] login code for ${mobile}: ${code}`);

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
