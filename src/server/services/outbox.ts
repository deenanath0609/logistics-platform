import { prisma, type Db } from "@/lib/prisma";
import { forEachTenant } from "@/lib/tenant/for-each-tenant";
import { requireTenantOrgId } from "@/lib/tenant";
import type { Prisma } from "@/generated/prisma/client";
import { isShuttingDown } from "@/lib/runtime/shutdown";

/**
 * Transactional outbox.
 *
 * Events are written in the same transaction as the change that caused
 * them, then drained separately. That ordering is what lets a dock scan
 * succeed while the SMS gateway is down: the scan and its outbox row
 * commit together, and delivery is retried later.
 *
 * The drain runs on a timer, in the worker process (`workers/index.ts`),
 * because Redis is not available in the local environment. `outboxPass` is
 * the seam: it is what the timer calls today and what a BullMQ worker would
 * call instead — enqueue, the handlers and `drainOutbox` stay exactly as
 * they are. See docs/adr/002-background-worker.md.
 */

export type OutboxInput = {
  /** Dotted name, e.g. "shipment.delivered". */
  eventType: string;
  aggregate: string;
  aggregateId: string;
  payload: Prisma.InputJsonValue;
};

/**
 * `client` is narrower than `DbOrTx` because one delegate is all this
 * writes: a caller inside a transaction that has already narrowed its own
 * client can still hand it straight through.
 */
