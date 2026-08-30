import { platformDb, readingTenant } from "@/lib/platform/db";
import { recordPlatformAudit, requestMeta } from "@/lib/platform/audit";
import { fail, ok, type PlatformResult } from "@/lib/platform/result";
import { handoffUrl, loadOpenGrant } from "@/lib/platform/impersonation-session";
import type { PlatformOperator } from "@/lib/platform/session";

/**
 * Support sessions.
 *
 * This is the most dangerous capability in the product, so it is modelled
 * as a grant rather than as a power: a named operator, a named tenant, a
 * written reason, an expiry, and read-only unless somebody deliberately
 * asked for write. Nothing here is ambient — an operator with the
 * `impersonate` capability holds the ability to *open* a grant, not the
 * ability to be inside a tenant.
 *
 * ── The four moments of a grant ─────────────────────────────────────────
 * `open` (here) · `enter` (here, called from the carrier's host) · `end`
 * (here, from either host) · expiry (no event; the row simply stops being
 * usable). All but the last write a `PlatformAuditLog` row, and the last
 * one needs none because the grant's own `expiresAt` already says when it
 * stopped.
 *
 * The credential that carries a grant across the host boundary, and the
 * rules for whether it may still be used, live in
 * `impersonation-credential.ts` and `impersonation-session.ts`.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Long enough to reproduce a problem, short enough to be forgotten safely. */
export const DEFAULT_MINUTES = 30;
export const MAX_MINUTES = 240;

export type OpenGrantInput = {
  orgId: string;
  reason: string;
  minutes: number;
  /** Read-only unless someone deliberately asks otherwise. */
  allowWrites: boolean;
  /** A tenant user whose view is adopted. Null is read-only, tenant-wide. */
  asUserId: string | null;
};

/** Grants that are open right now: not ended, not expired. */
export async function listActiveGrants() {
  const grants = await platformDb.impersonationGrant.findMany({
    where: { endedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { startedAt: "desc" },
    include: { platformAdmin: { select: { id: true, name: true, email: true } } },
  });

  return withOrgNames(grants);
}

/**
 * Recent grants across every tenant, open or not.
 *
 * Kept separate from `listActiveGrants` because the two answer different
 * questions: one is "who is inside a customer right now?", which needs
 * acting on, and this is "what has support been doing?", which needs
 * reading. Collapsing them into one list with a status column buries the
 * first in the second.
 */
export async function recentGrants(take = 40) {
  const grants = await platformDb.impersonationGrant.findMany({
    orderBy: { startedAt: "desc" },
    take,
    include: { platformAdmin: { select: { id: true, name: true } } },
  });
  return withOrgNames(grants);
}

/** Every grant against one tenant, open or not — the support history. */
export async function grantsForOrg(orgId: string, take = 20) {
  const grants = await platformDb.impersonationGrant.findMany({
    where: { orgId },
    orderBy: { startedAt: "desc" },
    take,
    include: { platformAdmin: { select: { id: true, name: true } } },
  });
  return grants.map(markOpen);
}

/**
 * Whether a grant is live, decided here rather than in a page.
 *
 * "Open" is `not ended and not yet expired`, and it depends on the clock —
 * which makes it exactly the kind of thing a React render must not compute
 * (`react-hooks/purity` says so, and it is right: the answer would differ
 * between two renders of the same data). Deciding it at query time gives
 * every screen the same rule and one reading of the clock.
 */
function markOpen<T extends { endedAt: Date | null; expiresAt: Date }>(
  grant: T,
): T & { isOpen: boolean } {
  return {
    ...grant,
    isOpen: !grant.endedAt && grant.expiresAt.getTime() > Date.now(),
  };
}

/**
 * `ImpersonationGrant.orgId` is a plain column with no relation — the row
 * has to outlive the tenant, exactly like `PlatformAuditLog` — so the
 * carrier's name is looked up separately rather than joined.
 */
async function withOrgNames<
  T extends { orgId: string; endedAt: Date | null; expiresAt: Date },
>(rows: T[]) {
  const orgs = await platformDb.organization.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.orgId))] } },
    select: { id: true, name: true, subdomain: true },
  });
  const byId = new Map(orgs.map((org) => [org.id, org]));
  return rows.map((row) => ({
    ...markOpen(row),
    org: byId.get(row.orgId) ?? null,
  }));
}

