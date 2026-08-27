import type {
  NotificationChannel,
  NotificationStatus,
} from "@/generated/prisma/client";

/**
 * The decisions the dispatcher makes, extracted from the database work so
 * they can be tested without one.
 *
 * All pure. Between them they answer the three questions that decide
 * whether a consignee's phone buzzes: have we already sent this, did they
 * ask us not to, and does this event actually mean what the template
 * assumes it means.
 */

// ────────────────────────────────────────────────────────────
// Idempotency
// ────────────────────────────────────────────────────────────

export type DedupeInput = {
  /**
   * Identifies the *occurrence*, not the shipment. For a shipment event
   * this is the `ShipmentEvent` id carried in the outbox payload, which is
   * what makes two failed delivery attempts on the same consignment two
   * distinct notifications rather than one repeated.
   */
  eventKey: string;
  templateId: string;
  channel: NotificationChannel;
  /** The actual destination — a template fanned out to three portal users
   *  is three sends, and each needs its own key. */
  recipient: string;
};

/**
 * The token that makes a redelivered outbox event harmless.
 *
 * The outbox retries on any failure, including a failure in a completely
 * different handler for the same event. Without this, a customer whose
 * webhook endpoint is down would receive the delivery SMS once per retry —
 * eight times, by the outbox's own `maxAttempts`.
 *
 * Readable rather than hashed on purpose: when support asks why a message
 * went twice, the answer has to be legible in the log row.
 */
export function dedupeKeyFor(input: DedupeInput): string {
  return [
    input.eventKey,
    input.templateId,
    input.channel,
    input.recipient.trim().toLowerCase(),
  ].join("|");
}

/**
 * Whether to attempt a send given what the log already holds for this key.
 *
 * `null` means nothing was ever attempted. Everything else is a prior
 * attempt, and only an explicit FAILED is safe to repeat: FAILED means the
 * gateway told us it did not accept the message.
 *
 * QUEUED deliberately blocks. A row stuck at QUEUED means the process died
 * somewhere around the gateway call, and we cannot tell from here whether
 * the message went out. Given the choice between a consignee who misses one
 * SMS and a consignee who gets the same OTP twice, this picks the first —
 * the stuck row is visible on the send log for someone to resend by hand.
 */
export function shouldAttempt(existing: NotificationStatus | null): boolean {
  if (existing === null) return true;
  return existing === "FAILED";
}

// ────────────────────────────────────────────────────────────
// Opt-outs
// ────────────────────────────────────────────────────────────

export type PreferenceRow = {
  eventType: string;
  channel: NotificationChannel;
  enabled: boolean;
};

/**
 * Opt-out lookup.
 *
 * Absence of a row means send — the schema says so, and it is the right
 * default: a booking confirmation nobody asked to stop is not spam. An
 * `eventType` of `*` turns a whole channel off, which is what "stop texting
 * me" from a customer actually means.
 */
export function isOptedOut(
  preferences: readonly PreferenceRow[],
  eventType: string,
  channel: NotificationChannel,
): boolean {
  return preferences.some(
    (row) =>
      row.enabled === false &&
      row.channel === channel &&
      (row.eventType === eventType || row.eventType === "*"),
  );
}

// ────────────────────────────────────────────────────────────
// Event relevance
// ────────────────────────────────────────────────────────────

export type RelevanceContext = {
  /** Branch that recorded the event, where the event carries one. */
  branchId?: string | null;
  destinationBranchId?: string | null;
  originBranchId?: string | null;
};

/**
 * Why this event should not produce a notification, or null to proceed.
 *
 * Some outbox events fire more often than the trigger matrix implies.
 * `shipment.gate_in` happens at every hub on a three-leg route, but
 * "reached destination city" means the last one — a consignee told their
 * parcel had arrived while it sat in a transit hub 400 km away would be
 * right to complain.
 */
export function suppressReason(
  eventType: string,
  context: RelevanceContext,
): string | null {
  if (eventType === "shipment.gate_in") {
    if (!context.destinationBranchId) {
      return "Shipment has no destination branch recorded.";
    }
    if (!context.branchId) {
      return "Arrival scan carried no branch, so it cannot be the destination.";
    }
    if (context.branchId !== context.destinationBranchId) {
      return "Arrival at a transit hub, not the destination city.";
    }
  }

  return null;
}
