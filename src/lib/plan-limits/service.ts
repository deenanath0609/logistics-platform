import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { requireTenantOrgId } from "@/lib/tenant/resolve";
import { monthWindow } from "./month";
import {
  limitOutcome,
  LIMIT_KEYS,
  LIMIT_WORDS,
  PlanLimitError,
  UNNAMED_PLAN,
  type LimitKey,
} from "./limits";

/**
 * Plan limits, enforced where the thing is created.
 *
 * The schema settled this: a carrier is told when they hit a cap rather
 * than discovering it on an invoice. So the eleventh user on a ten-user
 * plan is refused at creation, naming the plan and the number — not
 * created and reconciled later by a nightly job.
 */

export type ResolvedPlan = {
  /** Null when the carrier is on no plan at all. */
  name: string | null;
  code: string | null;
  limits: Record<LimitKey, number | null>;
  /** The carrier's own clock, which is what "this month" is measured on. */
  timeZone: string;
};

const NO_LIMITS: Record<LimitKey, number | null> = {
  users: null,
  branches: null,
  shipmentsThisMonth: null,
  portalUsers: null,
};

/**
 * ── A carrier with no plan is unconstrained ─────────────────────────────
 *
 * `Organization.planId` is nullable and provisioning sets it to null, so
 * this is the ordinary state of a new tenant rather than a corner case:
 * every carrier is plan-less between being provisioned and being priced.
 *
 * The alternative — treat "no plan" as zero, i.e. nothing included — was
 * rejected because provisioning itself creates the head-office branch and
 * the owner login, so a carrier could not be brought into existence at
 * all, and the first thing a new customer would meet is a refusal.
 *
 * Note this is the opposite decision from `modulesForPlan`, which gives a
 * plan-less tenant only the always-on modules. The two are not
 * inconsistent: a *module* is a capability that has to be bought, so
 * withholding it costs the carrier nothing they paid for, while a *limit*
 * is a term of a contract that does not exist yet, and inventing one would
 * be enforcing a number nobody agreed. Limits fail open and modules fail
 * closed, and in both directions the operator holds the lever — attach a
 * plan.
 * ────────────────────────────────────────────────────────────────────────
 */
export const currentPlan = cache(async (): Promise<ResolvedPlan> => {
  // The async resolver, not the synchronous `requireTenant()`. Inside a
  // request the tenant comes from the `Host` header via `next/headers`;
  // AsyncLocalStorage is only populated for jobs and scripts, so the sync
  // form throws on every page that asks — which is what made /admin/users
  // a 500 the moment this panel was added to it.
  const orgId = await requireTenantOrgId();

  // `Organization` is one of the genuinely global tables (ADR 001 §4), so
  // the tenant extension does not filter it and the id has to be named.
  // That is not the caller trusting an argument: `orgId` is the tenant the
  // host already resolved to, before any of this ran.
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      timezone: true,
      plan: {
        select: {
          code: true,
          name: true,
          maxUsers: true,
          maxBranches: true,
          maxShipmentsPerMonth: true,
          maxPortalUsers: true,
        },
      },
    },
  });

  const plan = org?.plan;
  if (!plan) {
    return {
      name: null,
      code: null,
      limits: NO_LIMITS,
      timeZone: org?.timezone ?? "Asia/Kolkata",
    };
  }

  return {
    name: plan.name,
    code: plan.code,
    limits: {
      users: plan.maxUsers,
      branches: plan.maxBranches,
      shipmentsThisMonth: plan.maxShipmentsPerMonth,
      portalUsers: plan.maxPortalUsers,
    },
    timeZone: org.timezone,
  };
});

// ────────────────────────────────────────────────────────────
// Counting what exists
// ────────────────────────────────────────────────────────────

/**
 * A seat is a login that can still be used.
 *
 * Deactivated staff keep their rows forever — `AuditLog`, `Pod.agentId` and
 * every delivery they ever made point at them — but they are not occupying
 * a seat, so a carrier that has churned through forty drivers is not billed
 * as if all forty were working. SUSPENDED does count: that is a temporary
 * bar on one person, not a seat given back.
 *
 * The portal service principal is excluded by the same rule rather than by
 * name, because it is created INACTIVE — a carrier must not lose a seat to
 * a row the product created on their behalf.
 */