/** Staff of one tenant, for the "act as" picker. */
export async function tenantUsersFor(orgId: string) {
  return readingTenant(orgId, (tx) =>
    tx.user.findMany({
      where: { orgId, deletedAt: null, status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, mobile: true },
      take: 200,
    }),
  );
}

export async function openGrant(
  input: OpenGrantInput,
  actor: PlatformOperator,
): Promise<PlatformResult<{ id: string; expiresAt: Date }>> {
  const reason = input.reason.trim();
  if (reason.length < 8) {
    return fail(
      "Give a reason — a ticket number and a sentence. It is the only record of why a stranger was inside a customer's data.",
    );
  }

  const minutes = Math.round(input.minutes);
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > MAX_MINUTES) {
    return fail(`Choose a duration between 5 and ${MAX_MINUTES} minutes.`);
  }

  const org = await platformDb.organization.findUnique({
    where: { id: input.orgId },
    select: { id: true, slug: true, name: true, status: true },
  });
  if (!org) return fail("That tenant no longer exists.");
  if (org.status === "CLOSED") {
    return fail(
      "A closed tenant refuses sign-in entirely; a support session into one would be a way back into a company that has been switched off.",
    );
  }

  // One open grant per operator. Not a technical limit — a behavioural one:
  // sessions left open in five carriers at once is how "time-boxed" stops
  // meaning anything.
  const existing = await platformDb.impersonationGrant.findFirst({
    where: {
      platformAdminId: actor.id,
      endedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, orgId: true },
  });
  if (existing) {
    return fail(
      "You already have an open support session. End it before opening another.",
    );
  }

  if (input.asUserId) {
    // Validated against the tenant being entered, not just against
    // existence: adopting a user of a different carrier would be a
    // cross-tenant grant wearing the right shape.
    // Captured because the narrowing from the `if` above does not survive
    // into the callback.
    const asUserId = input.asUserId;
    const user = await readingTenant(org.id, (tx) =>
      tx.user.findFirst({
        where: { id: asUserId, orgId: org.id, deletedAt: null },
        select: { id: true },
      }),
    );
    if (!user) return fail("That user does not belong to this tenant.");
  }

  const meta = await requestMeta();
  const expiresAt = new Date(Date.now() + minutes * 60_000);

  const grant = await platformDb.$transaction(async (tx) => {
    const created = await tx.impersonationGrant.create({
      data: {
        platformAdminId: actor.id,
        orgId: org.id,
        asUserId: input.asUserId,
        reason,
        allowWrites: input.allowWrites,
        expiresAt,
        ipAddress: meta.ipAddress,
      },
      select: { id: true, expiresAt: true },
    });

    await recordPlatformAudit(
      {
        action: "impersonation.open",
        actor,
        org,
        entity: "ImpersonationGrant",
        entityId: created.id,
        after: {
          allowWrites: input.allowWrites,
          asUserId: input.asUserId,
          expiresAt: created.expiresAt,
        },
        reason,
        ...meta,
      },
      tx,
    );

    return created;
  });

  return ok(grant);
}

/**
 * Ends a grant before it expires.
 *
 * Any operator who may impersonate can end anyone's session, not only
 * their own. Someone noticing an open session into a customer they are not
 * working with must be able to shut it immediately, and the audit row
 * names who did.
 */
export async function endGrant(
  grantId: string,
  actor: PlatformOperator,
): Promise<PlatformResult<null>> {
  return closeGrant(grantId, { id: actor.id, name: actor.name }, "console");
}

/**
 * Ends a grant from inside the carrier's app — the banner's own button.
 *
 * There is no operator cookie on this host to authorise with, and there
 * must not be: the whole point of the credential is that it carries a
 * grant and no identity. Authorisation is therefore a validly signed
 * credential naming this grant — which is a weaker check than the console
 * makes, and deliberately so, because *ending* is the safe direction. The
 * worst a stale token can do here is close a session early, which is what
 * any operator may already do to anyone from the console.
 *
 * The audit row is attributed to the operator the grant names, because
 * that is who is pressing the button, and `via` records which surface it
 * came from.
 */
export async function endGrantFromTenant(
  grantId: string,
): Promise<PlatformResult<null>> {
  const admin = await platformDb.impersonationGrant.findUnique({
    where: { id: grantId },
    select: { platformAdmin: { select: { id: true, name: true } } },
  });
  if (!admin?.platformAdmin) return fail("That support session no longer exists.");

  return closeGrant(grantId, admin.platformAdmin, "banner");
}

