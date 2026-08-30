import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Supervisor, type Job } from "./supervisor";

/**
 * What the worker's shutdown actually promises.
 *
 * The failure this file exists to prevent is a specific one, and it is not
 * theoretical: `drainOutbox` claims an event by setting it PROCESSING and
 * only marks it DONE after the handlers return. Kill the process between
 * those two writes and the row is claimed by nobody, for ever. Six days
 * later somebody asks why one carrier stopped getting delivery SMS.
 *
 * A `clearInterval` on shutdown does not prevent that — it stops the *next*
 * tick and says nothing about the one already inside a handler. So these
 * tests assert the thing that does prevent it: shutdown waits.
 *
 * Fake timers throughout. Real intervals would make this a test of how fast
 * the machine is.
 */

/** A pass whose completion the test controls. */
function controllable() {
  let release!: () => void;
  let started = 0;
  let finished = 0;

  const run = () => {
    started++;
    return new Promise<void>((resolve) => {
      release = () => {
        finished++;
        resolve();
      };
    });
  };

  return {
    run,
    get started() {
      return started;
    },
    get finished() {
      return finished;
    },
    release: () => release(),
  };
}

let supervisor: Supervisor;

beforeEach(() => {
  vi.useFakeTimers();
  supervisor = new Supervisor();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scheduling", () => {
  it("runs a job on its interval", async () => {
    const run = vi.fn(async () => {});
    supervisor.start([{ name: "drain", everyMs: 1000, run }]);

    expect(run).not.toHaveBeenCalled(); // Nothing fires on start.

    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("holds a job off until its first-run delay has passed", async () => {
    const run = vi.fn(async () => {});
    supervisor.start([
      { name: "retention", everyMs: 1000, firstRunDelayMs: 5000, run },
    ]);

    await vi.advanceTimersByTimeAsync(4999);
    expect(run).not.toHaveBeenCalled();

    // The delay fires the first pass itself, then the interval takes over.
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("drops a tick that arrives while the previous pass is still running", async () => {
    const pass = controllable();
    supervisor.start([{ name: "drain", everyMs: 1000, run: pass.run }]);

    await vi.advanceTimersByTimeAsync(5000);

    // Five ticks went by; one pass is in flight. The other four were
    // dropped rather than queued — a slow tenant must make the cadence
    // slower, never build a backlog of identical passes.
    expect(pass.started).toBe(1);
    expect(supervisor.running()).toEqual(["drain"]);

    pass.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pass.started).toBe(2);
  });

  it("keeps running after a pass rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("database went away"))
      .mockResolvedValue(undefined);

    supervisor.start([{ name: "drain", everyMs: 1000, run }]);

    await vi.advanceTimersByTimeAsync(2000);

    // One bad pass must not silence the job for the rest of the process's
    // life, and must not become an unhandled rejection either.
    expect(run).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalled();
  });
});

describe("shutdown", () => {
  it("waits for the pass that is already running", async () => {
    const pass = controllable();
    supervisor.start([{ name: "drain", everyMs: 1000, run: pass.run }]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(pass.started).toBe(1);

    let report: Awaited<ReturnType<Supervisor["shutdown"]>> | undefined;
    const stopping = supervisor.shutdown(30_000).then((r) => {
      report = r;
    });

    // The signal has arrived and the pass is still mid-flight. This is the
    // exact moment the process must not end: the outbox row it claimed has
    // not been marked DONE yet.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(report).toBeUndefined();
    expect(pass.finished).toBe(0);

    pass.release();
    await stopping;

    expect(report).toEqual({ clean: true, abandoned: [] });
    expect(pass.finished).toBe(1);
  });

  it("starts no new pass once shutdown has begun", async () => {
    const run = vi.fn(async () => {});
    supervisor.start([{ name: "drain", everyMs: 1000, run }]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    await supervisor.shutdown(30_000);

    // Both belts: the timers are cleared, and the tick refuses anyway.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns at once when nothing is in flight", async () => {
    supervisor.start([{ name: "drain", everyMs: 1000, run: async () => {} }]);

    // No timer has fired, so there is nothing to wait for and the grace
    // window must not be sat out. Resolving without advancing the clock is
    // what proves it.
    await expect(supervisor.shutdown(30_000)).resolves.toEqual({
      clean: true,
      abandoned: [],
    });
  });

  it("gives up after the grace window and names what it abandoned", async () => {
    const stuck = controllable();
    supervisor.start([{ name: "GPS retention", everyMs: 1000, run: stuck.run }]);

    await vi.advanceTimersByTimeAsync(1000);

    const stopping = supervisor.shutdown(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    // An orchestrator will SIGKILL us shortly; promising to wait longer
    // than it allows would be a lie. The report has to say which job was
    // cut, because that is the only clue in the log afterwards.
    await expect(stopping).resolves.toEqual({
      clean: false,
      abandoned: ["GPS retention"],
    });
  });

  it("waits for every job, not just the first", async () => {
    const drain = controllable();
    const webhooks = controllable();

    const jobs: Job[] = [
      { name: "outbox drain", everyMs: 1000, run: drain.run },
      { name: "webhook delivery", everyMs: 1000, run: webhooks.run },
    ];
    supervisor.start(jobs);

    await vi.advanceTimersByTimeAsync(1000);
    expect(supervisor.running().sort()).toEqual([
      "outbox drain",
      "webhook delivery",
    ]);

    let done = false;
    const stopping = supervisor.shutdown(30_000).then(() => {
      done = true;
    });

    drain.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false); // A half-posted webhook still counts.

    webhooks.release();
    await stopping;
    expect(done).toBe(true);
  });

  it("is idempotent, so a second Ctrl-C changes nothing", async () => {
    const pass = controllable();
    supervisor.start([{ name: "drain", everyMs: 1000, run: pass.run }]);
    await vi.advanceTimersByTimeAsync(1000);

    const first = supervisor.shutdown(30_000);
    const second = supervisor.shutdown(30_000);

    pass.release();

    expect(await first).toEqual({ clean: true, abandoned: [] });
    expect(await second).toEqual({ clean: true, abandoned: [] });
    expect(pass.started).toBe(1);
  });
});
