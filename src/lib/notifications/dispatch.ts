import { prisma } from "@/lib/prisma";
import { onOutbox, type OutboxHandler } from "@/server/services/outbox";
import type {
  NotificationChannel,
  NotificationStatus,
  NotificationTemplate,
  Prisma,
  RecipientKind,
} from "@/generated/prisma/client";
import { getChannelAdapter } from "./channels";
import { isConfigurationFailure } from "./channels/types";
import {
  baseVariables,
  eventVariables,
  loadShipmentContext,
  resolveRecipients,
  type ResolvedRecipient,
  type ShipmentContext,
} from "./context";
import { maskRecipient } from "./mask";
import { missingVariables, renderSubject, renderTemplate } from "./render";
import { dedupeKeyFor, isOptedOut, shouldAttempt, suppressReason } from "./rules";

/**
 * Turning outbox events into messages.
 *
 * Two properties matter more than anything else here, and everything below
 * is arranged around them.
 *
 * **Idempotent.** The outbox retries on any failure, including a failure in
 * an unrelated handler for the same event. Every intended send therefore
 * carries a key derived from the *occurrence* — not the shipment — and a
 * key already present in the log is not sent again. `rules.ts` holds that
 * decision on its own so it can be tested without a database.
 *
 * **Fail soft.** A dead SMS gateway marks a row FAILED and returns. It never
 * throws out of the handler, because throwing would make the outbox retry
 * the event, and every other handler attached to it, forever — a hub scan
 * would then be repeatedly reprocessed because a gateway in another
 * building is down.
 */

// ────────────────────────────────────────────────────────────
// Registration
// ────────────────────────────────────────────────────────────

/**
 * Event families this dispatcher listens to.
 *
 * Deliberately not `*`: the outbox also carries webhook and settlement
 * traffic, and a template accidentally created against one of those should
 * do nothing rather than message a customer about an internal event.
 */
const PATTERNS = [
  "shipment.*",
  "notification.*",
  "cod.*",
] as const;

const globalForDispatch = globalThis as unknown as {
  notificationDispatchRegistered: boolean | undefined;
};

/**
 * Subscribes the dispatcher to the outbox.
 *
 * Guarded because Next.js re-evaluates modules on every hot reload, and a
 * handler registered four times sends four SMS. The guard lives on
 * `globalThis` for the same reason the Prisma client's does.
 */
export function registerNotificationDispatch(): void {
  if (globalForDispatch.notificationDispatchRegistered) return;
  globalForDispatch.notificationDispatchRegistered = true;

  for (const pattern of PATTERNS) onOutbox(pattern, handleEvent);
}

// ────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────

export const handleEvent: OutboxHandler = async (event) => {
  try {
    await dispatchEvent({
      outboxId: event.id,
      eventType: event.eventType,
      aggregate: event.aggregate,
      aggregateId: event.aggregateId,
      payload: asRecord(event.payload),
    });
  } catch (error) {
    // Nothing above this line is allowed to fail the outbox event. A
    // notification that could not be worked out is a notification problem.
    console.error("[notify] dispatch failed", {
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      error: error instanceof Error ? error.message : error,
    });
  }
};

export type DispatchInput = {
  outboxId: string;
  eventType: string;
  aggregate: string;
  aggregateId: string;
  payload: Record<string, unknown>;
};

export type DispatchSummary = {
  sent: number;
  failed: number;
  skipped: number;
  /** Sends suppressed because the log already held this key. */
  duplicate: number;
};

export async function dispatchEvent(
  input: DispatchInput,
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { sent: 0, failed: 0, skipped: 0, duplicate: 0 };

  const templates = await prisma.notificationTemplate.findMany({
    where: { eventType: input.eventType, isActive: true },
  });
  if (templates.length === 0) return summary;

  // Every trigger in §A.15's matrix hangs off a shipment. An event with a
  // different aggregate has templates but no addressee, so it stops here
  // rather than sending something half-resolved.
  if (input.aggregate !== "Shipment") {
    console.warn(
      `[notify] ${templates.length} template(s) match "${input.eventType}" but ` +
        `its aggregate is ${input.aggregate}, which carries no recipients yet.`,
    );
    return summary;
  }

  const context = await loadShipmentContext(input.aggregateId);
  if (!context) return summary;

  const suppressed = suppressReason(input.eventType, {
    branchId: asString(input.payload.branchId),
    originBranchId: context.originBranchId,
    destinationBranchId: context.destinationBranchId,
  });
  if (suppressed) return summary;

  // The occurrence, not the shipment. Two failed attempts on one
  // consignment must produce two notifications, not one.
  const eventKey = asString(input.payload.eventId) ?? input.outboxId;

  const variables = {
    ...baseVariables(context),
    ...(await eventVariables(input.eventType, context, input.payload)),
  };

  const preferences = await loadPreferences(
    context.consignorId,
    (context.consignor?.portalUsers ?? []).map((user) => user.id),
  );

  for (const template of templates) {
    const recipients = resolveRecipients(
      template.recipientKind,
      template.channel,
      context,
    );

    if (recipients.length === 0) {
      await logSkipped(
        template,
        context,
        input,
        eventKey,
        noRecipientReason(template.recipientKind, template.channel),
      );
      summary.skipped++;
      continue;
    }

    for (const recipient of recipients) {
      const outcome = await sendOne({
        template,
        recipient,
        context,
        input,
        eventKey,
        variables,
        preferences,
      });
      summary[outcome]++;
    }
  }

  return summary;
}

