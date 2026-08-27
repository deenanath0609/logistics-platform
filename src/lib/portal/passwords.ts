import bcrypt from "bcryptjs";
import { z } from "zod";

/**
 * Portal password rules.
 *
 * Kept in one module so the invite flow, the forced first change and any
 * future reset all agree — three copies of "at least eight characters"
 * become three different rules within a year.
 */

const BCRYPT_ROUNDS = 10;

export const passwordSchema = z
  .string()
  .min(10, "At least 10 characters")
  .max(200, "That is too long")
  .refine((value) => /[a-z]/i.test(value), "Include at least one letter")
  .refine((value) => /\d/.test(value), "Include at least one digit");

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(
  plain: string,
  hash: string | null,
): Promise<boolean> {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}

/**
 * A readable temporary password for an invited sub-user.
 *
 * Ambiguous characters are left out because this gets read down a phone.
 * It is single-use by construction: the invited login carries
 * `mustChangePassword`, so it cannot survive the first session.
 */
export function generateTemporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);

  const blocks = [...bytes].map((value) => {
    let block = "";
    let remaining = value;
    for (let i = 0; i < 4; i += 1) {
      block += alphabet[remaining % alphabet.length];
      remaining = Math.floor(remaining / alphabet.length);
    }
    return block;
  });

  return blocks.join("-");
}
