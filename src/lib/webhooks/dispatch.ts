import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { onOutbox } from "@/server/services/outbox";
import { toWebhookBody } from "./public-payload";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  backoffSeconds,
  matchesEvent,
  signWebhook,
} from "./signature";

/**
 * Webhook fan-out and delivery.
 *
 * Two stages, kept apart on purpose. Fan-out runs inside the outbox drain
 * and only *writes rows*: it must be fast and it must never fail because a
 * partner's endpoint is down. Delivery runs on its own timer and does the
 * network work, retrying with backoff.
 *
 * A subscription that keeps failing is paused rather than retried forever.
 * An endpoint that has rejected fifteen consecutive deliveries is not
 * coming back on the sixteenth, and a queue grinding against a dead URL
 * buries the deliveries that could still succeed.
 */

/** Consecutive failed deliveries before a subscription is paused. */
export const PAUSE_AFTER_FAILURES = 15;

/** How long we wait on a partner's endpoint before calling it a failure. */
const REQUEST_TIMEOUT_MS = 10_000;

const BATCH_SIZE = 25;
const DISPATCH_INTERVAL_MS = 10_000;

/** How long a claimed delivery is held before another dispatcher may take it. */
const LEASE_MS = 60_000;

// ────────────────────────────────────────────────────────────
// Fan-out
// ────────────────────────────────────────────────────────────

/**
 * Turns one outbox event into queued deliveries.
 *
 * Returns the number queued so the caller can log it. Matching is done in
 * memory rather than with a Postgres array query because the subscription
 * table is small and `*` / `shipment.*` patterns are far clearer here than
 * as SQL.
 */
export async function fanOutEvent(event: {
  eventType: string;
  aggregate: string;
  aggregateId: string;
  payload: unknown;
}): Promise<number> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { isActive: true, pausedAt: null },
    select: { id: true, events: true, customerId: true },
  });

  if (subscriptions.length === 0) return 0;

  const interested = subscriptions.filter((subscription) =>
    matchesEvent(subscription.events, event.eventType),
  );
  if (interested.length === 0) return 0;

  // A subscription tied to a customer only hears about that customer's
  // consignments. Resolved once, and only if somebody actually asked.
  const needsOwner = interested.some((s) => s.customerId !== null);
  let ownerId: string | null = null;

  if (needsOwner && event.aggregate === "Shipment") {
    const shipment = await prisma.shipment.findUnique({
      where: { id: event.aggregateId },
      select: { consignorId: true },
    });
    ownerId = shipment?.consignorId ?? null;
  }

  const targets = interested.filter(
    (subscription) =>
      subscription.customerId === null || subscription.customerId === ownerId,
  );
  if (targets.length === 0) return 0;

  const body = toWebhookBody(event);

  await prisma.webhookDelivery.createMany({
    data: targets.map((subscription) => ({
      subscriptionId: subscription.id,
      eventType: event.eventType,
      payload: body as Prisma.InputJsonValue,
    })),
  });

  return targets.length;
}

const globalForWebhooks = globalThis as unknown as {
  webhookHandlerRegistered: boolean | undefined;
  webhookTimer: NodeJS.Timeout | undefined;
};

/**
 * Subscribes the fan-out to the outbox. Safe to call repeatedly — every
 * entry point calls it, because there is no single startup hook that all
 * of them pass through.
 */
export function registerWebhookDispatch(): void {
  if (globalForWebhooks.webhookHandlerRegistered) return;
  globalForWebhooks.webhookHandlerRegistered = true;

  onOutbox("*", async (event) => {
    await fanOutEvent(event);
  });
}

// ────────────────────────────────────────────────────────────
// Delivery
// ────────────────────────────────────────────────────────────

export type DeliveryOutcome = {
  deliveryId: string;
  ok: boolean;
  responseStatus: number | null;
  error?: string;
};

/**
 * Posts one queued delivery.
 *
 * The body is serialised once and both signed and sent as that exact
 * string. Signing a re-serialisation is the classic way to ship a
 * signature the receiver can never reproduce.
 */
