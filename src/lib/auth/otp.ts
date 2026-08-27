import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import type { OtpPurpose } from "@/generated/prisma/client";

const DEFAULT_TTL_SECONDS = Number(process.env.OTP_TTL_SECONDS ?? 300);
const DEFAULT_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS ?? 5);

/** Six digits, no leading-zero bias. */
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export type IssueOtpInput = {
  destination: string;
  purpose: OtpPurpose;
  /** shipmentId, userId — whatever this code is proving. */
  referenceId?: string;
  ttlSeconds?: number;
};

/**
 * Issues a one-time code. The plaintext is returned so the caller can hand
 * it to the SMS channel; only the hash is stored.
 *
 * Until the SMS provider is wired up in Phase 5, development returns the
 * code to the caller so field flows can be tested end to end.
 */
export async function issueOtp(input: IssueOtpInput) {
  const code = generateCode();
  const expiresAt = new Date(
    Date.now() + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000,
  );

  // Retire any outstanding codes for the same destination and purpose, so
  // an older SMS cannot be replayed after a resend.
  await prisma.otpToken.updateMany({
    where: {
      destination: input.destination,
      purpose: input.purpose,
      referenceId: input.referenceId ?? null,
      consumedAt: null,
    },
    data: { consumedAt: new Date() },
  });

  await prisma.otpToken.create({
    data: {
      destination: input.destination,
      purpose: input.purpose,
      referenceId: input.referenceId,
      codeHash: await bcrypt.hash(code, 10),
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      expiresAt,
    },
  });

  return { code, expiresAt };
}

export type VerifyOtpInput = {
  destination: string;
  purpose: OtpPurpose;
  code: string;
  referenceId?: string;
};

/**
 * Consumes a code. Returns false for wrong, expired, already-used, and
 * too-many-attempts alike — the caller must not tell the user which,
 * or the endpoint becomes an oracle.
 */
export async function verifyOtp(input: VerifyOtpInput): Promise<boolean> {
  const token = await prisma.otpToken.findFirst({
    where: {
      destination: input.destination,
      purpose: input.purpose,
      referenceId: input.referenceId ?? null,
      consumedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!token) return false;

  if (token.expiresAt < new Date() || token.attempts >= token.maxAttempts) {
    await prisma.otpToken.update({
      where: { id: token.id },
      data: { consumedAt: new Date() },
    });
    return false;
  }

  const matches = await bcrypt.compare(input.code, token.codeHash);

  if (!matches) {
    await prisma.otpToken.update({
      where: { id: token.id },
      data: { attempts: { increment: 1 } },
    });
    return false;
  }

  await prisma.otpToken.update({
    where: { id: token.id },
    data: { consumedAt: new Date() },
  });

  return true;
}
