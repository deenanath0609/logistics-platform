import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signing.
 *
 * HMAC-SHA256 over `<timestamp>.<raw body>`, with the timestamp sent in
 * its own header. Signing the timestamp alongside the body is what makes
 * the signature useless to a replayer: a captured request cannot be re-sent
 * an hour later, because the receiver rejects a stale timestamp and the
 * attacker cannot re-sign a fresh one.
 *
 * The *raw* body is signed, never a re-serialised object — two JSON
 * encoders disagree about key order and whitespace, and a receiver that
 * verifies against its own re-encoding will fail on perfectly good
 * deliveries.
 */

export const SIGNATURE_HEADER = "X-CL-Signature";
export const TIMESTAMP_HEADER = "X-CL-Timestamp";
export const EVENT_HEADER = "X-CL-Event";
export const DELIVERY_HEADER = "X-CL-Delivery";

/** Default replay window, in seconds. Generous enough for a slow queue. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** `v1=<hex>`, versioned so the scheme can change without breaking receivers. */
export function signWebhook(
  secret: string,
  timestampSeconds: number,
  body: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`, "utf8")
    .digest("hex");
  return `v1=${digest}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type VerifyWebhookResult =
  | { ok: true }
  | { ok: false; reason: "stale" | "mismatch" | "malformed" };

/**
 * The check a receiver performs. Published here so the same implementation
 * can be handed to a partner rather than described in prose.
 */
export function verifyWebhook(input: {
  secret: string;
  body: string;
  signature: string | null | undefined;
  timestamp: string | number | null | undefined;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): VerifyWebhookResult {
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { ok: false, reason: "malformed" };
  }
  if (!input.signature) return { ok: false, reason: "malformed" };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: "stale" };

  const expected = signWebhook(input.secret, timestamp, input.body);
  return constantTimeEquals(expected, input.signature.trim())
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

/**
 * Does this subscription want this event?
 *
 * `*` means everything; `shipment.*` means the family. Anything else is an
 * exact name.
 */
export function matchesEvent(
  subscribed: readonly string[],
  eventType: string,
): boolean {
  return subscribed.some((pattern) => {
    const rule = pattern.trim();
    if (rule === "" ) return false;
    if (rule === "*") return true;
    if (rule.endsWith(".*")) return eventType.startsWith(`${rule.slice(0, -1)}`);
    if (rule.endsWith("*")) return eventType.startsWith(rule.slice(0, -1));
    return rule === eventType;
  });
}

/**
 * Retry schedule, in seconds.
 *
 * Doubling from thirty seconds and capped at six hours: a partner's system
 * that is down for a deploy gets several quick retries, and one that is
 * down for a day is not hammered for it.
 */
export function backoffSeconds(attempt: number): number {
  const schedule = [30, 60, 120, 300, 900, 3_600, 10_800, 21_600];
  const index = Math.max(0, Math.min(attempt - 1, schedule.length - 1));
  return schedule[index];
}