function countUsers(): Promise<number> {
  return prisma.user.count({
    where: { deletedAt: null, status: { not: "INACTIVE" } },
  });
}

function countBranches(): Promise<number> {
  return prisma.branch.count({ where: { deletedAt: null, isActive: true } });
}

function countPortalUsers(): Promise<number> {
  return prisma.customerUser.count({
    where: { deletedAt: null, isActive: true },
  });
}

/**
 * ── The monthly shipment count ──────────────────────────────────────────
 *
 * This runs on the hottest path in the product, so what it costs matters
 * more than anywhere else in this file.
 *
 * **What it does.** A `count` over a half-open `bookedAt` range on the
 * carrier's own clock, which the tenant extension turns into
 * `org_id = $1 AND booked_at >= $2 AND booked_at < $3`. The
 * `(org_id, booked_at)` index added alongside this makes that an index-only
 * scan of exactly one carrier's month — no heap access, no other tenant's
 * rows walked. Without that index the planner has only `(booked_at)`, which
 * would walk *every* carrier's month to count one of them, and would get
 * steadily worse as carriers are added: the cost of enforcing Acme's limit
 * would depend on how many other companies use the platform.
 *
 * **What it costs.** One index-only scan of n entries, where n is that
 * carrier's bookings so far this month — a few hundred microseconds at a
 * few thousand, single-digit milliseconds at fifty thousand — against a
 * booking that already runs a multi-statement transaction. And it is
 * skipped entirely when there is no cap, which is every carrier with no
 * plan and every carrier on an uncapped plan, so most bookings pay nothing
 * at all.
 *
 * **What was rejected.**
 *
 * - *`TenantUsageSnapshot`.* The obvious candidate, and the schema even
 *   points at it. But it is written by a scheduled pass that does not exist
 *   yet — nothing in `src/` writes that table, only the operator console
 *   reads it — so enforcing against it today would enforce against zero.
 *   Even once written it lags by a day, and a day is long enough for a
 *   carrier on a thousand-a-month plan to book two thousand. It remains the
 *   right substrate for *billing*, which is a monthly reconciliation and
 *   can afford to be a day behind; it is the wrong one for a refusal at the
 *   counter. A hybrid — sum the settled days, count only today — would fix
 *   the lag and bound the live count to a single day, and is the upgrade
 *   path if a carrier ever books enough that a month's scan hurts.
 *
 * - *A Redis counter.* Fastest, and wrong for this. Redis here is
 *   deliberately optional — the client is lazy and logs a warning rather
 *   than failing — so a counter kept there either fails bookings when Redis
 *   is down or falls back to this query anyway, and an evicted or
 *   never-seeded key silently reads as zero, which is unlimited. Putting
 *   the hottest write path in the product behind a cache that fails open on
 *   a commercial control is a bad trade for a few hundred microseconds.
 *
 * - *A process-local counter with a TTL.* Over-admits by up to one window
 *   per app instance, invisibly, and the drift grows with the number of
 *   instances. The request-scoped tally below is the same idea confined to
 *   a scope where it is exactly correct.
 * ────────────────────────────────────────────────────────────────────────
 */
function countShipmentsThisMonth(timeZone: string): Promise<number> {
  const { start, end } = monthWindow(new Date(), timeZone);
  return prisma.shipment.count({
    where: { bookedAt: { gte: start, lt: end } },
  });
}

/**
 * The month's count as read once per request, plus what this request has
 * booked since.
 *
 * A bulk commit books hundreds of consignments inside a single request. Re-
 * counting for each one would turn one index scan into five hundred, so the
 * count is read once and the request keeps its own tally of what it has
 * added — which within one request is not an estimate but the exact number.
 *
 * `cache` scopes the box to the request, exactly as `getCurrentUser` is
 * scoped. Outside a request scope — a worker, a script, a test — it hands
 * back a fresh box each call, so the count is simply taken every time:
 * slower, never stale.
 */
