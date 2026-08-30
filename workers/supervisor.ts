import { beginShutdown } from "@/lib/runtime/shutdown";
/**
 * The worker's scheduler.
 *
 * Small on purpose, and separated from `index.ts` so it can be tested
 * without a database: everything interesting about a background process is
 * in *when* it runs work and *how it stops*, not in the work itself.
 *
 * Three properties it exists to guarantee:
 *
 *  1. **The timers keep the process alive.** Every timer inside the
 *     application modules is `unref`'d, because in the web server the drain
 *     must not be the reason Node refuses to exit. In a process whose entire
 *     job is those timers that is precisely backwards — an unref'd worker
 *     starts, prints its banner, and exits with status 0 having done
 *     nothing. Nothing here is unref'd except the shutdown deadline.
 *
 *  2. **A pass never overlaps itself.** A tick that arrives while the
 *     previous one is still running is dropped, not queued. Queueing turns a
 *     slow tenant into an ever-growing backlog of identical passes; dropping
 *     turns it into a slower cadence, which is what anyone would choose.
 *
 *  3. **Shutdown waits.** `SIGTERM` stops the timers and then *awaits the
 *     in-flight passes* before the process ends. That is the whole reason
 *     the worker does not simply call the modules' `start*()` helpers:
 *     `clearInterval` stops the next tick but says nothing about the one
 *     already running, and a drain killed between claiming an outbox row and
 *     marking it DONE leaves that row stranded as PROCESSING. The claim
 *     lease in `outbox.ts` is the second line of defence for the case where
 *     nobody gets to shut down politely at all.
 */

export type Job = {
  /** Appears in the banner and in every log line about this job. */
  name: string;
  /** Gap between the end of one tick and the start of the next. */
  everyMs: number;
  /**
   * Held off before the first tick. Used by retention, which has no reason
   * to start pruning a year of history in the first seconds of a deploy.
   */
  firstRunDelayMs?: number;
  /**
   * The pass. Expected not to throw — every pass in this system already
   * catches per-tenant failures — but a rejection is caught and logged
   * rather than becoming an unhandled rejection that kills the worker.
   */
  run: () => Promise<void>;
};

export type ShutdownReport = {
  /** True when every in-flight pass finished inside the grace window. */
  clean: boolean;
  /** Jobs still running when the grace window expired. Empty when clean. */
  abandoned: string[];
};

export class Supervisor {
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private stopping = false;

  /** Jobs currently mid-pass. Exposed for the shutdown log and for tests. */
  running(): string[] {
    return [...this.inFlight.keys()];
  }

  isStopping(): boolean {
    return this.stopping;
  }

  start(jobs: readonly Job[]): void {
    for (const job of jobs) this.schedule(job);
  }

  private schedule(job: Job): void {
    const tick = () => {
      // Both guards are refusals to start, not queues. After `shutdown()`
      // has been called no new work may begin, however long the grace
      // window turns out to be.
      if (this.stopping) return;
      if (this.inFlight.has(job.name)) return;

      const settled = job
        .run()
        .catch((error: unknown) => {
          console.error(`[worker] ${job.name} threw`, error);
        })
        .finally(() => {
          this.inFlight.delete(job.name);
        });

      // Synchronous, so it lands before any of the microtasks above can
      // run and try to delete it again.
      this.inFlight.set(job.name, settled);
    };

    if (job.firstRunDelayMs && job.firstRunDelayMs > 0) {
      const delay = setTimeout(() => {
        this.timers.delete(delay);
        tick();
        this.keep(setInterval(tick, job.everyMs));
      }, job.firstRunDelayMs);
      this.keep(delay);
      return;
    }

    this.keep(setInterval(tick, job.everyMs));
  }

  private keep(timer: NodeJS.Timeout): void {
    // Deliberately not `unref`'d — see the note at the top of the file.
    this.timers.add(timer);
  }

  /**
   * Stops scheduling and waits for what is already running.
   *
   * `graceMs` is a ceiling, not a target: the common case is that every
   * pass has finished within milliseconds and this returns at once. When it
   * expires the report names what was abandoned, so the log says which job
   * was cut rather than leaving somebody to guess.
   *
   * Idempotent. A second `SIGINT` from an impatient operator must not start
   * a second shutdown; it returns the same answer the first one will.
   */
  async shutdown(graceMs: number): Promise<ShutdownReport> {
    this.stopping = true;
    // Tell the work itself, not just the scheduler. Refusing to *start* a
    // pass is not enough — a drain already running has a batch of events to
    // get through, and it needs somewhere safe to stop.
    beginShutdown();

    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.clear();

    if (this.inFlight.size === 0) return { clean: true, abandoned: [] };

    let expiry: NodeJS.Timeout | undefined;
    const deadline = new Promise<false>((resolve) => {
      expiry = setTimeout(() => resolve(false), graceMs);
    });

    const finished = Promise.allSettled([...this.inFlight.values()]).then(
      () => true as const,
    );

    const clean = await Promise.race([finished, deadline]);
    // Cleared the moment the race is decided, so a shutdown that finished
    // in fifty milliseconds does not sit out the rest of the grace window
    // holding the event loop open.
    if (expiry) clearTimeout(expiry);

    return { clean, abandoned: clean ? [] : this.running() };
  }
}
