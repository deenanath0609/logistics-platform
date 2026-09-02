---
description: Pick up the City Logistics build exactly where the last session left off — state, rules, open items, and the next task
---

You are continuing a long-running build. Everything below is the handoff. Read
it fully before doing anything, then start on **The next task** at the bottom.

Anything the user typed after `/logistics` overrides the next task. With
nothing after it, do the next task as written.

---

## What this is

**City Logistics** — a white-label, multi-tenant freight operations platform at
`D:\Projects\Logistics`. Next.js 16 (App Router, Turbopack), TypeScript strict,
Tailwind v4, shadcn `base-nova`, Prisma 7 with `@prisma/adapter-pg`,
PostgreSQL 17, Auth.js v5 beta.

It is sold to **carriers**. Each carrier is an `Organization` and lives on its
own subdomain. There is a separate **operator console** on the bare domain,
where the platform owner provisions carriers and edits plans.

### Host layout — settled, do not re-litigate

| Host | Who |
|---|---|
| `localhost:3010` (bare domain) | platform operator console |
| `<carrier>.localhost:3010` | that carrier's staff, portal and public tracking |

Two carriers exist in the dev database: `city-logistics` (full plan) and
`acme` (limited plan). They are what every isolation and gating script uses.

### Three populations, three sessions

Namespaced subjects, never mixed: `platform:` for operators, `customer:` for
portal users, a bare cuid for carrier staff. A platform operator is **not** a
carrier user with a flag.

---

## Where it stands

Branch **`phase-9-to-14-multi-tenancy`**, 12 commits, **pushed** to
<https://github.com/deenanath0609/logistics-platform> on 30 Aug 2026. No PR
opened yet. `main` was never committed onto directly.

```
1,468 tests · 77 files · 0 type errors · production build clean
tenant:verify 29/29 · verify-plan-gating 25/25 · verify-gps 14/14
restore drill 11/11 · load 27.8 req/s, p95 1511ms, 0 errors
smoke.mjs 87 screens · smoke-platform 8/8 · smoke-portal 24/24
```

Next.js is on **16.3.3**. `xlsx` now comes from SheetJS's own distribution
(`cdn.sheetjs.com/xlsx-0.20.3/…`), not npm — `npm ci` needs to reach that
host.

### Phases

**"Tested" used to mean "somebody ran it once."** Every phase below read
`done / done` on 1 September, and the audit that followed found a real defect
in every single module it touched — a search box that dropped the branch
filter, shortages that never reached the control tower, a COD shortfall
overwritten so money vanished reconciled, route deviation switching itself off
ten minutes into every trip. None of them had a failing test.

So the column now says what was actually done, and there are three answers,
not two:

- **audited** — somebody read the code against the process it is supposed to
  serve, fixed what they found, and left a `verify:*` script behind that fails
  if the rule is deleted.
- **green** — an existing suite passes. That is worth something and it is not
  the same thing; every module in the audited list was green first.
- **—** — nothing.

| # | Scope | Built | Tested | Proof |
|---|---|---|---|---|
| 0 | Foundation | done | green | the rest of the table |
| 1 | Identity, network, masters | done | **audited** | `verify:core` 42 |
| 2 | Booking, pickup, event spine | done | **audited** | `verify:branch-flow` 112, `verify:spine`, `verify:pickup` 34 |
| 3 | Hub operations & transport | done | **audited** | `verify:hub` 117, `verify:dispatch` 83 |
| 4 | Last mile, POD, COD | done | **audited** | `verify:lastmile` 75, `verify:field` |
| 5 | Portal, tracking, notifications | done | **audited** | `verify:portal` 81, `verify:tracking-sla` 46, `verify:notifications:screens` 34 |
| 6 | Rating, billing, settlement | done | **audited** | `verify:billing` 119, `verify:reweigh` |
| 7 | GPS, geofencing, live map | done, PostGIS deferred | **audited** | `verify:gps` 14, `verify:tracking-privacy` 29 values |
| 8 | SLA, exception tower, reports | done | **audited** | `verify:reports` 61, `verify:sla` |
| 9 | Multi-tenancy, RLS, operator console | done | **audited** | `verify:tenancy-console` 77, tenant isolation 31 probes |
| 10 | Coverage for phases 0–9 | done | **audited** | `coverage:map` — and it says 58.9% of exports are dark |
| 11 | Modules and plans | done | **audited** | `verify:plan-gating` 27, `verify:modules-worker` 29 |
| 12 | Worker, object storage, PostGIS | 2 of 3 | **audited** | `verify:worker` — and see below, the old open item was never a bug |
| 13 | Per-tenant integration credentials | done | green | `verify:gps` |
| 14 | Hardening | done | **green** | CI is green on GitHub, every step, first time on 2 Sep 2026 |
| 15 | Five manuals and UAT | not started | — | |
| 16 | Deployment | done | green | live at `lms.credohrms.com`, 85 screens smoked |