// ────────────────────────────────────────────────────────────
// One send
// ────────────────────────────────────────────────────────────

type SendOneInput = {
  template: NotificationTemplate;
  recipient: ResolvedRecipient;
  context: NonNullable<ShipmentContext>;
  input: DispatchInput;
  eventKey: string;
  variables: Record<string, string | number | boolean | null | undefined>;
  preferences: Awaited<ReturnType<typeof loadPreferences>>;
};

async function sendOne(
  args: SendOneInput,
): Promise<keyof DispatchSummary> {
  const { template, recipient, context, input, eventKey, variables } = args;

  const dedupeKey = dedupeKeyFor({
    eventKey,
    templateId: template.id,
    channel: template.channel,
    recipient: recipient.address,
  });

  const existing = await findByDedupeKey(dedupeKey, context.id);
  if (!shouldAttempt(existing?.status ?? null)) return "duplicate";

  // Opt-outs are checked per recipient: a corporate account that turned off
  // delivery SMS has not turned it off for the consignee at the other end.
  const scoped = args.preferences.filter(
    (row) =>
      (recipient.customerId !== null && row.customerId === recipient.customerId) ||
      (recipient.customerUserId !== null &&
        row.customerUserId === recipient.customerUserId),
  );

  if (isOptedOut(scoped, input.eventType, template.channel)) {
    await writeLog({
      template,
      context,
      input,
      recipient,
      dedupeKey,
      status: "SKIPPED",
      body: "",
      subject: null,
      error: "Recipient has opted out of this notification.",
      existingId: existing?.id,
    });
    return "skipped";
  }

  const body = renderTemplate(template.body, variables);
  const subject = template.subject
    ? renderSubject(template.subject, variables)
    : null;

  // A placeholder nobody filled would go out as literal braces. Better to
  // record the send as failed with the names in it: the template editor is
  // where that gets fixed, and the log is where somebody notices.
  const missing = missingVariables(template.body, variables);
  if (missing.length > 0) {
    await writeLog({
      template,
      context,
      input,
      recipient,
      dedupeKey,
      status: "FAILED",
      body,
      subject,
      error: `Template has no value for ${missing.join(", ")}. Fix the template or the trigger before re-sending.`,
      existingId: existing?.id,
    });
    return "failed";
  }

  const log = await writeLog({
    template,
    context,
    input,
    recipient,
    dedupeKey,
    status: "QUEUED",
    body,
    subject,
    existingId: existing?.id,
  });

  try {
    const adapter = getChannelAdapter(template.channel);
    const result = await adapter.send({
      channel: template.channel,
      to: recipient.address,
      subject,
      body,
      dltTemplateId: template.dltTemplateId,
      dltSenderId: template.dltSenderId,
      reference: log.id,
    });

    await prisma.notificationLog.update({
      where: { id: log.id },
      data: {
        status: result.ok ? "SENT" : "FAILED",
        sentAt: result.ok ? new Date() : null,
        providerRef: result.providerRef ?? null,
        providerResponse: mergeResponse(dedupeKey, adapter.provider, result.response),
        segments: result.segments ?? null,
        costAmount: result.cost ?? null,
        error: result.ok ? null : (result.error ?? "Gateway rejected the message."),
      },
    });

    return result.ok ? "sent" : "failed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isConfiguration = isConfigurationFailure(error);

    await prisma.notificationLog.update({
      where: { id: log.id },
      data: {
        // A channel nobody has configured has not *failed to deliver* —
        // it was never attempted. Recording it as FAILED fills the ops log
        // with red for a settings gap and makes the retry logic churn
        // against something only a human can fix. SKIPPED says what
        // actually happened, and the reason is kept on the row.
        status: isConfiguration ? "SKIPPED" : "FAILED",
        error: message,
        providerResponse: mergeResponse(dedupeKey, "unavailable", {
          configuration: isConfiguration,
        }),
      },
    });

    // Logged once at warn, not error: a provider that has not been chosen
    // yet is an expected state in every environment except production, and
    // an error-level line per booking would bury everything else.
    console.warn(
      `[notify] ${template.channel} to ${maskRecipient(recipient.address)} failed: ${message}`,
    );
    return "failed";
  }
}

