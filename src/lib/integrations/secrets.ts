import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "@/lib/env";

/**
 * Encryption at rest for one carrier's key to an outside service.
 *
 * ── The stored format ────────────────────────────────────────
 *
 *     v1.<iv>.<tag>.<ciphertext>
 *
 * Four dot-separated parts, each base64url:
 *
 *   - `v1`         the format version. Present so a future scheme can be
 *                  introduced without a migration that has to guess what
 *                  the rows already contain.
 *   - `iv`         12 random bytes, fresh per encryption. GCM's nonce.
 *                  Reusing one under the same key destroys the cipher, so
 *                  it is never derived from anything.
 *   - `tag`        16-byte GCM authentication tag.
 *   - `ciphertext` AES-256-GCM output.
 *
 * base64url rather than base64 so the string survives a URL, a log line
 * and a JSON blob without escaping, and `.` is the separator because it
 * appears in none of the three alphabets.
 *
 * ── Why GCM, and why that matters here ───────────────────────
 *
 * The failure this file exists to prevent is not "someone reads the
 * database". It is decryption under the wrong key returning *something* —
 * 32 bytes of noise that the code above happily posts to an SMS gateway as
 * an API key. The gateway rejects it, the rejection looks like every other
 * gateway error, and the actual cause (a mis-set `CREDENTIALS_KEY` on one
 * of three app servers) is invisible. GCM's tag makes that impossible:
 * a wrong key, a truncated string, a flipped bit and a row copied from
 * another tenant all fail the tag check, and every one of them throws.
 *
 * ── The context binding ──────────────────────────────────────
 *
 * Every call names a `context` — `"<orgId>:<kind>"` at the only call site —
 * which is fed to GCM as additional authenticated data. It is not secret
 * and it is not stored; it is recomputed on decryption from the row being
 * read. The effect is that ciphertext lifted out of carrier A's SMS row and
 * pasted into carrier B's will not decrypt, so a bad UPDATE cannot silently
 * hand one carrier another's gateway account.
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * The key is missing or unusable. A configuration fault, not a data fault:
 * nothing is wrong with the stored row and nothing should be re-saved.
 */
export class CredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialKeyError";
  }
}

/**
 * The stored value did not authenticate. Wrong key, tampered row, or a row
 * belonging to a different tenant or service.
 *
 * Separate from `CredentialKeyError` because the operational response
 * differs: this one means "do not send anything", and the caller must not
 * paper over it with a fallback to the platform's shared account — falling
 * back on a *decryption failure* would turn a mis-deployed key into a
 * silent re-routing of every carrier's traffic onto our own bill.
 */
export class CredentialDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialDecryptError";
  }
}

/**
 * The key, resolved at the moment it is needed rather than at boot.
 *
 * Deliberately not required by the environment schema. A developer who has
 * never opened the credentials screen has no encrypted rows to read, and
 * blocking their `npm run dev` on a variable they do not need yet is how a
 * setup step gets copied around as `CREDENTIALS_KEY=changeme`.
 */
function key(): Buffer {
  const raw = getEnv().CREDENTIALS_KEY.trim();

  if (!raw) {
    throw new CredentialKeyError(
      "CREDENTIALS_KEY is not set, and a carrier's own gateway credential " +
        "cannot be read or written without it. Generate one with " +
        "`node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"` " +
        "and set it in the environment. Losing it means every stored secret " +
        "has to be re-entered by hand, so keep it with the database backups.",
    );
  }

  // Hex is what most key-generation snippets print; base64url is what the
  // message above suggests. Both are accepted, and anything that does not
  // decode to exactly 32 bytes is refused rather than padded or hashed into
  // shape — a silently stretched key is a key nobody can reproduce.
  const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64url");

  if (bytes.length !== KEY_BYTES) {
    throw new CredentialKeyError(
      `CREDENTIALS_KEY must decode to ${KEY_BYTES} bytes (64 hex characters, ` +
        `or 43 base64url characters); this one decodes to ${bytes.length}.`,
    );
  }

  return bytes;
}

/** True when a key is present and well-formed. For the operator screen. */
export function credentialsKeyConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypts one secret for storage in `TenantCredential.secret`.
 *
 * `context` binds the result to where it is about to be stored — see the
 * note at the top of the file.
 */
export function encryptSecret(plaintext: string, context: string): string {
  if (!plaintext) {
    throw new CredentialKeyError(
      "Refusing to encrypt an empty secret. Clearing a credential is an " +
        "explicit action that writes NULL, not an empty ciphertext.",
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(context, "utf8"));

  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

/**
 * Decrypts a stored secret, or throws.
 *
 * There is no "return null on failure" variant of this function, on
 * purpose. Every caller is about to authenticate to somebody's gateway,
 * and there is no useful thing to do with a secret that did not
 * authenticate to us first.
 */
export function decryptSecret(stored: string, context: string): string {
  const parts = stored.split(".");

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new CredentialDecryptError(
      `Stored credential is not in the expected "${VERSION}.<iv>.<tag>.<ciphertext>" ` +
        "format. It was written by a different version of this code, or the " +
        "column was edited by hand.",
    );
  }

  const [, ivPart, tagPart, bodyPart] = parts;
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");

  // Checked before `createDecipheriv`, which throws a Node error naming
  // neither the credential nor the likely cause.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CredentialDecryptError(
      "Stored credential has a malformed IV or authentication tag; it has " +
        "been truncated or altered since it was written.",
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key(), iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);

    return (
      decipher.update(Buffer.from(bodyPart, "base64url")).toString("utf8") +
      decipher.final("utf8")
    );
  } catch (error) {
    // `CredentialKeyError` is a configuration fault and keeps its own
    // identity; anything else out of the cipher is a failed tag check.
    if (error instanceof CredentialKeyError) throw error;

    throw new CredentialDecryptError(
      `Stored credential for ${context} failed authentication. Either ` +
        "CREDENTIALS_KEY is not the key it was encrypted under — check every " +
        "app server, not just this one — or the row has been altered. " +
        "Nothing was sent, and nothing should be: the alternative is posting " +
        "an unauthenticated value to a live gateway as if it were a key.",
      { cause: error },
    );
  }
}
