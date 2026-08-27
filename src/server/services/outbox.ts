import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Transactional outbox.
 *
 * Events are written in the same transaction as the change that caused
 * them, then drained separately. That ordering is what lets a dock scan
 * succeed while the SMS gateway is down: the scan and its outbox row
 * commit together, and delivery is retried later.
 *
 * The drain currently runs in-process on a timer because Redis is not
 * available in the local environment. `startOutboxDrain` is the only
 * thing that changes when it moves to a BullMQ worker — enqueue and the
 * handlers stay exactly as they are.
 */

export type OutboxInput = {
  /** Dotted name, e.g. "shipment.delivered". */
  eventType: string;
  aggregate: string;
  aggregateId: string;
  payload: Prisma.InputJsonValue;
};

export async function enqueueOutbox(
  input: OutboxInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await client.outboxEvent.create({
    data: {
      eventType: input.eventType,
      aggregate: input.aggregate,
      aggregateId: input.aggregateId,
      payload: input.payload,
    },
  });
}

// ────────────────────────────────────────────────────────────
// Handlers
// ────────────────────────────────────────────────────────────

export type OutboxHandler = (event: {
  id: string;
  eventType: string;
  aggregate: string;
  aggregateId: string;
  payload: unknown;
}) => Promise<void>;

const handlers = new Map<string, OutboxHandler[]>();

/**
 * Subscribe to an event name, or to a prefix with a trailing `*`
 * ("shipment.*"). Handlers must be idempotent: a retry after a partial
 * failure will call them again.
 */
export function onOutbox(pattern: string, handler: OutboxHandler): void {
  const list = handlers.get(pattern) ?? [];
  list.push(handler);
  handlers.set(pattern, list);
}

function handlersFor(eventType: string): OutboxHandler[] {
  const matched: OutboxHandler[] = [];
  for (const [pattern, list] of handlers) {
    if (pattern === eventType) matched.push(...list);
    else if (pattern.endsWith("*") && eventType.startsWith(pattern.slice(0, -1))) {
      matched.push(...list);
    }
  }
  return matched;
}

// ────────────────────────────────────────────────────────────
// Drain
// ────────────────────────────────────────────────────────────

const BATCH_SIZE = 50;
/** Backoff in seconds by attempt number, then capped. */
const BACKOFF = [5, 15, 60, 300, 900, 3600];

export async function drainOutbox(limit = BATCH_SIZE): Promise<{
  processed: number;
  failed: number;
}> {
  const due = await prisma.outboxEvent.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let processed = 0;
  let failed = 0;

  for (const event of due) {
    // Claim it first so two drains cannot both run the handlers.
    const claimed = await prisma.outboxEvent.updateMany({
      where: { id: event.id, status: "PENDING" },
      data: { status: "PROCESSING" },
    });
    if (claimed.count === 0) continue;

    try {
      for (const handler of handlersFor(event.eventType)) {
        await handler({
          id: event.id,
          eventType: event.eventType,
          aggregate: event.aggregate,
          aggregateId: event.aggregateId,
          payload: event.payload,
        });
      }

      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: "DONE", processedAt: new Date(), attempts: { increment: 1 } },
      });
      processed++;
    } catch (error) {
      const attempts = event.attempts + 1;
      const exhausted = attempts >= event.maxAttempts;
      const delay = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)];

      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          // DEAD events stay in the table for inspection rather than being
          // dropped — a notification nobody received is an operational fact.
          status: exhausted ? "DEAD" : "PENDING",
          attempts,
          nextAttemptAt: new Date(Date.now() + delay * 1000),
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      failed++;
    }
  }

  return { processed, failed };
}

// ────────────────────────────────────────────────────────────
// In-process scheduler
// ────────────────────────────────────────────────────────────

const globalForOutbox = globalThis as unknown as {
  outboxTimer: NodeJS.Timeout | undefined;
};

const DRAIN_INTERVAL_MS = 5_000;

/**
 * Starts the in-process drain. Safe to call repeatedly.
 *
 * This is the piece that becomes a BullMQ worker once Redis exists on the
 * server: same handlers, same table, different trigger.
 */
export function startOutboxDrain(): void {
  if (globalForOutbox.outboxTimer) return;

  const tick = async () => {
    try {
      const { failed } = await drainOutbox();
      if (failed > 0) {
        console.warn(`[outbox] ${failed} event(s) failed and will be retried`);
      }
    } catch (error) {
      console.error("[outbox] drain failed", error);
    }
  };

  globalForOutbox.outboxTimer = setInterval(tick, DRAIN_INTERVAL_MS);
  // Do not keep the process alive just for the drain.
  globalForOutbox.outboxTimer.unref?.();
}

export function stopOutboxDrain(): void {
  if (!globalForOutbox.outboxTimer) return;
  clearInterval(globalForOutbox.outboxTimer);
  globalForOutbox.outboxTimer = undefined;
}