// ────────────────────────────────────────────────────────────
// Log
// ────────────────────────────────────────────────────────────

/**
 * The dedupe key lives in `providerResponse`, narrowed by `shipmentId`.
 *
 * There is no dedicated column for it and the schema is not this module's
 * to change, so the lookup rides the `@@index([shipmentId])` that already
 * exists: a JSON comparison across the handful of notifications one
 * consignment ever generates, not across the table. If a `dedupeKey`
 * column with a unique index is ever added, this function and `writeLog`
 * are the only two places that need to know.
 */
async function findByDedupeKey(
  dedupeKey: string,
  shipmentId: string,
): Promise<{ id: string; status: NotificationStatus } | null> {
  return prisma.notificationLog.findFirst({
    where: {
      shipmentId,
      providerResponse: { path: ["dedupeKey"], equals: dedupeKey },
    },
    select: { id: true, status: true },
    orderBy: { queuedAt: "desc" },
  });
}

function mergeResponse(
  dedupeKey: string,
  provider: string,
  response?: Record<string, unknown> | null,
): Prisma.InputJsonValue {
  return { dedupeKey, provider, ...(response ?? {}) };
}

type WriteLogInput = {
  template: NotificationTemplate;
  context: NonNullable<ShipmentContext>;
  input: DispatchInput;
  recipient: ResolvedRecipient;
  dedupeKey: string;
  status: NotificationStatus;
  body: string;
  subject: string | null;
  error?: string;
  /** Set when retrying a previously FAILED row, which is updated in place. */
  existingId?: string;
};

async function writeLog(args: WriteLogInput): Promise<{ id: string }> {
  const data = {
    templateId: args.template.id,
    channel: args.template.channel,
    eventType: args.input.eventType,
    recipient: args.recipient.address,
    recipientKind: args.recipient.kind,
    subject: args.subject,
    body: args.body,
    status: args.status,
    error: args.error ?? null,
    shipmentId: args.context.id,
    customerId: args.recipient.customerId,
    branchId: args.recipient.branchId ?? args.context.destinationBranchId,
    providerResponse: mergeResponse(args.dedupeKey, "pending"),
  };

  if (args.existingId) {
    // A retry of a failed send reuses the row rather than adding a second
    // one, so the log reads as "this message, two attempts" instead of two
    // unrelated messages to the same number.
    return prisma.notificationLog.update({
      where: { id: args.existingId },
      data: {
        ...data,
        attempts: { increment: 1 },
        sentAt: null,
        queuedAt: new Date(),
      },
      select: { id: true },
    });
  }

  return prisma.notificationLog.create({
    data: { ...data, attempts: 1 },
    select: { id: true },
  });
}

async function logSkipped(
  template: NotificationTemplate,
  context: NonNullable<ShipmentContext>,
  input: DispatchInput,
  eventKey: string,
  reason: string,
): Promise<void> {
  const dedupeKey = dedupeKeyFor({
    eventKey,
    templateId: template.id,
    channel: template.channel,
    recipient: "",
  });

  if (await findByDedupeKey(dedupeKey, context.id)) return;

  await prisma.notificationLog.create({
    data: {
      templateId: template.id,
      channel: template.channel,
      eventType: input.eventType,
      recipient: "",
      recipientKind: template.recipientKind,
      subject: null,
      body: "",
      status: "SKIPPED",
      error: reason,
      shipmentId: context.id,
      branchId: context.destinationBranchId,
      providerResponse: mergeResponse(dedupeKey, "none"),
    },
  });
}

function noRecipientReason(
  kind: RecipientKind,
  channel: NotificationChannel,
): string {
  if (kind === "STAFF") {
    return "Staff notifications are routed by the exception tower, not by templates.";
  }
  const what = channel === "EMAIL" ? "email address" : "phone number";
  return `No ${what} on file for the ${kind.toLowerCase().replace("_", " ")}.`;
}

// ────────────────────────────────────────────────────────────
// Preferences
// ────────────────────────────────────────────────────────────

/**
 * Opt-outs for the account and for each of its portal logins.
 *
 * `NotificationPreference` carries ids without relations, so the portal
 * user ids come from the context we already loaded rather than from a join
 * that does not exist.
 */
async function loadPreferences(
  customerId: string | null,
  customerUserIds: string[],
) {
  const scopes: Prisma.NotificationPreferenceWhereInput[] = [];
  if (customerId) scopes.push({ customerId });
  if (customerUserIds.length > 0) {
    scopes.push({ customerUserId: { in: customerUserIds } });
  }
  if (scopes.length === 0) return [];

  return prisma.notificationPreference.findMany({
    where: { OR: scopes },
    select: {
      customerId: true,
      customerUserId: true,
      eventType: true,
      channel: true,
      enabled: true,
    },
  });
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
