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

Branch **`phase-9-to-14-multi-tenancy`**, 8 commits, working tree clean,
nothing pushed to any remote yet. `main` was never committed onto directly.

```
1,453 tests · 75 files · 0 type errors
tenant:verify 29/29 · verify-plan-gating 25/25
smoke.mjs 87 screens · smoke-platform 8/8 · smoke-portal 24/24
```

### Phases

| # | Scope | Built | Tested |
|---|---|---|---|
| 0 | Foundation | done | done |
| 1 | Identity, network, masters | done | done |
| 2 | Booking, pickup, event spine | done | done |
| 3 | Hub operations & transport | done | done |
| 4 | Last mile, POD, COD | done | done |
| 5 | Portal, tracking, notifications | done | done |
| 6 | Rating, billing, settlement | done | done |
| 7 | GPS, geofencing, live map | done, PostGIS deferred | done |
| 8 | SLA, exception tower, reports | done | done |
| 9 | Multi-tenancy, RLS, operator console | done | done |
| — | Commit the work | done | done |
| 10 | Coverage for phases 0–9 | done | is the test |
| 11 | Modules and plans | done | done |
| 12 | Worker, object storage, PostGIS | 2 of 3 | partial |
| 13 | Per-tenant integration credentials | SMS/SMTP/WhatsApp done | partial |
| 14 | Hardening | security review done | partial |
| 15 | Five manuals and UAT | not started | — |
| 16 | Deployment | not started | — |

The live version of this table, with what proves each row, is the **Road to
Go-Live** artifact: <https://claude.ai/code/artifact/4f222412-26b8-4e47-87e1-613a75ee8fd9>
Update that same URL rather than publishing a new one.

### The six open items

1. **Worker shutdown leaves one row claimed.** A graceful stop still strands a
   single outbox row in `PROCESSING`. The claim lease recovers it within five
   minutes so nothing is lost. Root cause never found — say so, do not paper
   over it.
2. **GPS polling ignores the per-tenant provider.** The webhook route resolves
   each carrier's credentials; the polling loop in `src/lib/tracking/runtime.ts`
   still reads one environment-wide vendor. SMS, SMTP and WhatsApp are already
   per-carrier and encrypted.
3. **Next.js is on 16.1.6**; a bump to ≥16.2.6 is outstanding. Separately,
   `xlsx` from npm has no fixed release for its advisories — moving to the
   vendor's own distribution or replacing it is a decision for the user.
4. **No CI, no load test, no restore drill.** Every verification script runs
   only when someone remembers. A naive `pg_restore` does not bring the RLS
   roles and policies back.
5. **PostGIS and Redis are absent locally.** Geofences evaluate in JavaScript
   and the outbox drains on a lease rather than BullMQ. Both are correct as
   written; the parity tests come with the switch on the server, not before.
6. **`Trip.freightPayable` is never written.** The column exists, vendor
   settlement reads it, nothing sets it. A product gap, not a security defect —
   needs the user's call on where the number comes from.

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
```

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

### After that, in order

- **Phase 13 remainder** — wire GPS polling to each carrier's own credentials.
- **Phase 14 remainder** — Next.js bump, the `xlsx` decision, CI, load test,
  restore drill.
- **Phase 15 — the manuals.** Five documents, agreed scope, **start only when
  the user says so**: four written for one audience each (carrier office staff,
  field agents, customers, platform operator) plus one combined document for the
  user's own testing. With screenshots, taken on both hosts side by side so the
  white-label behaviour is visible rather than described.
- **Phase 16 — deployment.** GitHub, then Oracle from GitHub. Wildcard DNS and
  certificate, the restricted database role in production with `TENANT_RLS=on`,
  the worker as its own process, backups and the GPS retention job scheduled.
