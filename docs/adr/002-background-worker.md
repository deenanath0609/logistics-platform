# ADR 002 — Background work runs in its own process

**Status:** accepted, 30 August 2026
**Context:** five scheduled loops were running inside the Next.js server,
started from `src/instrumentation.ts`.

---

## Decision

The outbox drain, webhook delivery, GPS polling, the GPS signal-loss sweep,
the SLA scan and GPS retention run in **`workers/index.ts`**, a process of
their own. The web server starts none of them. It warns at boot that it is
not running them, and watches the outbox for a backlog so the omission
cannot stay quiet.

The scheduling is still **`setInterval` behind the adapter that was always
there**, not BullMQ. That is a separate decision, taken separately, and §4
says exactly what changes when it is revisited.

---

## 1. Why the loops left the web server

Three failures, none of which show up until the day they matter:

- **A deploy stopped everything.** Restarting the web tier stopped the drain,
  and a queue does not stop filling because its drain stopped — it fills
  faster.
- **Every instance ran its own copy.** Two web instances meant two GPS polls
  per tenant per interval, two SLA scans, two dispatchers racing for the same
  webhook deliveries. Nothing double-delivered — every claim is guarded — but
  everything ran twice.
- **Nothing could be reasoned about on its own.** "Is the drain running?" had
  no answer except "is any web server up?", and no way to restart or scale
  the drain without restarting the site.

Two lazily-armed dispatchers were removed at the same time: the webhooks
settings page and the v1 API guard both called `startWebhookDispatch()`, so
opening a screen or receiving one API request gave that instance its own
delivery timer for the rest of its life.

## 2. How a developer without a worker finds out

Deliberately not an env switch alone. `RUN_JOBS_IN_WEB` exists, but if the
only signal were "you did not set the variable", the default experience of
`npm run dev` would be a system that books shipments, fills the timeline,
shows green dashboards, and sends nothing at all. A silent failure in the
delivery path is the worst kind this system has: nobody finds it, a customer
does.

So it is loud twice, because either one alone has a hole:

- **At boot, every boot** (`src/instrumentation.ts`). A developer who has
  never started the worker has no backlog to detect yet — the warning has to
  arrive before the evidence does.
- **From the evidence, once a minute**
  (`src/server/services/worker-watchdog.ts`). Any outbox row older than two
  minutes is proof rather than a reminder, and it still shouts three hours
  after the boot message scrolled off the top of the terminal.

`RUN_JOBS_IN_WEB=true` puts all five back inside the web server for a
genuinely single-instance deployment. It warns when it does, because setting
it on two instances silently restores the duplication this ADR removed.

## 3. Shutdown, and the row that goes missing

`drainOutbox` claims an event by setting it `PROCESSING` and only marks it
`DONE` after the handlers return. Stop the process between those two writes
and the row belongs to nobody: no error, no retry, no alert, and no other
query in the system ever looks at a `PROCESSING` row again. It surfaces a
week later as "this carrier stopped getting delivery SMS".

`clearInterval` does not prevent that — it stops the *next* tick and says
nothing about the one already inside a handler. So the worker does not use
the modules' `start*()` helpers. `workers/supervisor.ts` owns the timers and
its `shutdown()` **awaits the in-flight passes** before the process ends,
with a grace window (`WORKER_SHUTDOWN_GRACE_MS`, default 30s — what most
orchestrators allow between SIGTERM and SIGKILL).

Nobody gets a polite signal in an OOM kill, so there is a second line:
claiming an outbox row now writes a five-minute lease onto `nextAttemptAt`,
and `reclaimStalledOutbox` returns any `PROCESSING` row whose lease has
expired to `PENDING`. Same column the retry backoff uses, same meaning — the
earliest moment anything may touch this row again — so no migration was
needed. The reclaim deliberately does **not** charge the event an attempt: a
restart is not the event's fault, and counting it would push a perfectly good
notification into the fifteen-minute backoff band after three deploys.

Proved in three places:

| Where | What it proves |
|---|---|
| `workers/supervisor.test.ts` | Shutdown waits for the in-flight pass, starts no new one, and reports what it abandoned when the grace window expires. |
| `src/server/services/outbox.test.ts` | Against an in-memory table: a queued row is drained, a shutdown mid-pass leaves nothing `PROCESSING`, and an expired claim is reclaimed while a live one is left alone. |
| `npm run verify:worker` | Against the real database and a real forked worker process: it drains, it stops cleanly mid-drain with nothing stranded and nothing lost, and a row left behind by an actual `SIGKILL` is recovered by the next worker. |

`scripts/check-pipeline.mjs` answers the operational question. Both processes
label their connections (`PGAPPNAME` → `logistics-worker` /
`logistics-web-jobs`), so the report distinguishes *the worker is draining
it* from *a web server is* from *nobody is and the queue happens to be
empty* — three states that are identical if you only look at the rows, and
that call for completely different actions.

## 4. The BullMQ swap

`bullmq` and `ioredis` are already dependencies and `src/lib/redis.ts`
already exists. What is missing is Redis: there is none on the development
machine and no Docker to run one, so `REDIS_URL` points at a port nothing is
listening on. Writing the queue wiring now would mean shipping code that has
never once been executed, which this project does not do.

The seam was designed for this from the start, and the process split does not
move it. When Redis exists:

**What changes — one file, `workers/index.ts`.** Replace the `Supervisor`
with a BullMQ `Worker` per queue and a repeatable job per schedule. The `Job`
list already carries everything a repeatable job needs — a name, an interval,
a first-run delay and a function — so each entry becomes one
`queue.upsertJobScheduler(name, { every: everyMs }, ...)` and the `run`
function becomes the processor body. `shutdown()` becomes `worker.close()`,
which has the same contract: stop taking work, finish what is in hand.

**What does not change — everything else.**

- `enqueueOutbox` and every caller of it. Events are still written to the
  `outbox_event` table in the same transaction as the change that caused
  them. That is what makes a dock scan succeed while the SMS gateway is down,
  and no queue replaces it.
- `onOutbox` and every handler: notifications, webhook fan-out, GPS cache
  invalidation, the SLA recompute.
- The pass functions themselves — `outboxPass`, `webhookPass`, `gpsPollPass`,
  `signalLossPass`, `slaPass`, `retentionPass` — and everything under them.
  They are already the unit of work; BullMQ would simply be what calls them.
- `forEachTenant`, and therefore every tenancy guarantee in ADR 001. A
  BullMQ job with no tenant is in exactly the position a timer tick is:
  it must enumerate organisations and run inside each.
- `src/instrumentation.ts`, the watchdog, and `check-pipeline.mjs`.

**What `REDIS_URL` must point at.** A Redis 6.2+ (or Valkey) instance
reachable from the worker host, `maxmemory-policy noeviction` — BullMQ stores
job state in Redis and an eviction policy that discards keys discards
jobs — and persistence on (AOF) if a restart must not lose scheduled
repeats. It does **not** need to be reachable from the web tier: nothing in
`src/` enqueues to Redis, and after the swap nothing will. The connection in
`src/lib/redis.ts` is already lazy and already logs one warning rather than
crashing when Redis is absent, which is what makes the current state
survivable.

**What must be decided at the same time, and is not decided here.** With more
than one worker replica, repeatable jobs are delivered once across the fleet
rather than once per process — which is the point — but the claim lease and
the per-tenant batch limits become the only thing keeping two concurrent
*processors* off the same rows. They already do that job today, for the same
reason. It is worth re-reading them then rather than assuming.
