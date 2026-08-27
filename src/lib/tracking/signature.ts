import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Inbound webhook verification for telematics providers.
 *
 * This is the mirror image of `@/lib/webhooks/signature`, which signs what
 * we send to partners. It is a separate file on purpose: there we set the
 * rules, here we live with whatever the vendor already does, and merging
 * the two would mean loosening the outbound scheme to accommodate the
 * laxest inbound one.
 *
 * HMAC-SHA256 over the raw request body. The raw bytes are signed, never a
 * re-serialised object — two JSON encoders disagree about key order and
 * whitespace, and a receiver that verifies against its own re-encoding
 * rejects perfectly good deliveries.
 *
 * Common header prefixes are tolerated (`sha256=`, `v1=`) and both hex and
 * base64 digests are accepted, because vendors differ and none of them will
 * change for us.
 */

export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function normalise(signature: string): string {
  const trimmed = signature.trim();
  const separator = trimmed.indexOf("=");
  // `sha256=abc…` / `v1=abc…`, but not a bare base64 digest whose padding
  // happens to contain an equals sign at the end.
  if (separator > 0 && separator < 10) return trimmed.slice(separator + 1);
  return trimmed;
}

function equals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "mismatch" };

/**
 * Constant-time comparison against the expected digest.
 *
 * An absent secret fails closed. A provider configured without a secret is
 * a misconfiguration, and the safe reading of "no secret" is "reject
 * everything", not "accept everything" — the alternative is an open
 * endpoint that writes positions for any vehicle in the fleet.
 */
export function verifySignature(input: {
  secret: string | null | undefined;
  body: string;
  signature: string | null | undefined;
}): VerifyResult {
  if (!input.secret || !input.signature) return { ok: false, reason: "missing" };

  const expected = signBody(input.secret, input.body);
  const supplied = normalise(input.signature);

  if (equals(Buffer.from(expected, "utf8"), Buffer.from(supplied.toLowerCase(), "utf8"))) {
    return { ok: true };
  }

  // Some vendors send base64. Compare the raw digest bytes rather than
  // guessing from the string's shape.
  const expectedBytes = Buffer.from(expected, "hex");
  const suppliedBytes = Buffer.from(supplied, "base64");
  if (suppliedBytes.length === expectedBytes.length && equals(expectedBytes, suppliedBytes)) {
    return { ok: true };
  }

  return { ok: false, reason: "mismatch" };
}
