import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyOtp } from "@/lib/auth/otp";
import { authenticateCustomer } from "@/lib/auth/customer-credentials";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

const passwordSchema = z.object({
  mobile: z.string().regex(/^\d{10}$/, "Enter a 10-digit mobile number"),
  password: z.string().min(1),
});

const otpSchema = z.object({
  mobile: z.string().regex(/^\d{10}$/),
  code: z.string().regex(/^\d{4,8}$/),
});

const customerSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

type LoginOutcome =
  | "SUCCESS"
  | "BAD_CREDENTIALS"
  | "LOCKED"
  | "INACTIVE"
  | "OTP_FAILED";

async function recordAttempt(
  identifier: string,
  outcome: LoginOutcome,
  userId?: string,
) {
  await prisma.loginActivity.create({
    data: { identifier, outcome, userId },
  });
}

/**
 * Both sign-in flows converge here. Returns the user id only — roles and
 * permissions are deliberately NOT put in the token, so revoking a
 * permission takes effect on the very next request rather than whenever
 * the session happens to refresh.
 */
async function authenticate(
  mobile: string,
  verify: (user: {
    id: string;
    passwordHash: string | null;
  }) => Promise<boolean>,
  failureOutcome: LoginOutcome,
) {
  const user = await prisma.user.findUnique({
    where: { mobile },
    select: {
      id: true,
      name: true,
      email: true,
      mobile: true,
      status: true,
      passwordHash: true,
      failedLoginCount: true,
      lockedUntil: true,
      deletedAt: true,
    },
  });

  if (!user || user.deletedAt) {
    await recordAttempt(mobile, "BAD_CREDENTIALS");
    return null;
  }

  if (user.status !== "ACTIVE") {
    await recordAttempt(mobile, "INACTIVE", user.id);
    return null;
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await recordAttempt(mobile, "LOCKED", user.id);
    return null;
  }

  const valid = await verify(user);

  if (!valid) {
    const failed = user.failedLoginCount + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failed,
        lockedUntil:
          failed >= MAX_FAILED_LOGINS
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : null,
      },
    });
    await recordAttempt(mobile, failureOutcome, user.id);
    return null;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  await recordAttempt(mobile, "SUCCESS", user.id);

  return {
    id: user.id,
    name: user.name,
    email: user.email ?? undefined,
  };
}

export const authConfig: NextAuthConfig = {
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 },
  pages: { signIn: "/login" },
  trustHost: true,

  logger: {
    error(error) {
      /*
        A session cookie that will not decrypt is not an error worth
        raising. It happens whenever AUTH_SECRET is rotated — every
        existing cookie becomes unreadable at once — and the correct
        response is exactly what Auth.js already does: treat the visitor
        as signed out. Logging it turns a routine key rotation into a
        wall of stack traces and trains everyone to ignore the log.

        Everything else is passed through untouched.
      */
      if (error?.name === "JWTSessionError") {
        if (process.env.NODE_ENV === "development") {
          console.info(
            "[auth] discarded an unreadable session cookie — signing the visitor out",
          );
        }
        return;
      }
      console.error("[auth]", error);
    },
    warn(code) {
      console.warn("[auth]", code);
    },
    debug() {
      // Auth.js debug output is extremely noisy; opt in deliberately.
    },
  },
  providers: [
    Credentials({
      id: "password",
      name: "Mobile and password",
      credentials: {
        mobile: { label: "Mobile", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = passwordSchema.safeParse(raw);
        if (!parsed.success) return null;

        const { mobile, password } = parsed.data;
        return authenticate(
          mobile,
          async (user) =>
            Boolean(user.passwordHash) &&
            bcrypt.compare(password, user.passwordHash!),
          "BAD_CREDENTIALS",
        );
      },
    }),

    Credentials({
      id: "otp",
      name: "Mobile and OTP",
      credentials: {
        mobile: { label: "Mobile", type: "text" },
        code: { label: "Code", type: "text" },
      },
      async authorize(raw) {
        const parsed = otpSchema.safeParse(raw);
        if (!parsed.success) return null;

        const { mobile, code } = parsed.data;
        return authenticate(
          mobile,
          () => verifyOtp({ destination: mobile, purpose: "LOGIN", code }),
          "OTP_FAILED",
        );
      },
    }),

    /**
     * Portal customers. A different table, a different credential shape,
     * and a subject namespaced with `customer:` so the id it yields can
     * never be resolved against `app_user` — see lib/auth/subject.ts.
     */
    Credentials({
      id: "customer",
      name: "Customer portal",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = customerSchema.safeParse(raw);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;
        return authenticateCustomer(email, password);
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
};
