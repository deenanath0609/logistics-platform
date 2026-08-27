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
| Jobs | Redis + BullMQ, in a worker process separate from web |
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
| `npm run worker` | BullMQ workers (Phase 2) |
| `node scripts/bootstrap-db.mjs` | Create the database, check PostGIS |
| `node scripts/smoke.mjs` | Drive a running app: auth, scoping, master screens |
| `node scripts/check-append-only.mjs` | Prove the event log and audit trail reject tampering |
| `node scripts/check-pipeline.mjs` | Is the outbox draining? Are notifications actually sending? |
| `npx tsx scripts/verify-spine.ts` | Book a shipment and walk it through its whole life |
| `npx tsx scripts/verify-tracking-privacy.ts` | Prove public tracking leaks no internal data |
| `npx tsx scripts/verify-notifications.ts` | Prove the running server sends, and does not double-send |
| `node scripts/check-pricing.mjs` | Did booking actually price itself, or quietly write zero? |
| `node scripts/list-pincodes.mjs` | Which PIN codes can be booked to |
| `node scripts/latest-shipments.mjs` | Recent bookings with direct links |

---

## Layout

```
prisma/schema/     one file per domain — identity, geo, masters, platform
prisma/seed/       idempotent seed, split the same way
src/app/           (auth) (ops) (portal) (field) track/ api/
src/lib/           domain logic — see docs/BRD.html §B.11
src/server/        services (transactions) and repositories (scope guard)
workers/           background jobs, separate process
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
| — | Hardening, UAT, data migration | ⬜ Next |
