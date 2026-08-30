# ADR 001 — White-label multi-tenancy

**Status:** accepted, 27 August 2026
**Context:** the platform is being sold to several logistics companies rather
than run for one.

---

**Go-live:** hold, and launch directly as multi-tenant. No single-tenant
production deployment first. Deploying single-tenant would get the system in
front of users sooner, but it buys that with a migration of live operational
data onto tenancy later — and isolation is the single worst thing to retrofit
while a business depends on it.

---

## Decisions

| Question | Decision |
|---|---|
| Isolation | **Shared database, row-level by `orgId`, with PostgreSQL RLS underneath** |
| Routing | **Subdomain now** (`acme.platform.com`), custom domain later |
| Branding | **Full white-label** — app, documents, notifications, public tracking |
| Master data | **Everything per-tenant, including geography** |

---

## 1. Isolation — `orgId` plus RLS

Every tenant-owned row carries `orgId`. Two independent mechanisms enforce it:

1. **A Prisma client extension** injects `orgId` into every `where` and every
   `create` for tenant-scoped models. This is the ergonomic layer — callers
   do not think about tenancy.
2. **PostgreSQL Row-Level Security** on every tenant table, keyed on a
   session variable the connection sets per request.

The second exists because the first is not enough. A single forgotten filter
in one report, one raw query, one `findMany` written at 6pm, and one
customer sees another's consignments. RLS is the backstop the application
**cannot** bypass, and it is the difference between a bug and a breach.

Child rows reachable only through a scoped parent — `InvoiceLine`,
`RateSlab`, `ManifestLine`, `ShipmentPackage` — inherit isolation through the
foreign key and do not need their own column. Rows queried directly by id
from a URL do.

### Why not schema-per-tenant

Migrations across 50 schemas are slow and fail halfway. Cross-tenant
reporting — which the business will want the moment it has ten customers —
becomes a union across schemas. Shared-plus-RLS is the standard answer at
this scale and keeps one migration path.

---

## 2. Routing — subdomain first

Tenant is resolved from the `Host` header **before any query runs**, in
middleware, and carried through the request. An unresolvable host is a 404,
not a fallback to a default tenant: silently serving the wrong company's data
is the worst failure mode this system has.

Custom domains (`track.acmelogistics.com`) reuse the same resolution and add
per-tenant certificate provisioning. Deferred, not designed out.

The public tracking page inherits the subdomain, so a consignee who has never
heard of us sees the carrier's brand.

---

## 3. Branding

Four surfaces, in order of visibility to people who are not our users:

1. **Public tracking** — the most-seen surface; consignees, not customers.
2. **Documents** — LR, POD, invoice. What people physically hold.
3. **Notifications** — sender ID and email domain.
4. **The app itself** — logo, colours, name.

Colour is delivered by overriding the CSS custom properties already defined
in `globals.css`. The token system was built for this: every component reads
`--primary`, `--ok`, `--warn`, `--bad`, so a tenant palette is a stylesheet,
not a fork.

### The notification caveat

Indian transactional SMS requires **each tenant** to register their own
sender header and every template on DLT — one to three weeks of external
approval **per tenant**. This is an onboarding lead time, not a code task,
and it must appear on the tenant onboarding checklist or the first customer
will go live unable to send a delivery OTP.

---

## 4. Master data — per-tenant, including geography

Every master is per-tenant: service types, package types, charge heads, tax
rates, reason codes, vehicle types, routes, geofences, **and** states, cities
and pincodes.

This is the simplest isolation story — no shared table, no contention, no
question about who may edit a shared row.

**The consequence, stated plainly:** each new tenant starts with an empty
geography and must load their own pincode master. To stop that being a
blocker on day one, onboarding **copies a template dataset** into the new
tenant: states, cities, and a starter pincode set, plus default service
types, charge heads, tax rates and reason codes. The tenant then owns and
edits their copy. The importer at `/masters/pincodes/import` already handles
the full ~19,000-row load.

Exceptions that stay global:

- **`Permission`** — the `resource.action` catalogue is code, not data.
- **`Organization`** — the tenant list itself.

---

## Consequences

**Good**

- One migration path, one deployment, one set of background workers.
- Cross-tenant reporting stays possible for the operator.
- The token-based design means branding costs a stylesheet per tenant.

**Costs**

- Every existing query must be audited for tenant scoping. There are
  currently **no** `orgId` filters anywhere — branch scoping is doing the
  work, which is correct within a tenant and useless between them.
- Eight masters need an `orgId` column and a backfill.
- `Pincode` serviceability becomes tenant-owned: whether you deliver to a PIN
  is a fact about a company, not about the PIN.
- Onboarding becomes a real feature, not a SQL insert.

**Non-negotiable acceptance test**

A test suite that proves tenant A cannot reach tenant B's data through *any*
path: the UI, a server action, the partner API, a report export, a webhook
payload, and public tracking. Written as an adversarial suite that fails
loudly, in the spirit of the existing tracking-privacy test — which was
verified to genuinely fail when the projection was widened.


---

## Amendment, 28 August 2026 — child rows carry the tenant key after all

**Superseded above:** §1's rule that a child row reachable only through a
scoped parent inherits isolation through its foreign key and needs no
`orgId`. It does need one. Every tenant-owned table now carries the column.

**What went wrong.** The Prisma extension rewrites the **top-level** `where`
of an operation. It does not rewrite a nested relation filter, because a
relation filter is an argument to the parent model's query planner rather
than a predicate on the model being read. So this reached across tenants:

```ts
prisma.shipmentEvent.findMany({ where: { shipment: { id } } })
```

The adversarial suite caught it on the event log — the chain of custody,
the table every other projection in the product is derived from. The rule
was not wrong in theory: a child *is* isolated when reached through its
parent. It was wrong because "reached through its parent" is a property of
every present and future call site, not of the schema, and there is no way
to enforce it.

Two other faults of the same shape were found at the same time, both worse
than a read:

- `ShipmentPackage.barcode` was globally unique, and the dock resolves a
  package **by barcode alone**. A scan in carrier A resolved and then
  updated carrier B's package row, and wrote a `ScanRecord` pointing at B's
  consignment, before the event append downstream correctly refused.
- `ScanRecord.idempotencyKey` was globally unique, so two carriers' offline
  queues could collide.

**The second reason, which settles it.** Row-level security can only carry a
policy on a table that holds the tenant key. Every table left inheriting
isolation through a foreign key was a hole in the backstop in exactly the
place the application layer also had one — the two mechanisms failed
together rather than independently, which defeats the point of having two.

**Cost, stated plainly.** Roughly forty more columns and their backfills, an
`orgId` on writes that previously did not name one, and a wider index
footprint on some large tables. That is the price of isolation being a
property of the schema rather than of everybody's discipline.

**What stays global:** `Organization`, `Permission`, the platform-operator
tables (`PlatformAdmin`, `PlatformAuditLog`, `TenantPlan`), `JobRun`, and
`Session` — the last because it is resolved from a token before any tenant
is known.