export async function enqueueOutbox(
  input: OutboxInput,
  client: Pick<Db, "outboxEvent"> = prisma,
): Promise<void> {
  await client.outboxEvent.create({
    data: {
      // No actor and no parent row reach this far — the enqueue is a side
      // effect of whatever change is committing — so the tenant comes from
      // the context that change is already running in. `drainOutbox` reads
      // the row back under the same context.
      orgId: await requireTenantOrgId(),
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

/**
 * How long a claimed event is held before another drain may take it back.
 *
 * Generous compared with the five-second tick: it is a recovery horizon,
 * not a timeout. A handler that legitimately takes two minutes — an SMS
 * gateway on a bad day — must not have its row stolen out from under it and
 * the message sent twice.
 */
const CLAIM_LEASE_MS = 5 * 60_000;

/**
 * Drains the **current tenant's** pending events.
 *
 * Every row it reads, every handler it dispatches to and every write those
 * handlers make inherit the context this runs in, which is what makes the
 * whole downstream chain — notifications, webhook fan-out, SLA recompute —
 * tenant-safe without any of it taking an `orgId` argument. Call it inside
 * `runWithTenant`; `drainAllTenants` is what the timer uses.
 */
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
    // A stop was requested. Break here, before claiming, so the boundary is
    // one where nothing is half-done: everything left is still PENDING and
    // the next process picks it up immediately, rather than sitting claimed
    // until the lease expires five minutes later.
    if (isShuttingDown()) break;

    // Claim it first so two drains cannot both run the handlers.
    //
    // The claim carries a lease, written onto `nextAttemptAt` — the same
    // column the retry backoff uses, and saying the same thing: the earliest
    // moment anything may touch this row again. Without it, a process that
    // stops between the claim and the DONE write strands the row as
    // PROCESSING for ever, and nothing in the system ever looks at it again.
    // That is the failure that surfaces a week later as "this carrier's
    // notifications stopped"; `reclaimStalledOutbox` reads the lease back.
    const claimed = await prisma.outboxEvent.updateMany({
      where: { id: event.id, status: "PENDING" },
      data: {
        status: "PROCESSING",
        nextAttemptAt: new Date(Date.now() + CLAIM_LEASE_MS),
      },
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

/**
 * Puts back events whose claim has expired, for the **current tenant**.
 *
 * A row is only ever PROCESSING while some process is inside its handlers.
 * If the lease on it has run out, that process is gone — killed mid-pass,
 * crashed, or torn down by a deploy that did not wait — and the row is
 * nobody's. Returning it to PENDING is the only thing that gets the
 * notification sent at all.
 *
 * Deliberately does **not** charge the event an attempt. A restart is not
 * the event's fault, and counting it would push a perfectly good delivery
 * into the fifteen-minute backoff band after three deploys. A genuinely
 * poisonous event — one that kills the process rather than throwing — shows
 * up instead as a worker that will not stay up, which nobody can miss.
 */
export async function reclaimStalledOutbox(): Promise<number> {
  const { count } = await prisma.outboxEvent.updateMany({
    where: { status: "PROCESSING", nextAttemptAt: { lte: new Date() } },
    data: {
      status: "PENDING",
      lastError:
        "Claimed by a process that stopped before finishing; lease expired and the event was reclaimed.",
    },
  });
  return count;
}

/** One reclaim per tenant. Run once at worker start, then on every tick. */
export async function reclaimAllTenants(): Promise<number> {
  const pass = await forEachTenant({ job: "outbox reclaim" }, () =>
    reclaimStalledOutbox(),
  );
  return pass.results.reduce((total, row) => total + row.value, 0);
}

/**
 * One drain per tenant, per tick.
 *
 * The batch limit is per tenant rather than shared, so a customer with a
 * thousand queued events cannot hold up the delivery SMS of the customer
 * next to them — which is precisely what a single global `take: 50` over a
 * shared table would do.
 */
export async function drainAllTenants(limit = BATCH_SIZE): Promise<{
  processed: number;
  failed: number;
  tenantsFailed: number;
}> {
  const pass = await forEachTenant({ job: "outbox" }, () => drainOutbox(limit));

  let processed = 0;
  let failed = 0;
  for (const { value } of pass.results) {
    processed += value.processed;
    failed += value.failed;
  }

  return { processed, failed, tenantsFailed: pass.failed };
}

// ────────────────────────────────────────────────────────────
// The pass, and the timer that used to be the only way to run it
// ────────────────────────────────────────────────────────────

const globalForOutbox = globalThis as unknown as {
  outboxTimer: NodeJS.Timeout | undefined;
  outboxPassInFlight: boolean | undefined;
};

export const DRAIN_INTERVAL_MS = 5_000;

/**
 * One whole drain tick: reclaim what was abandoned, then drain every tenant.
 *
 * This is the unit of work the worker schedules, and the unit a BullMQ job
 * would invoke. It never throws — a scheduler that has to reason about
 * which of its jobs might reject is a scheduler nobody trusts.
 *
 * The in-flight guard is here rather than in the caller so it holds for
 * every way in: a pass that runs long must not be overlapped by the next
 * tick, because two drains racing the same rows is exactly what the claim
 * lease is trying to make rare rather than routine.
 */
export async function outboxPass(): Promise<void> {
  if (globalForOutbox.outboxPassInFlight) return;
  globalForOutbox.outboxPassInFlight = true;

  try {
    const reclaimed = await reclaimAllTenants();
    if (reclaimed > 0) {
      console.warn(
        `[outbox] reclaimed ${reclaimed} event(s) left claimed by a process that stopped`,
      );
    }

    const { failed } = await drainAllTenants();
    if (failed > 0) {
      console.warn(`[outbox] ${failed} event(s) failed and will be retried`);
    }
  } catch (error) {
    // Reaching here means the pass could not even list the organisations;
    // a failure inside one tenant is caught and logged per tenant.
    console.error("[outbox] drain failed", error);
  } finally {
    globalForOutbox.outboxPassInFlight = false;
  }
}

/**
 * Starts the in-process drain. Safe to call repeatedly.
 *
 * Only reached when `RUN_JOBS_IN_WEB=true` puts the loops back inside the
 * web server. The worker does not use this — it owns its own scheduler so
 * that a shutdown can wait for `outboxPass` to finish, which clearing an
 * interval cannot do.
 */
export function startOutboxDrain(): void {
  if (globalForOutbox.outboxTimer) return;

  globalForOutbox.outboxTimer = setInterval(() => void outboxPass(), DRAIN_INTERVAL_MS);
  // Do not keep the web server alive just for the drain.
  globalForOutbox.outboxTimer.unref?.();
}

export function stopOutboxDrain(): void {
  if (!globalForOutbox.outboxTimer) return;
  clearInterval(globalForOutbox.outboxTimer);
  globalForOutbox.outboxTimer = undefined;
}