/**
 * The one place a grant is closed, whichever surface asked.
 *
 * `endedBy` and the audit row are written in the same transaction as the
 * update, because a session that ended with no trail is worse than one
 * that failed to end.
 */
async function closeGrant(
  grantId: string,
  actor: { id: string; name: string },
  via: "console" | "banner",
): Promise<PlatformResult<null>> {
  const grant = await platformDb.impersonationGrant.findUnique({
    where: { id: grantId },
    select: {
      id: true,
      orgId: true,
      platformAdminId: true,
      endedAt: true,
      reason: true,
    },
  });
  if (!grant) return fail("That support session no longer exists.");
  if (grant.endedAt) return fail("That support session has already ended.");

  const org = await platformDb.organization.findUnique({
    where: { id: grant.orgId },
    select: { id: true, slug: true },
  });

  const meta = await requestMeta();

  await platformDb.$transaction(async (tx) => {
    await tx.impersonationGrant.update({
      where: { id: grantId },
      data: { endedAt: new Date(), endedBy: actor.id },
    });
    await recordPlatformAudit(
      {
        action: "impersonation.end",
        actor,
        org,
        entity: "ImpersonationGrant",
        entityId: grantId,
        before: { platformAdminId: grant.platformAdminId, endedAt: null },
        after: { endedBy: actor.id, via },
        ...meta,
      },
      tx,
    );
  });

  return ok(null);
}

/**
 * The link that takes an operator from the console into a carrier's app.
 *
 * Two refusals that the console's UI cannot be trusted to make:
 *
 * - **Only your own grant.** Ending someone else's session is a safety
 *   valve and is deliberately open to anyone; *entering* it is not. A
 *   grant names one operator and one reason, and the audit trail is only
 *   worth reading if the person inside the tenant is the person the row
 *   names.
 * - **The grant is re-read here**, not taken from the list the page
 *   rendered. A grant that expired or was ended while the operator was
 *   looking at the screen must not produce a working link.
 */
export async function enterUrlFor(
  grantId: string,
  actor: PlatformOperator,
): Promise<PlatformResult<string>> {
  const grant = await loadOpenGrant(grantId);
  if (!grant) {
    return fail("That support session has ended or expired. Open a new one.");
  }
  if (grant.platformAdminId !== actor.id) {
    return fail(
      "That session belongs to another operator. You may end it, but you cannot enter it.",
    );
  }

  const org = await platformDb.organization.findUnique({
    where: { id: grant.orgId },
    select: { id: true, subdomain: true, customDomain: true, status: true },
  });
  if (!org) return fail("That tenant no longer exists.");
  if (org.status === "CLOSED") {
    return fail("That tenant has been closed since the session was opened.");
  }

  const url = await handoffUrl(org, grant);
  if (!url) return fail("That support session has expired. Open a new one.");

  return ok(url);
}

/**
 * The moment an operator actually lands inside a carrier's app.
 *
 * Opening a grant is an intention; entering it is the thing that happened,
 * and the two are hours apart often enough that one row cannot stand for
 * both. This row is also what makes an impersonated *write* attributable:
 * the carrier's own `AuditLog` names the adopted user (it has to — the
 * column is a foreign key into their staff table), and the pairing that
 * says "those rows, in that window, were an operator" lives only here.
 *
 * Best-effort, deliberately: the entry has already been authorised by the
 * grant row, and refusing to let an operator in because the log write
 * failed would help nobody. The `open` row already records the intent.
 */
export async function recordGrantEntry(grant: {
  id: string;
  orgId: string;
  platformAdminId: string;
  asUserId: string | null;
  allowWrites: boolean;
  reason: string;
  expiresAt: Date;
  operator: { id: string; name: string };
}): Promise<void> {
  const org = await platformDb.organization.findUnique({
    where: { id: grant.orgId },
    select: { id: true, slug: true },
  });

  await recordPlatformAudit({
    action: "impersonation.enter",
    actor: grant.operator,
    org,
    entity: "ImpersonationGrant",
    entityId: grant.id,
    after: {
      asUserId: grant.asUserId,
      // What the session can actually do, not what was asked for: a grant
      // with no adopted user is read-only however the box was ticked.
      writesAllowed: grant.allowWrites && grant.asUserId !== null,
      expiresAt: grant.expiresAt,
    },
    reason: grant.reason,
    ...(await requestMeta()),
  });
}