export async function deliverOne(delivery: {
  id: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  subscription: { id: string; url: string; secret: string; failureCount: number };
}): Promise<DeliveryOutcome> {
  const body = JSON.stringify(delivery.payload ?? {});
  const timestamp = Math.floor(Date.now() / 1000);
  const attempt = delivery.attempts + 1;

  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;

  try {
    const response = await fetch(delivery.subscription.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "CityLogistics-Webhooks/1",
        [SIGNATURE_HEADER]: signWebhook(delivery.subscription.secret, timestamp, body),
        [TIMESTAMP_HEADER]: String(timestamp),
        [EVENT_HEADER]: delivery.eventType,
        [DELIVERY_HEADER]: delivery.id,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "manual",
    });

    responseStatus = response.status;
    // Kept short: this is for a human debugging a rejection, not a log of
    // the partner's entire response.
    responseBody = (await response.text().catch(() => "")).slice(0, 1000);

    if (!response.ok) error = `Endpoint answered ${response.status}`;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  if (!error) {
    await prisma.$transaction([
      prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "DELIVERED",
          attempts: attempt,
          responseStatus,
          responseBody,
          error: null,
          deliveredAt: new Date(),
        },
      }),
      // One success clears the streak: a partner who fixed their endpoint
      // should not be paused by yesterday's outage.
      prisma.webhookSubscription.update({
        where: { id: delivery.subscription.id },
        data: { failureCount: 0 },
      }),
    ]);

    return { deliveryId: delivery.id, ok: true, responseStatus };
  }

  const exhausted = attempt >= delivery.maxAttempts;
  const failureCount = delivery.subscription.failureCount + 1;
  const shouldPause = failureCount >= PAUSE_AFTER_FAILURES;

  await prisma.$transaction([
    prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        // DEAD rows stay in the table. A status the partner never received
        // is an operational fact, not something to delete.
        status: exhausted ? "DEAD" : "PENDING",
        attempts: attempt,
        responseStatus,
        responseBody,
        error,
        nextAttemptAt: new Date(Date.now() + backoffSeconds(attempt) * 1000),
      },
    }),
    prisma.webhookSubscription.update({
      where: { id: delivery.subscription.id },
      data: {
        failureCount,
        ...(shouldPause ? { pausedAt: new Date() } : {}),
      },
    }),
  ]);

  return { deliveryId: delivery.id, ok: false, responseStatus, error };
}

/** Sends everything that is due. Returns what happened, for the log. */
export async function deliverDue(limit = BATCH_SIZE): Promise<{
  delivered: number;
  failed: number;
}> {
  const due = await prisma.webhookDelivery.findMany({
    where: {
      status: "PENDING",
      nextAttemptAt: { lte: new Date() },
      subscription: { isActive: true, pausedAt: null },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      eventType: true,
      payload: true,
      attempts: true,
      maxAttempts: true,
      subscription: {
        select: { id: true, url: true, secret: true, failureCount: true },
      },
    },
  });

  let delivered = 0;
  let failed = 0;
  const now = Date.now();

  for (const delivery of due) {
    // Claim it by taking a short lease, so two dispatchers cannot both
    // post the same body. A lease rather than a status flag: if this
    // process dies mid-flight the row is still PENDING and comes back
    // round when the lease lapses, instead of being stranded.
    const claimed = await prisma.webhookDelivery.updateMany({
      where: {
        id: delivery.id,
        status: "PENDING",
        nextAttemptAt: { lte: new Date(now) },
      },
      data: { nextAttemptAt: new Date(now + LEASE_MS) },
    });
    if (claimed.count === 0) continue;

    const outcome = await deliverOne(delivery);
    if (outcome.ok) delivered++;
    else failed++;
  }

  return { delivered, failed };
}

/** Re-queues one delivery by hand, from the ops screen. */
export async function redeliver(deliveryId: string): Promise<void> {
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "PENDING",
      nextAttemptAt: new Date(),
      error: null,
      // A manual retry gets its own budget rather than inheriting an
      // exhausted one, which would make the button do nothing.
      maxAttempts: { increment: 3 },
    },
  });
}

/** A fresh signing secret. Rotating it invalidates every stored copy. */
export function generateWebhookSecret(): string {
  return `whsec_${randomUUID().replace(/-/g, "")}`;
}

// ────────────────────────────────────────────────────────────
// In-process scheduler
// ────────────────────────────────────────────────────────────

/**
 * Starts the delivery timer.
 *
 * Same arrangement as the outbox drain, and for the same reason: Redis is
 * not available here yet. When it is, this becomes a BullMQ worker and
 * `deliverDue` is what the worker calls — nothing else moves.
 */
export function startWebhookDispatch(): void {
  registerWebhookDispatch();
  if (globalForWebhooks.webhookTimer) return;

  const tick = async () => {
    try {
      const { failed } = await deliverDue();
      if (failed > 0) {
        console.warn(`[webhooks] ${failed} delivery(ies) failed and will retry`);
      }
    } catch (error) {
      console.error("[webhooks] dispatch failed", error);
    }
  };

  globalForWebhooks.webhookTimer = setInterval(tick, DISPATCH_INTERVAL_MS);
  globalForWebhooks.webhookTimer.unref?.();
}

export function stopWebhookDispatch(): void {
  if (!globalForWebhooks.webhookTimer) return;
  clearInterval(globalForWebhooks.webhookTimer);
  globalForWebhooks.webhookTimer = undefined;
}
