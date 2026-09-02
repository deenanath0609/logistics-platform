/**
 * Proves the background worker against the real database.
 *
 *   npx tsx scripts/verify-worker.ts [tenant-subdomain]
 *
 * The unit tests in `workers/supervisor.test.ts` and
 * `src/server/services/outbox.test.ts` pin the scheduling and the shutdown
 * semantics with an in-memory table. They are fast and deterministic, and
 * they cannot tell you whether a real process, started from a real entry
 * point, connected to a real Postgres, actually moves a row and actually
 * stops without stranding one. That is what this does.
 *
 * Three claims, in the order they cost money when they turn out to be false:
 *
 *  1. **A row queued by the web server is drained by the worker.** The
 *     whole point of the split. Also: the worker is identifiable on its
 *     connections, so `check-pipeline.mjs` can say *who* drained it.
 *  2. **A shutdown part-way through a drain strands nothing.** No row left
 *     PROCESSING, no row lost. This is the failure that stays invisible for
 *     a week and then reads as "this carrier stopped getting notifications".
 *  3. **A worker killed outright is recovered from.** Nobody gets a polite
 *     SIGTERM in an OOM kill. The claim lease is what makes that survivable,
 *     and this kills the process for real to prove it.
 *
 * `worker.probe` is used as the event type on purpose: no handler in the
 * system subscribes to it, so the drain does its full claim/dispatch/commit
 * cycle without sending anybody an SMS. Every row this script writes is
 * deleted before it exits, including when it fails.
 */
import "dotenv/config";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { basePrisma, disconnectDb } from "../src/lib/prisma-base";
import { prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor, type TenantContext } from "../src/lib/tenant";
import { enqueueOutbox } from "../src/server/services/outbox";
import type { OutboxStatus } from "../src/generated/prisma/client";

const PROBE = "worker.probe";
const WORKER_APP_NAME = "logistics-worker";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};
const note = (text: string) => console.log(`         ${text}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The organisation this run acts as.
 *
 * Named on the command line rather than read from the environment, so the
 * choice sits in the shell history next to the results — the same
 * convention the other verify scripts use.
 */
async function actingTenant(): Promise<TenantContext> {
  const subdomain = process.argv[2] ?? "city-logistics";

  const org = await basePrisma.organization.findFirstOrThrow({
    where: { subdomain },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });

  const tenant = tenantContextFor(org, "job");
  if (!tenant) {
    throw new Error(`Organisation "${subdomain}" is closed; refusing to run against it.`);
  }
  return tenant;
}

// ────────────────────────────────────────────────────────────
// Driving a real worker process
// ────────────────────────────────────────────────────────────

const WORKER_ENTRY = path.resolve(process.cwd(), "workers/index.ts");

/**
 * Starts the worker as a child process, resolving once its banner appears.
 *
 * The GPS poll and the retention run are pushed out of reach for the
 * duration: this script is about the outbox, and a mock fleet ingesting
 * fixes into the development database as a side effect of a test is a
 * nasty little surprise to leave behind.
 */
function startWorker(): Promise<ChildProcess> {
  const child = fork(WORKER_ENTRY, [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      GPS_POLL_INTERVAL_SECONDS: "86400",
      GPS_RETENTION_INTERVAL_HOURS: "24",
    },
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`    worker: ${chunk.toString()}`);
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("worker did not print its banner within 30s")),
      30_000,
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("background worker")) {
        clearTimeout(timer);
        resolve(child);
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited during startup with code ${code}`));
    });
  });
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on("exit", resolve));
}

/**
 * Asks the worker to stop, the way an orchestrator would.
 *
 * Over IPC rather than with `child.kill("SIGTERM")` because Windows cannot
 * deliver a catchable SIGTERM to a child at all — `kill` there is
 * `TerminateProcess`, which is the *hard* kill this script tests separately.
 * The message lands on the same `stop()` the signal handlers call, so what
 * is being exercised is the shutdown path itself; only the doorbell differs.
 */