Phase 10's own number is the one to keep in view: **1,726 tests pass, and only
22.9% of the 1,364 runtime exports carry an assertion that would fail if the
rule were deleted.** Two examples of what that bought: the two-person rule on
settlement approval — one line, the only thing stopping one person preparing
and approving the same payout — could be deleted with every test still green;
and the outbound-leak suite built its fixture from the allowlist, so it had
nothing forbidden to leak and proved only that a clean object stayed clean.
Both are now covered. `npm run coverage:map` prints the rest.

The live version of this table, with what proves each row, is the **Road to
Go-Live** artifact: <https://claude.ai/code/artifact/4f222412-26b8-4e47-87e1-613a75ee8fd9>
Update that same URL rather than publishing a new one.

### The open items

1. **~~Worker shutdown leaves one row claimed.~~ Closed 2 Sep 2026 — it was
   never a defect.** It was two `npm run worker` processes on the same
   database. One claims a row, the other finishes it in milliseconds. Always
   *exactly one* because the drain claims one row at a time, so a second live
   worker holds exactly one claim at any instant; and "recovered within five
   minutes" because it was recovered in under a second and the lease never
   came into it. The shutdown path was correct the whole time.

   Worth remembering for the next one of these: the observation was accurate
   and the explanation was invented to fit it. What settled it was killing the
   observing worker and watching the row clear anyway.

   `verify-worker.ts` now refuses to run while another worker is connected,
   rather than producing the contaminated result that was recorded as this
   bug; it waits to see whether a claimed row clears before calling it
   stranded; and the worker warns at startup when it is the second one on a
   database.
2. **PostGIS and Redis are absent locally.** Geofences evaluate in JavaScript
   and the outbox drains on a lease rather than BullMQ. Both are correct as
   written; the parity tests come with the switch on the server, not before.
3. **`Trip.freightPayable` is never written.** The column exists, vendor
   settlement reads it, nothing sets it. A product gap, not a security defect —
   needs the user's call on where the number comes from.
4. **Email is not implemented.** `emailAdapter` resolves the carrier's relay
   and then refuses to send — there is no transport behind it, deliberately.
   `nodemailer` was dropped rather than carried unused; add it back with the
   transport, on a version its SMTP-injection advisory does not name.
5. **Two advisories cannot be fixed from here.** `@auth/core` pins the
   nodemailer version that advisory names, and the only offered fix is
   next-auth v4; `@prisma/config` brings a deepmerge-ts advisory whose fix is
   Prisma 6.12. Both mean downgrading a framework this is built on, and the
   nodemailer path is Auth.js's email provider, which this app does not use.
   The CI audit job therefore reports and does not enforce.
6. **acme-freight has no vehicles with device ids.** The demo seed fits the
   default carrier's fleet only, so tracking probes against the second carrier
   skip rather than run. `verify-gps-tenancy.ts` says `[SKIP]` when it happens
   — that is not a pass.

### Closed since the last handoff

- **GPS polling now resolves per carrier** — `resolvePollProviders`, proved by
  `npm run verify:gps` (14/14) against the real database.
- **Next.js 16.1.6 → 16.3.3**, and `xlsx` moved to SheetJS's own distribution.
  The user chose that over replacing it with exceljs.
- **CI, a load test and a restore drill exist**: `.github/workflows/ci.yml`,
  `npm run load`, `npm run verify:restore`. The workflow has never actually
  run on GitHub — that is the next thing to watch.
- **The demo fleet was never fitted with devices**, so the whole tracking
  module was unreachable on seeded data. Fixed in the seed; re-run
  `npm run db:seed:demo` on any existing database.

---

## The user's standing rules

These were stated explicitly and hold until the user changes them.

- **Testing is a gate.** No feature moves to the next phase until its tests
  exist and pass. "Built" and "tested" are tracked as two separate columns for
  this reason.
- **Commit only when asked**, and always on a branch — never directly on `main`.
  Commit in readable slices, not one lump.
- **`.env` is gitignored and must stay that way.** It holds the database
  password and the RLS role's credentials. Grep any diff for secrets before
  pushing anywhere.
- **Use agents freely** for parallel work; the user asks for this repeatedly and
  gets impatient when work is serialised. Launch several at once for
  independent tasks.
- **The user writes in Hindi/Hinglish.** Reply the same way — plain Hinglish,
  short sentences, no translation ceremony.
- **Report failures honestly.** The user has caught padded claims before
  ("page 404 aa raha hai kya testing ki hai tumne") and was right to. A screen
  that has never been rendered is not tested.

---

## Traps that have already cost time

- **`currentOrgId()` / `requireTenant()` throw inside a request.** They read
  AsyncLocalStorage, which is only populated for jobs and scripts. Inside any
  request path use `await requireTenantOrgId()`, which resolves the carrier from
  the `Host` header via `next/headers`.
- **Node's `fetch` silently drops a `host` header.** Every smoke test that
  spoofed a tenant host through `fetch` was hitting the default carrier and
  reporting success. Use `scripts/host-fetch.ts` (`hostFetch`, `CookieJar`,
  `hostFollow`), which goes through `node:http`. Node also cannot resolve
  `*.localhost` — the helper connects to `127.0.0.1` and sets the header.
