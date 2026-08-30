import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The failure this file is about is not "somebody read the database".
 *
 * It is decryption under the wrong key returning *something* — bytes that
 * the code above posts to a live gateway as an API key. The gateway rejects
 * it, the rejection looks like every other gateway error, and the actual
 * cause (one app server deployed with a stale `CREDENTIALS_KEY`) stays
 * invisible for as long as anybody is willing to look at gateway logs. So
 * the assertions below are mostly about *throwing*, and every one of them
 * would pass just as happily against a function that returned rubbish if it
 * were not written as `rejects`/`toThrow`.
 */

const env = vi.hoisted(() => ({
  current: { CREDENTIALS_KEY: "" } as Record<string, unknown>,
}));

vi.mock("@/lib/env", () => ({ getEnv: () => env.current }));

const {
  CredentialDecryptError,
  CredentialKeyError,
  credentialsKeyConfigured,
  decryptSecret,
  encryptSecret,
} = await import("./secrets");

/** Two different 32-byte keys, written the two ways the parser accepts. */
const KEY_A = Buffer.alloc(32, 0xa1).toString("base64url");
const KEY_B = Buffer.alloc(32, 0xb2).toString("hex");

const CONTEXT = "org_acme:SMS";

beforeEach(() => {
  env.current = { CREDENTIALS_KEY: KEY_A };
});

describe("round trip", () => {
  it("returns exactly what was encrypted", () => {
    const secret = "sk_live_9f2c4a77e1b04d38a5c6";

    expect(decryptSecret(encryptSecret(secret, CONTEXT), CONTEXT)).toBe(secret);
  });

  it("survives non-ASCII and length, because keys are not all hex", () => {
    const secret = `${"x".repeat(4096)}·Ünïcøde·🔑`;

    expect(decryptSecret(encryptSecret(secret, CONTEXT), CONTEXT)).toBe(secret);
  });

  it("never produces the same ciphertext twice for the same input", () => {
    // A fresh IV per encryption. Two identical outputs would mean a reused
    // nonce, which under GCM does not merely leak equality — it lets an
    // attacker with two messages recover the authentication subkey.
    const first = encryptSecret("same", CONTEXT);
    const second = encryptSecret("same", CONTEXT);

    expect(first).not.toBe(second);
    expect(decryptSecret(second, CONTEXT)).toBe("same");
  });

  it("accepts a key given as hex as readily as base64url", () => {
    env.current.CREDENTIALS_KEY = KEY_B;

    expect(decryptSecret(encryptSecret("k", CONTEXT), CONTEXT)).toBe("k");
  });
});

describe("the stored format", () => {
  it("is four dot-separated parts led by the version", () => {
    const parts = encryptSecret("k", CONTEXT).split(".");

    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    // 12-byte IV and 16-byte tag, base64url and therefore unpadded.
    expect(Buffer.from(parts[1], "base64url")).toHaveLength(12);
    expect(Buffer.from(parts[2], "base64url")).toHaveLength(16);
  });

  it("does not contain the plaintext", () => {
    expect(encryptSecret("sk_live_TELLTALE", CONTEXT)).not.toContain("TELLTALE");
  });
});

describe("a wrong key fails loudly", () => {
  it("throws rather than returning rubbish", () => {
    const stored = encryptSecret("sk_live_real", CONTEXT);
    env.current.CREDENTIALS_KEY = KEY_B;

    expect(() => decryptSecret(stored, CONTEXT)).toThrow(CredentialDecryptError);
  });

  it("says what to check, because the cause is a deployment not a row", () => {
    const stored = encryptSecret("sk_live_real", CONTEXT);
    env.current.CREDENTIALS_KEY = KEY_B;

    expect(() => decryptSecret(stored, CONTEXT)).toThrow(
      /every app server, not just this one/,
    );
  });

  it("refuses a tampered ciphertext", () => {
    const parts = encryptSecret("sk_live_real", CONTEXT).split(".");
    const body = Buffer.from(parts[3], "base64url");
    body[0] ^= 0xff;
    parts[3] = body.toString("base64url");

    expect(() => decryptSecret(parts.join("."), CONTEXT)).toThrow(
      CredentialDecryptError,
    );
  });

  it("refuses a row lifted from another carrier or another service", () => {
    // The context is additional authenticated data, so ciphertext moved
    // between rows by a bad UPDATE cannot quietly hand one carrier another's
    // gateway account.
    const stored = encryptSecret("sk_live_acme", "org_acme:SMS");

    expect(() => decryptSecret(stored, "org_bharat:SMS")).toThrow(
      CredentialDecryptError,
    );
    expect(() => decryptSecret(stored, "org_acme:SMTP")).toThrow(
      CredentialDecryptError,
    );
  });

  it("refuses something that is not in the format at all", () => {
    for (const junk of ["", "hello", "v1.aaa", "v2.a.b.c", "v1.a.b.c"]) {
      expect(() => decryptSecret(junk, CONTEXT)).toThrow(CredentialDecryptError);
    }
  });
});

describe("a missing key", () => {
  it("is a configuration fault with its own type, not a decryption failure", () => {
    env.current.CREDENTIALS_KEY = "";

    expect(() => encryptSecret("k", CONTEXT)).toThrow(CredentialKeyError);
    expect(credentialsKeyConfigured()).toBe(false);
  });

  it("says how to generate one", () => {
    env.current.CREDENTIALS_KEY = "   ";

    expect(() => encryptSecret("k", CONTEXT)).toThrow(/randomBytes\(32\)/);
  });

  it("refuses a key of the wrong length rather than stretching it", () => {
    // Padding or hashing a short key into shape would produce a key nobody
    // can reproduce from what they set — and it would work, right up to the
    // day somebody sets the correct length.
    env.current.CREDENTIALS_KEY = Buffer.alloc(16, 1).toString("base64url");

    expect(() => encryptSecret("k", CONTEXT)).toThrow(/32 bytes/);
  });

  it("refuses to encrypt an empty secret", () => {
    // Clearing a credential writes NULL and moves the carrier back to the
    // shared account, which is a deliberate action with an audit row. An
    // empty ciphertext would look like an account that is configured.
    expect(() => encryptSecret("", CONTEXT)).toThrow(CredentialKeyError);
  });
});