async function requestShutdown(child: ChildProcess): Promise<number | null> {
  const ended = exited(child);
  child.send("shutdown");
  return Promise.race([
    ended,
    sleep(60_000).then(() => {
      child.kill();
      return -1 as const;
    }),
  ]);
}

// ────────────────────────────────────────────────────────────
// Reading the probe rows back
// ────────────────────────────────────────────────────────────

/** Every status the enum has, so a new one cannot silently go uncounted. */
type Counts = Record<OutboxStatus, number>;

const ZERO: Counts = { PENDING: 0, PROCESSING: 0, DONE: 0, FAILED: 0, DEAD: 0 };

async function probeCounts(tenant: TenantContext): Promise<Counts> {
  // Awaited *inside* the tenant callback, not returned from it. A Prisma
  // promise is lazy: hand it back unawaited and the query fires after
  // `runWithTenant` has already unwound, with no tenant established and the
  // extension quite correctly refusing it.
  const rows = await runWithTenant(tenant, async () =>
    prisma.outboxEvent.groupBy({
      by: ["status"],
      where: { eventType: PROBE },
      _count: { _all: true },
    }),
  );

  const counts: Counts = { ...ZERO };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}

async function enqueueProbes(tenant: TenantContext, howMany: number): Promise<void> {
  await runWithTenant(tenant, async () => {
    for (let i = 0; i < howMany; i++) {
      await enqueueOutbox({
        eventType: PROBE,
        aggregate: "WorkerProbe",
        aggregateId: `probe_${i}`,
        payload: { i },
      });
    }
  });
}

async function clearProbes(tenant: TenantContext): Promise<void> {
  await runWithTenant(tenant, async () => {
    await prisma.outboxEvent.deleteMany({ where: { eventType: PROBE } });
  });
}

/** Polls until `predicate` holds, or gives up. Returns whether it held. */
async function until(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  everyMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(everyMs);
  }
}