- **Prisma enums must be imported `import type`** in anything a client component
  can reach. A value import drags the Prisma runtime into the browser bundle and
  the page 500s trying to load `pg`. See `src/lib/shipment/modes.ts`.
- **shadcn `base-nova` is Base UI — there is no `asChild`.** Use
  `render={<Component />}`.
- **Write large files with the Write tool, not a heredoc.** A truncated heredoc
  once left a migration half-applied with Prisma recording it as done. Never use
  Python regex with `\1` or `\n` to patch TypeScript — it has written literal
  control characters and real newlines into source three times.
- **`runCrossTenant(reason, () => prisma.x.count(...))` does not work.** A
  Prisma promise is lazy, so the unawaited call is handed back and the scope
  pops before the query runs — the extension then refuses it. The callback must
  be `async` with the `await` inside it. This shipped green because the
  watchdog's test mocked `runCrossTenant` as `fn => fn()`, which has no
  AsyncLocalStorage in it: a mock that removes the mechanism cannot test the
  mechanism. See `worker-watchdog.scope.test.ts`.
- **The extension rewrites top-level `where` only.** A relation filter reaches
  across carriers, which is why all 110 tenant-owned tables carry `orgId`
  directly rather than relying on a join.

---

## Commands

```bash
npm run dev:3010              # the app — always port 3010
npm run worker                # the background worker, separate process
```

There is **no Docker on this machine**. The database is the native
**PostgreSQL 17 on port 5432**, database `logistics`. A `docker-compose.yml`
exists in the repo but is not what runs here — ignore it.

Row-level security is **on**: the app connects as `logistics_app`, a role that
owns nothing, so `DATABASE_URL` cannot run migrations. Prisma migrations use
`MIGRATE_DATABASE_URL`, held separately in `.env`. If a migration fails with a
permission error, that is why.

Verification — all of these must stay green:

```bash
npm test                      # 1,453 unit tests
npm run typecheck
npm run tenant:verify         # 29 isolation probes across two carriers
npx tsx scripts/verify-plan-gating.ts   # 25 module-gating probes
node scripts/smoke.mjs        # 87 ops screens over HTTP
npm run smoke:platform        # operator console
npm run smoke:portal          # customer portal
npm run smoke:api             # partner API
npm run verify:field          # the whole delivery cycle as a field agent
npm run verify:worker         # outbox drains outside the web server
npm run verify:spine          # a consignment booking to close
npm run verify:gps            # each carrier polls its own telematics account
npm run verify:restore        # a dump restores with its RLS roles and policies
npm run load                  # 20 concurrent staff; needs the built app
```

`npm run load` against `npm run dev:3010` reports p95 3.4s and means nothing —
a dev server compiles on first request. Build and `npm run start` before
quoting a number.

A script that cannot fail is not a test. Every one exits non-zero on failure and
prints PASS/FAIL per check.

---

## The next task

**Full testing of the twelve modules**, which the user gated everything else
behind: *"12 module full testing ke bad aage badenge."*

The twelve modules are declared in `src/lib/modules/registry.ts`. For each one,
drive it end to end as a real user on a real carrier host — not a unit test, not
a curl of one route — and write down what breaks. Report defects rather than
quietly fixing them, so each is attributed to the phase that owns it.

Start the dev server, launch parallel agents across the modules, and hold the
existing suites green throughout.

Phases 13 and 14 were finished first, on 30 Aug 2026, at the user's
instruction — *"pahle bache huye phases complete karo uske bad sabki testing
ak sath karenge"* — so this testing pass now covers them too. Tracking in
particular has never been exercised on data that could exercise it: until the
seed fitted device ids, the live map, the geofences and the ETAs all rendered
an empty yard.

### After that, in order

- **Phase 15 — the manuals.** Five documents, agreed scope, **start only when
  the user says so**: four written for one audience each (carrier office staff,
  field agents, customers, platform operator) plus one combined document for the
  user's own testing. With screenshots, taken on both hosts side by side so the
  white-label behaviour is visible rather than described.
- **Phase 16 — deployment.** GitHub is done; the server is not. The user chose
  to defer it on 30 Aug 2026 and to run on an IP without a domain for now,
  which means subdomain routing — and therefore every carrier host — does not
  work until a domain is chosen. `credohrms.com`'s nameservers are GoDaddy's
  (`ns49`/`ns50.domaincontrol.com`), so a wildcard `A` record goes there, not
  at Linode; a wildcard certificate needs Let's Encrypt DNS-01 with a GoDaddy
  API token. Sizing, measured on this data: 8 GB RAM (4 GB minimum, and
  `next build` alone peaks at 2–4 GB, so build in CI or add swap), 100 GB disk
  (40 GB minimum — GPS pings are the growth, ~70 MB/day per 100 vehicles held
  90 days). Then the restricted database role with `TENANT_RLS=on`, the worker
  as its own process, backups, and the GPS retention job scheduled.