type Tally = { key: string | null; base: number; added: number };

const shipmentTally = cache((): Tally => ({ key: null, base: 0, added: 0 }));

async function shipmentsThisMonth(timeZone: string): Promise<number> {
  const tally = shipmentTally();
  const { key } = monthWindow(new Date(), timeZone);

  if (tally.key !== key) {
    tally.key = key;
    tally.base = await countShipmentsThisMonth(timeZone);
    tally.added = 0;
  }
  return tally.base + tally.added;
}

/**
 * Called once a shipment has actually been created.
 *
 * Separate from the assertion on purpose. Reserving headroom at the moment
 * of the check would make a booking that then failed — a rolled-back
 * transaction, a pricing fault, a validation refusal further down — consume
 * a slot it never used, and inside a five-hundred-row import those add up
 * to a carrier being refused rows they are entitled to.
 */
export function noteShipmentBooked(): void {
  const tally = shipmentTally();
  if (tally.key !== null) tally.added += 1;
}

function countFor(key: LimitKey, timeZone: string): Promise<number> {
  switch (key) {
    case "users":
      return countUsers();
    case "branches":
      return countBranches();
    case "portalUsers":
      return countPortalUsers();
    case "shipmentsThisMonth":
      return shipmentsThisMonth(timeZone);
  }
}

// ────────────────────────────────────────────────────────────
// The assertion
// ────────────────────────────────────────────────────────────

/**
 * Refuses the creation of one more of `key`, or returns.
 *
 * Throws `PlanLimitError`, which carries the cap, the current count and the
 * plan name so the call site can render a sentence a carrier can act on
 * without knowing anything about plans.
 */
export async function assertWithinLimit(key: LimitKey): Promise<void> {
  const plan = await currentPlan();
  const limit = plan.limits[key];
  const planName = plan.name ?? UNNAMED_PLAN;

  // Unlimited: no count, no query. This is the common case — every carrier
  // with no plan, and every cap a plan leaves blank — and it has to cost
  // nothing, because booking goes through here.
  if (limit === null) return;

  // Zero is answered without counting too: no count can change the answer,
  // and a query run to confirm a foregone conclusion is a query wasted.
  if (limit <= 0) {
    throw new PlanLimitError(key, limit, 0, planName, "not-included");
  }

  const current = await countFor(key, plan.timeZone);
  const outcome = limitOutcome(limit, current);
  if (outcome.allowed) return;

  throw new PlanLimitError(key, limit, current, planName, outcome.reason);
}

// ────────────────────────────────────────────────────────────
// The read side
// ────────────────────────────────────────────────────────────

export type LimitUsage = {
  key: LimitKey;
  label: string;
  current: number;
  /** Null is unlimited; zero means the feature is switched off. */
  limit: number | null;
  /** How many more may be created. Null when there is no cap. */
  remaining: number | null;
  /** 0–1 for a progress bar, clamped. Null when there is no cap. */
  fraction: number | null;
};

export type PlanUsage = {
  /** Null when the carrier is on no plan. */
  planName: string | null;
  planCode: string | null;
  limits: LimitUsage[];
};

/**
 * Where the carrier stands against every cap.
 *
 * Counts all four whether or not they are capped: "8 users" is worth
 * showing on an uncapped plan too, and this is a page load rather than a
 * booking, so four counts in parallel is the right shape.
 */
export async function planUsage(): Promise<PlanUsage> {
  const plan = await currentPlan();

  const counts = await Promise.all(
    LIMIT_KEYS.map((key) => countFor(key, plan.timeZone)),
  );

  return {
    planName: plan.name,
    planCode: plan.code,
    limits: LIMIT_KEYS.map((key, index) => {
      const limit = plan.limits[key];
      const current = counts[index];
      return {
        key,
        label: LIMIT_WORDS[key].label,
        current,
        limit,
        remaining: limit === null ? null : Math.max(0, limit - current),
        fraction:
          limit === null
            ? null
            : limit <= 0
              ? 1
              : Math.min(1, current / limit),
      };
    }),
  };
}
