# City Logistics

Freight operations platform — FTL, PTL and courier. Booking through
settlement, with a permanent record of custody for every consignment.

The full business and technical specification lives in
[`docs/BRD.html`](docs/BRD.html). Read §A.1 before writing code: shipment
status is **derived from operational events**, never typed into a dropdown,
and most of the architecture follows from that one decision.

---

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router), TypeScript strict, Tailwind v4 |
| Database | PostgreSQL 16+ (PostGIS from Phase 7) |
| ORM | Prisma 7 with `@prisma/adapter-pg`, multi-file schema |
| Auth | Auth.js v5 — password for office, mobile + OTP for field |
| Jobs | A worker process separate from web (`npm run worker`), on timers behind an adapter. BullMQ when Redis exists — `docs/adr/002-background-worker.md` |
| Files | S3-compatible object storage |

---

## Getting started

You need **Node 20+** and a **PostgreSQL server**. Docker is optional — see
below if you would rather run the dependencies in containers.

```bash
npm install
```

```bash
cp .env.example .env
```

Set `DATABASE_URL` in `.env` to your PostgreSQL server, then:

```bash
node scripts/bootstrap-db.mjs
```

That creates the `logistics` database if it is missing and enables PostGIS
when the server has it. Then apply the schema and load master data:

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm run dev
```

The app is on `http://localhost:3000` (or `npm run dev:3010` if that port is
taken). Health check: `/api/health`.

Then, in a second terminal:

```bash
npm run worker
```

**This is not optional.** Every scheduled job — the outbox drain, webhook
delivery, GPS polling, the SLA scan, GPS retention — runs in that process,
not in the web server. Without it the app looks entirely healthy and delivers
nothing: notifications stay QUEUED, no webhook fires, no GPS fix arrives and
no SLA breach is found. The web server says so at boot and complains once a
minute for as long as the outbox is backing up.

For a single-instance deployment, `RUN_JOBS_IN_WEB=true` puts the jobs back
inside the web server. Exactly one instance may set it.
`docs/adr/002-background-worker.md` explains the split and what the move to
BullMQ will take.

### Seeded logins

Mobile + password, all `Admin@123`:

| Mobile | Role |
|---|---|
| 9999999999 | Super Admin |
| 9999900001 | Operations Manager |
| 9999900002 | Branch Manager — Delhi Hub |
| 9999900003 | Booking Executive — Gurugram |
| 9999900004 | Hub Operator — Delhi Hub |
| 9999900010 | Accounts |

The full list is in `prisma/seed/users.ts`. Re-seeding never overwrites a
password that has already been changed.

### Optional: containers

`docker-compose.yml` provides PostGIS, Redis and MinIO on non-default ports
(5433, 6380, 9000) so they do not collide with anything already installed:

```bash
docker compose up -d
```

If you use it, point `DATABASE_URL` at port **5433**.

---

## What runs without what

The platform is built in phases, so some dependencies are not needed yet.
`/api/health` reports each one; only Postgres marks the service unhealthy.

