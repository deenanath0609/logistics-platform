import { prisma } from "@/lib/prisma";
import { runCrossTenant } from "@/lib/tenant/context";

/**
 * The web server noticing that nobody is draining the outbox.
 *
 * The background loops moved out of this process into `workers/index.ts`.
 * That is the right shape, and it introduces exactly one new way to be
 * wrong: run `npm run dev` on its own, forget the worker, and the system
 * looks completely healthy. Bookings succeed, the timeline fills in, the
 * dashboards are green — and not one notification is sent, because every
 * outbox row is still sitting there PENDING with nothing to pick it up.
 *
 * That failure is silent, and a silent failure in the delivery path is the
 * worst kind this system has: nobody discovers it, a customer does.
 *
 * So it is made loud in two places, because one is not enough:
 *
 *  · At boot, unconditionally. A developer who has never run the worker has
 *    no backlog to detect yet — the warning has to come before the evidence.
 *  · From the evidence, once a minute. A backlog of events older than the
 *    grace window is proof, not a guess, and it survives the boot message
 *    having scrolled off the top of a terminal three hours ago.
 *
 * The check itself is one `count` a minute against an index that already
 * exists. It is not free, and it is worth far more than it costs.
 */

const CHECK_INTERVAL_MS = 60_000;

/**
 * How old a pending event has to be before it is evidence.
 *
 * Comfortably longer than the drain's five-second tick and longer than the
 * outbox's own first retry backoff, so an event that failed once and is
 * waiting to be retried does not get reported as a dead pipeline.
 */
const STALE_AFTER_MS = 2 * 60_000;

const globalForWatchdog = globalThis as unknown as {
  workerWatchdogTimer: NodeJS.Timeout | undefined;
};

export const START_WORKER_ADVICE = [
  "The background worker is not running in this process.",
  "",
  "  The outbox drain, webhook delivery, GPS polling, the SLA scan and GPS",
  "  retention live in a separate process. Start it alongside the web server:",
  "",
  "      npm run worker",
  "",
  "  Without it nothing is delivered: notifications stay QUEUED, webhooks never",
  "  fire, no GPS fix is ingested and no SLA breach is detected. The UI will",
  "  look entirely healthy while all of that is true.",
  "",
  "  Set RUN_JOBS_IN_WEB=true to run them inside the web server instead —",
  "  single-instance deployments and quick local work only, since every",
  "  instance that sets it runs its own copy of all five loops.",
].join("\n");

/**
 * Counts events that should have been drained by now.
 *
 * Cross-tenant on purpose: the question is about the platform's machinery,
 * not about any one carrier, and the answer is a single integer that names
 * no organisation. Declared with a reason rather than reaching for
 * `basePrisma`, so an audit of every cross-tenant read finds it.
 */
export async function stalePendingEvents(
  staleAfterMs = STALE_AFTER_MS,
): Promise<number> {
  return runCrossTenant(
    "worker watchdog: is anything draining the outbox at all?",
    () =>
      prisma.outboxEvent.count({
        where: {
          status: { in: ["PENDING", "PROCESSING"] },
          createdAt: { lt: new Date(Date.now() - staleAfterMs) },
        },
      }),
  );
}

/**
 * The line printed when the backlog proves the point.
 *
 * Pure, so the wording can be pinned by a test — this string is the entire
 * user interface of the watchdog, and a refactor that quietly turns it into
 * something unactionable would be invisible otherwise.
 */
export function backlogWarning(count: number, staleAfterMs = STALE_AFTER_MS): string {
  const minutes = Math.round(staleAfterMs / 60_000);
  return (
    `\n[worker] ${count} outbox event(s) have been waiting more than ${minutes} minute(s).\n` +
    `${START_WORKER_ADVICE}\n`
  );
}

/**
 * Starts the watchdog. Safe to call repeatedly.
 *
 * `unref`'d: this must never be the reason the web server refuses to exit.
 */
export function startWorkerWatchdog(): void {
  if (globalForWatchdog.workerWatchdogTimer) return;

  const check = async () => {
    try {
      const stale = await stalePendingEvents();
      if (stale > 0) console.error(backlogWarning(stale));
    } catch (error) {
      // A watchdog that takes the server down when the database hiccups is
      // worse than no watchdog. It reports and tries again in a minute.
      console.warn("[worker] watchdog could not read the outbox", error);
    }
  };

  globalForWatchdog.workerWatchdogTimer = setInterval(
    () => void check(),
    CHECK_INTERVAL_MS,
  );
  globalForWatchdog.workerWatchdogTimer.unref?.();
}

export function stopWorkerWatchdog(): void {
  if (!globalForWatchdog.workerWatchdogTimer) return;
  clearInterval(globalForWatchdog.workerWatchdogTimer);
  globalForWatchdog.workerWatchdogTimer = undefined;
}