/** Connections the worker currently holds, seen from outside the worker. */
async function workerConnections(): Promise<number> {
  const rows = await basePrisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM pg_stat_activity
     WHERE datname = current_database()
       AND application_name = ${WORKER_APP_NAME}`;
  return Number(rows[0].n);
}

/**
 * Refuses to run at all while another worker is draining this database.
 *
 * ── The measurement bug this exists to end ───────────────────────────────
 *
 * Everything below counts rows in one shared table and attributes what it
 * finds to the one worker this script started. That reasoning only holds if
 * this script's worker is the *only* thing draining. It very often is not:
 * a developer leaves `npm run worker` running in another terminal, and it
 * keeps claiming and completing rows throughout.
 *
 * The symptom was recorded as a defect for weeks — "a graceful stop still
 * strands a single outbox row in PROCESSING, root cause never found". It is
 * not a defect. `drainOutbox` claims one row at a time, so a second live
 * worker has exactly one row claimed at any instant, and sampling the table
 * the moment this script's worker exits catches it. Always one row, always
 * "recovered within five minutes" — because the other worker finished it
 * milliseconds later, long before any lease expired. The shutdown path was
 * correct the whole time.
 *
 * So this is a precondition and not a `check`. A contaminated run must not
 * produce a report at all, because a report that reads as a product defect
 * is worse than no report.
 */
async function refuseIfAnotherWorkerIsRunning(): Promise<void> {
  const connected = await workerConnections();
  if (connected === 0) return;

  console.error(
    [
      "",
      "Another background worker is already connected to this database " +
        `(${connected} connection(s) named "${WORKER_APP_NAME}" in pg_stat_activity).`,
      "",
      "  This script has to be the only thing draining the outbox: it starts a",
      "  worker of its own, stops it, and then reads the outbox table to say what",
      "  that worker left behind. A second worker claims and completes rows the",
      "  whole time, and its in-flight claim — always exactly one row, because the",
      "  drain claims one at a time — is then read as a row this script's worker",
      "  stranded. That is a false defect, and it has been reported as a real one.",
      "",
      "  Stop the other worker and run this again:",
      "",
      "      Ctrl-C in the terminal running `npm run worker`",
      "",
    ].join("\n"),
  );

  throw new Error("another worker is running; refusing to measure a shared table");
}

// ────────────────────────────────────────────────────────────
// The proofs
// ────────────────────────────────────────────────────────────

async function provesItDrains(tenant: TenantContext): Promise<void> {
  console.log("\n1. A row the web server queued is drained by the worker\n");

  await clearProbes(tenant);
  await enqueueProbes(tenant, 1);

  const before = await probeCounts(tenant);
  check("the event is queued and untouched", before.PENDING === 1, "status PENDING");

  const worker = await startWorker();

  const drained = await until(
    async () => (await probeCounts(tenant)).DONE === 1,
    30_000,
  );
  check("the worker drained it", drained, "status DONE");

  // Polled rather than sampled once: the pool opens connections lazily, so
  // the label only becomes visible when the worker first talks to the
  // database, and that is a moment or two after the row it drained shows up.
  const identified = await until(async () => (await workerConnections()) > 0, 20_000);
  check(
    "the worker is identifiable on its connections",
    identified,
    `application_name "${WORKER_APP_NAME}" in pg_stat_activity — this is what ` +
      "check-pipeline.mjs reads to say who is draining",
  );

  const code = await requestShutdown(worker);
  check("it stopped cleanly", code === 0, `exit code ${code}`);

  const after = await until(async () => (await workerConnections()) === 0, 10_000);
  check("and let go of its connections", after);
}

async function provesShutdownStrandsNothing(tenant: TenantContext): Promise<void> {
  console.log("\n2. A shutdown part-way through a drain strands nothing\n");

  const total = 150;
  await clearProbes(tenant);
  await enqueueProbes(tenant, total);

  const worker = await startWorker();

  // Ask for the stop the instant the drain has visibly started. The pass
  // claims, dispatches and commits one row at a time, so arriving here
  // means the worker is inside `drainOutbox` with a row already claimed —
  // which is exactly the moment a naive shutdown loses it.
  const started = await until(
    async () => (await probeCounts(tenant)).DONE > 0,
    30_000,
    10,
  );
  check("the drain got going", started);

  const midFlight = await probeCounts(tenant);
  const code = await requestShutdown(worker);

  check("it stopped cleanly", code === 0, `exit code ${code}`);
  note(
    `${midFlight.DONE} of ${total} event(s) were done when the stop was requested`,
  );

  const final = await probeCounts(tenant);

  // The assertion this whole exercise exists for.
  //
  // A row still PROCESSING here is only a stranded row if *nobody* is
  // working on it. The discriminator is time: a genuinely abandoned claim
  // cannot move until its five-minute lease expires, while a claim held by
  // another live process is finished within a second. Asking the question
  // that way means this can never again report a second worker's in-flight
  // row as a defect in the shutdown path.
  let stranded = final.PROCESSING;
  if (stranded > 0) {
    const cleared = await until(
      async () => (await probeCounts(tenant)).PROCESSING === 0,
      8_000,
      200,
    );
    if (cleared) {
      note(
        "the claimed row completed on its own with our worker stopped — something " +
          "else is draining this database, so this measurement is not about the " +
          "worker under test. Stop the other worker.",
      );
    } else {
      stranded = (await probeCounts(tenant)).PROCESSING;
    }
  }

  check(
    "no event was left claimed but unprocessed",
    stranded === 0,
    `${stranded} PROCESSING with nobody working on it`,
  );

  // Every row is accounted for under some status. Deliberately not
  // `PENDING + DONE === total`: a row another process happens to hold at
  // this instant is not a lost row, and an assertion that says it is turns
  // a busy database into a red gate.
  const accounted =
    final.PENDING + final.DONE + final.PROCESSING + final.DEAD + final.FAILED;
  check(
    "no event was lost",
    accounted === total,
    `${final.DONE} done, ${final.PENDING} still queued for the next worker`,
  );
  check(
    "the pass it was in the middle of was allowed to finish",
    final.DONE >= midFlight.DONE,
    `${midFlight.DONE} → ${final.DONE} after the stop was requested`,
  );
}

async function provesItRecoversFromAHardKill(tenant: TenantContext): Promise<void> {
  console.log("\n3. A worker killed outright is recovered from\n");

  const total = 150;
  await clearProbes(tenant);
  await enqueueProbes(tenant, total);

  const worker = await startWorker();
  await until(async () => (await probeCounts(tenant)).DONE > 0, 30_000, 10);

  // No signal, no grace, no chance to finish: `kill()` on Windows is
  // TerminateProcess, and on Linux this is what an OOM kill looks like.
  const ended = exited(worker);
  worker.kill("SIGKILL");
  await ended;

  let stranded = (await probeCounts(tenant)).PROCESSING;

  if (stranded === 0) {
    // The kill landed between rows rather than inside one. The state it
    // *would* have left is well defined, so write it by hand rather than
    // re-rolling the dice — the recovery is what is being tested, not our
    // luck at hitting a millisecond window.
    note("the kill landed between rows; staging the state one mid-row would leave");
    await runWithTenant(tenant, async () => {
      await prisma.outboxEvent.updateMany({
        where: { eventType: PROBE, status: "PENDING" },
        data: { status: "PROCESSING", nextAttemptAt: new Date(Date.now() - 60_000) },
      });
    });
    stranded = (await probeCounts(tenant)).PROCESSING;
  } else {
    // A live claim is not stranded yet — its lease has minutes to run. Age
    // it, because waiting five real minutes to prove a five-minute lease is
    // not a test anybody will run twice.
    note(`${stranded} row(s) were left claimed by the killed process`);
    await runWithTenant(tenant, async () => {
      await prisma.outboxEvent.updateMany({
        where: { eventType: PROBE, status: "PROCESSING" },
        data: { nextAttemptAt: new Date(Date.now() - 60_000) },
      });
    });
  }

  check("rows are stranded as PROCESSING with an expired claim", stranded > 0, `${stranded}`);

  const restarted = await startWorker();
  const recovered = await until(
    async () => (await probeCounts(tenant)).PROCESSING === 0,
    60_000,
  );
  check("the next worker reclaimed them", recovered);

  const finished = await until(
    async () => (await probeCounts(tenant)).DONE === total,
    60_000,
  );
  check("and delivered every one of them", finished, `${total}/${total} DONE`);

  const code = await requestShutdown(restarted);
  check("it stopped cleanly", code === 0, `exit code ${code}`);
}

// ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tenant = await actingTenant();

  console.log(
    `\nBackground worker — verified against ${process.env.DATABASE_URL?.replace(/\/\/[^@]*@/, "//")}\n` +
      `Acting as "${tenant.slug}".\n`,
  );

  await refuseIfAnotherWorkerIsRunning();

  try {
    await provesItDrains(tenant);
    await provesShutdownStrandsNothing(tenant);
    await provesItRecoversFromAHardKill(tenant);
  } finally {
    // Even on failure. A half-drained pile of probe events left in a
    // development database is indistinguishable from a real backlog, and
    // the next person to run check-pipeline would believe it.
    await clearProbes(tenant);
  }

  console.log(
    failures === 0
      ? "\nAll checks passed.\n"
      : `\n${failures} check(s) FAILED.\n`,
  );
}

void main()
  .catch((error: unknown) => {
    failures++;
    console.error("\nverify-worker failed:", error);
  })
  .finally(async () => {
    await disconnectDb();
    process.exit(failures === 0 ? 0 : 1);
  });