| Dependency | Needed from | Missing today means |
|---|---|---|
| PostgreSQL | Phase 1 | Nothing works |
| Redis | Phase 2 | No background jobs; web app is fine |
| PostGIS | Phase 7 | No geofence evaluation; fences can still be defined |
| S3 / MinIO | Phase 4 | No POD photo storage |

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Vitest |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:seed` | Load masters, roles, and dev users (idempotent) |
| `npm run db:studio` | Prisma Studio |
| `npm run worker` | The background worker — every scheduled job. Run it alongside `npm run dev`. |
| `npm run tenant:new -- --slug acme --name "Acme Freight" --subdomain acme` | Provision a carrier: org, template masters, onboarding checklist. Resumable. |
| `npm run platform:admin -- --email you@example.com --name "You"` | Create the first platform operator |
| `npm run tenant:verify` | Adversarial suite — prove one tenant cannot reach another |
| `npm run tenant:models` | Regenerate the scoped-model list after a schema change |
| `node scripts/bootstrap-db.mjs` | Create the database, check PostGIS |
| `npm run smoke` | Drive a running app as an admin: sign-in, RBAC, and every ops screen that renders a list or a detail — around eighty-five of them, plus all twenty-two report runners. Fails with the path of anything that does not render. |
| `npm run smoke:portal` | Drive the customer portal as a real customer: every screen, then a second customer under the same carrier proving it cannot open the first one's records |
| `npm run smoke:api` | Drive the partner API with keys it mints and deletes: every endpoint, scope refusal, customer scoping, and the cross-carrier boundary |
| `npm run smoke:platform` | Drive the operator console as an operator |
| `node scripts/check-append-only.mjs` | Prove the event log and audit trail reject tampering |
| `node scripts/check-pipeline.mjs` | Is the outbox draining, and is it the worker or a web server doing it? |
| `npm run verify:worker` | Fork a real worker: prove it drains, stops without stranding a row, and recovers from a kill |
| `npm run verify:spine` | Book a shipment and walk it through its whole life |
| `npm run verify:field` | Drive a delivery run the way the field app does — assign, out-scan, fail an attempt, replay the queue, deliver, capture the POD, close — then read the story back out of the event log |
| `npx tsx scripts/verify-tracking-privacy.ts` | Prove public tracking leaks no internal data |
| `npx tsx scripts/verify-notifications.ts` | Prove the running server sends, and does not double-send |
| `node scripts/check-pricing.mjs` | Did booking actually price itself, or quietly write zero? |
| `node scripts/list-pincodes.mjs` | Which PIN codes can be booked to |
| `node scripts/latest-shipments.mjs` | Recent bookings with direct links |

---

## Tenancy

The platform is white-label: several carriers run on one deployment, one
database and one set of workers. `docs/adr/001-multi-tenancy.md` has the
reasoning; this is what it means day to day.

**A tenant is resolved from the hostname, before any query runs.**
`acme.platform.com` is Acme. A host that names no tenant is a 404 — never a
fallback to a default carrier, because serving one company's consignments
under another's address is the worst thing this system can do.

**The bare platform domain is not a carrier — it is the operator console.**
`platform.com` in production, `localhost:3010` in development. Every carrier
lives on a subdomain, so development exercises exactly the resolution path
production uses, and there is no "default tenant" code path to get wrong.

**Nothing below the request layer takes an `orgId` argument.** `prisma` from
`@/lib/prisma` is wrapped in an extension that adds the tenant filter to
every read and stamps it on every write. It **fails closed**: a scoped query
with no tenant established throws rather than returning every tenant's rows,
which is why background jobs and scripts have to say who they are acting as.

Three ways to say it:

| | For |
|---|---|
| nothing — just query | Anything inside an HTTP request |
| `runWithTenant(ctx, fn)` | Background jobs, scripts, tests |
| `runCrossTenant(reason, fn)` | The operator console, tenant resolution, the seed. The reason is required and is what an auditor greps for. |

`forEachTenant()` is the loop every scheduled pass uses: enumerate carriers,
run the work inside each one's context, and let one carrier's failure not
stop the rest.

**Row-level security is the second mechanism, and it is on.**
ADR 001 asks for two, because the extension above can be bypassed — by raw
SQL, by a nested write, by a model that escapes the generated list. The
policies compare `"orgId"` to a session variable and match nothing when it
is unset, so they fail closed the same way. RLS does not apply to a table's
owner, so switching it on means giving the application its own database
role:

```bash
node scripts/apply-rls.mjs
```

That prints the SQL and changes nothing; `npm run db:rls -- --apply` writes
it, and `--revoke` undoes it. The four settings that go with it are already
in `.env`: `DATABASE_URL` points at the restricted `logistics_app` role,
`MIGRATE_DATABASE_URL` keeps the owner's connection for Prisma Migrate, and
`TENANT_RLS=on` makes the client carry the tenant into each statement.
Switching the role without `TENANT_RLS=on` produces an application that
reads nothing — they go together.

What this buys, concretely: as the application role with no tenant on the
session, `SELECT count(*) FROM shipment` returns **0**. Not "the extension
declined" — the database has no rows to give. `npm run tenant:verify` asserts
exactly that, in raw SQL, as its last probe.

Two consequences worth knowing. The operator console reaches inside one
named tenant in two places (the "act as" picker, and validating a grant's
user); those use `readingTenant(orgId, …)` in `src/lib/platform/db.ts`. And
the diagnostics under `scripts/` read across every carrier by design, so
they use the owner connection via `scripts/operator-db.mjs` and say so when
they start.

**Writes name the tenant, and the extension checks it.** `orgId` is NOT NULL,
so a `create` has to supply it — from the actor already in scope, usually.
That is not a trust hole: a write whose `orgId` disagrees with the
host-resolved tenant is refused.

**Which models are scoped is derived from the schema**, not hand-maintained
— `src/lib/tenant/scoped-models.generated.ts`, regenerated by
`npm run tenant:models`, with a test that fails when it is stale. A new
tenant-owned table cannot quietly ship without isolation.

**The operator console is a separate product.** It lives on the bare
platform domain (`localhost:3010/platform` in development), and on
`admin.<APP_ROOT_DOMAIN>` for anyone who wants it on its own name. A
carrier's own subdomain 404s it, and it 404s a carrier's app. `PlatformAdmin` is its own table with its
own cookie and its own type: a support login cannot satisfy a tenant
permission check, because there is no way to spell the call. Bootstrap the
first operator with `npm run platform:admin`.

**Branding is a stylesheet, not a fork.** Every component already reads
`--primary`, `--ok`, `--warn`, `--bad`, so a tenant palette overrides those
custom properties and nothing else. Status colours deliberately do not move:
a carrier whose brand is red must not end up with red meaning "delivered".

## Layout

```
prisma/schema/     one file per domain — identity, geo, masters, platform
prisma/seed/       idempotent seed, split the same way
src/app/           (auth) (ops) (portal) (field) track/ api/
src/lib/           domain logic — see docs/BRD.html §B.11
src/server/        services (transactions) and repositories (scope guard)
workers/           the background worker — all five scheduled loops, its own process
docs/              BRD, ADRs, runbooks
```

### Conventions

These are load-bearing, not style preferences:

- Route handlers contain **no business logic**. Services own transaction
  boundaries; repositories are the only place Prisma is touched.
- The shipment state machine is the **only** writer of shipment status.
- `ShipmentEvent` and `AuditLog` are **append-only**. A correction is a new
  compensating event with a reason code, never an edit.
- Money is `Decimal(14,2)` with decimal.js. Never floats.
- Every scoped query goes through the repository layer so branch and customer
  isolation cannot be bypassed by a missing UI guard.

---

## Build progress

| Phase | Scope | State |
|---|---|---|
| 0 | Foundation — scaffold, database, tokens, health | ✅ Done |
| 1 | Identity, network, masters | ✅ Done |
| 2 | Booking, pickup, event spine | ✅ Done |
| 3 | Hub operations & transport | ✅ Done |
| 4 | Last mile, POD, COD | ✅ Done |
| 5 | Customer portal, tracking, notifications | ✅ Done — **MVP complete** |
| 6 | Rating, billing, settlement | ✅ Done |
| 7 | GPS, geofencing, live map | ✅ Done |
| 8 | SLA, exception tower, reports & MIS | ✅ Done |
| 9 | White-label multi-tenancy — isolation, subdomains, branding, operator console | ✅ Done |
| — | Hardening, UAT, data migration | ⬜ Next |
