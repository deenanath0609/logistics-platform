import { platformDb } from "@/lib/platform/db";
import { changedFields, recordPlatformAudit, requestMeta } from "@/lib/platform/audit";
import { fail, ok, type PlatformResult } from "@/lib/platform/result";
import type { PlatformOperator } from "@/lib/platform/session";
import { bustTenantCache } from "@/lib/tenant";
import { resetCarrierCache } from "@/lib/notifications/carrier";
import { isValidSubdomain, normaliseHost, RESERVED_SUBDOMAINS } from "@/lib/tenant/host";
import { parseHex } from "@/lib/tenant/colour";
import type { Prisma, TenantStatus } from "@/generated/prisma/client";

/**
 * The tenant estate, as the operator sees it.
 *
 * Every read here crosses tenants by definition, so everything goes
 * through `platformDb` (see `db.ts` for why that, rather than
 * `runCrossTenant`). Every write goes through one transaction that also
 * writes the audit row, so a change without a trail is not a state this
 * table can reach.
 */

// ────────────────────────────────────────────────────────────
// Reads
// ────────────────────────────────────────────────────────────

export const TENANT_PAGE_SIZE = 40;

export type TenantSort = "name" | "created" | "status" | "plan";

export type TenantListFilters = {
  status?: TenantStatus;
  planId?: string;
  q?: string;
  sort?: TenantSort;
  page?: number;
};

/** The headline numbers, taken from the most recent snapshot for each org. */
export type TenantUsageHeadline = {
  onDate: Date;
  shipments: number;
  deliveries: number;
  activeUsers: number;
  branches: number;
  portalUsers: number;
};

export type TenantListRow = {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
  customDomain: string | null;
  status: TenantStatus;
  createdAt: Date;
  plan: { id: string; code: string; name: string } | null;
  usage: TenantUsageHeadline | null;
  /** Blocking onboarding tasks still open. Zero means ready to hand over. */
  blockingTasks: number;
};

const ORDER_BY: Record<TenantSort, Prisma.OrganizationOrderByWithRelationInput[]> = {
  name: [{ name: "asc" }],
  created: [{ createdAt: "desc" }],
  // Status first, then name, so the eye can scan a block of SUSPENDED rows
  // rather than hunting them out of an alphabetical list.
  status: [{ status: "asc" }, { name: "asc" }],
  plan: [{ plan: { sortOrder: "asc" } }, { name: "asc" }],
};

export async function listTenants(filters: TenantListFilters): Promise<{
  rows: TenantListRow[];
  total: number;
  page: number;
}> {
  const page = Math.max(1, filters.page ?? 1);
  const q = filters.q?.trim();

  const where: Prisma.OrganizationWhereInput = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.planId ? { planId: filters.planId } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { slug: { contains: q, mode: "insensitive" as const } },
            { subdomain: { contains: q, mode: "insensitive" as const } },
            { customDomain: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [orgs, total] = await Promise.all([
    platformDb.organization.findMany({
      where,
      orderBy: ORDER_BY[filters.sort ?? "name"],
      skip: (page - 1) * TENANT_PAGE_SIZE,
      take: TENANT_PAGE_SIZE,
      select: {
        id: true,
        name: true,
        slug: true,
        subdomain: true,
        customDomain: true,
        status: true,
        createdAt: true,
        plan: { select: { id: true, code: true, name: true } },
      },
    }),
    platformDb.organization.count({ where }),
  ]);

  const orgIds = orgs.map((org) => org.id);
  const [snapshots, openBlocking] = await Promise.all([
    // The latest snapshot per tenant. Ordered by org then date descending
    // with `distinct` on the org, which keeps the first row of each group —
    // i.e. the most recent day we have numbers for.
    platformDb.tenantUsageSnapshot.findMany({
      where: { orgId: { in: orgIds } },
      orderBy: [{ orgId: "asc" }, { onDate: "desc" }],
      distinct: ["orgId"],
      select: {
        orgId: true,
        onDate: true,
        shipments: true,
        deliveries: true,
        activeUsers: true,
        branches: true,
        portalUsers: true,
      },
    }),
    platformDb.tenantOnboardingTask.groupBy({
      by: ["orgId"],
      where: { orgId: { in: orgIds }, isBlocking: true, isDone: false },
      _count: { _all: true },
    }),
  ]);

  const usageByOrg = new Map(snapshots.map((s) => [s.orgId, s]));
  const blockingByOrg = new Map(
    openBlocking.map((row) => [row.orgId, row._count._all]),
  );

  return {
    page,
    total,
    rows: orgs.map((org) => {
      const usage = usageByOrg.get(org.id);
      return {
        ...org,
        usage: usage
          ? {
              onDate: usage.onDate,
              shipments: usage.shipments,
              deliveries: usage.deliveries,
              activeUsers: usage.activeUsers,
              branches: usage.branches,
              portalUsers: usage.portalUsers,
            }
          : null,
        blockingTasks: blockingByOrg.get(org.id) ?? 0,
      };
    }),
  };
}

/** Counts by status, for the console overview. */
export async function tenantStatusCounts(): Promise<
  Array<{ status: TenantStatus; count: number }>
> {
  const rows = await platformDb.organization.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  return rows.map((row) => ({ status: row.status, count: row._count._all }));
}

/**
 * Everything the detail page shows.
 *
 * The read-only operational summary and the editable fields come from one
 * query: they are one row, and splitting them would only invite the two
 * halves to disagree.
 */
export async function getTenant(orgId: string) {
  const [org, usage, plans] = await Promise.all([
    platformDb.organization.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        legalName: true,
        slug: true,
        subdomain: true,
        customDomain: true,
        status: true,
        planId: true,
        lrPrefix: true,
        trialEndsAt: true,
        activatedAt: true,
        suspendedAt: true,
        suspendReason: true,
        createdAt: true,
        gstin: true,
        pan: true,
        city: true,
        state: true,
        currency: true,
        timezone: true,
        primaryColorHex: true,
        accentColorHex: true,
        logoUrl: true,
        faviconUrl: true,
        documentFooter: true,
        termsText: true,
        supportEmail: true,
        supportPhone: true,
        dltSenderId: true,
        smtpFrom: true,
        whatsappNumber: true,
        // `features` comes along because the detail screen resolves what
        // this carrier actually has, and a module the plan lists is not
        // always a module the plan grants.
        plan: { select: { id: true, code: true, name: true, features: true } },
      },
    }),
    platformDb.tenantUsageSnapshot.findMany({
      where: { orgId },
      orderBy: { onDate: "desc" },
      take: 14,
    }),
    platformDb.tenantPlan.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, code: true, name: true },
    }),
  ]);

  if (!org) return null;
  return { org, usage, plans };
}

export type TenantDetail = NonNullable<Awaited<ReturnType<typeof getTenant>>>;

// ────────────────────────────────────────────────────────────
// Identity — subdomain, custom domain, plan
// ────────────────────────────────────────────────────────────

export type IdentityInput = {
  subdomain: string;
  customDomain: string | null;
  planId: string | null;
};

/**
 * Validates a subdomain against the same three rules the router applies.
 *
 * Order matters for the message rather than the outcome: "reserved" is a
 * more useful thing to be told than "already taken", and `admin` is both.
 */
async function subdomainProblem(
  value: string,
  orgId: string,
): Promise<string | null> {
  if (RESERVED_SUBDOMAINS.has(value)) {
    return `"${value}" is reserved for the platform itself and can never name a carrier.`;
  }
  if (!isValidSubdomain(value)) {
    return "A subdomain is 3–63 characters, lower-case letters, digits and hyphens, not starting or ending with a hyphen.";
  }
  const clash = await platformDb.organization.findFirst({
    where: { subdomain: value, NOT: { id: orgId } },
    select: { name: true },
  });
  return clash ? `${clash.name} is already on that subdomain.` : null;
}

async function customDomainProblem(
  value: string,
  orgId: string,
): Promise<string | null> {
  if (!value.includes(".") || value.startsWith(".") || value.endsWith(".")) {
    return "A custom domain is a full hostname, e.g. track.acmelogistics.com.";
  }
  const clash = await platformDb.organization.findFirst({
    where: { customDomain: value, NOT: { id: orgId } },
    select: { name: true },
  });
  return clash ? `${clash.name} already claims that domain.` : null;
}

/**
 * Moves a tenant's hostname or plan.
 *
 * The cache bust at the end is not optional housekeeping. `orgForHost`
 * memoises host → organisation for thirty seconds, so without it the old
 * subdomain keeps resolving — and, worse, the new one keeps resolving to
 * nothing — for up to half a minute after the change is saved.
 */
export async function updateTenantIdentity(
  orgId: string,
  input: IdentityInput,
  actor: PlatformOperator,
): Promise<PlatformResult<{ subdomain: string }>> {
  const org = await platformDb.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      slug: true,
      subdomain: true,
      customDomain: true,
      planId: true,
    },
  });
  if (!org) return fail("That tenant no longer exists.");

  const subdomain = input.subdomain.trim().toLowerCase();
  const problem = await subdomainProblem(subdomain, orgId);
  if (problem) return fail(problem);

  const customDomain = input.customDomain?.trim()
    ? normaliseHost(input.customDomain)
    : null;
  if (customDomain) {
    const domainProblem = await customDomainProblem(customDomain, orgId);
    if (domainProblem) return fail(domainProblem);
  }

  if (input.planId) {
    const plan = await platformDb.tenantPlan.findUnique({
      where: { id: input.planId },
      select: { id: true },
    });
    if (!plan) return fail("That plan no longer exists.");
  }

  const after = { subdomain, customDomain, planId: input.planId };
  const diff = changedFields(org, after);
  if (!diff) return ok({ subdomain });

  const meta = await requestMeta();

  await platformDb.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: orgId }, data: after });
    await recordPlatformAudit(
      {
        action: "tenant.identity.update",
        actor,
        org,
        entity: "Organization",
        entityId: orgId,
        before: diff.before,
        after: diff.after,
        ...meta,
      },
      tx,
    );
  });

  // Cleared wholesale rather than by key: the cache is keyed on the raw
  // Host header, port included, so a hostname reconstructed here would
  // miss the entry it was meant to evict. The map holds a handful of
  // entries and refilling it is one query each.
  bustTenantCache();
  // The notification layer keeps its own thirty-second copy of each
  // carrier — brand name, sender header, and the origin public links are
  // built on. A moved subdomain changes that origin, so a tracking link in
  // an SMS sent in the next half minute would point at a host that no
  // longer resolves.
  resetCarrierCache();

  return ok({ subdomain });
}

// ────────────────────────────────────────────────────────────
// White-label
// ────────────────────────────────────────────────────────────

export type BrandingInput = {
  primaryColorHex: string | null;
  accentColorHex: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  documentFooter: string | null;
  termsText: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  dltSenderId: string | null;
  smtpFrom: string | null;
  whatsappNumber: string | null;
};

export async function updateTenantBranding(
  orgId: string,
  input: BrandingInput,
  actor: PlatformOperator,
): Promise<PlatformResult<null>> {
  const org = await platformDb.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      slug: true,
      primaryColorHex: true,
      accentColorHex: true,
      logoUrl: true,
      faviconUrl: true,
      documentFooter: true,
      termsText: true,
      supportEmail: true,
      supportPhone: true,
      dltSenderId: true,
      smtpFrom: true,
      whatsappNumber: true,
    },
  });
  if (!org) return fail("That tenant no longer exists.");

  // A colour that will not parse is not a cosmetic problem: the palette is
  // injected as CSS custom properties, so an unparseable value silently
  // drops the token and the carrier's app renders in someone else's teal.
  for (const [label, value] of [
    ["Primary colour", input.primaryColorHex],
    ["Accent colour", input.accentColorHex],
  ] as const) {
    if (value && !parseHex(value)) {
      return fail(`${label} must be a hex value like #1F6F8B.`);
    }
  }

  const diff = changedFields(org, input);
  if (!diff) return ok(null);

  const meta = await requestMeta();

  await platformDb.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: orgId }, data: input });
    await recordPlatformAudit(
      {
        action: "tenant.branding.update",
        actor,
        org,
        entity: "Organization",
        entityId: orgId,
        before: diff.before,
        after: diff.after,
        ...meta,
      },
      tx,
    );
  });

  // Five of the fields edited here — support phone and email, the DLT
  // sender header, the SMTP From address and the WhatsApp number — are
  // exactly what `carrierIdentity()` memoises for the outbox drain. Without this, an
  // operator whose DLT registration came through this morning watches
  // messages keep going out under the old header, and concludes the change
  // did not save.
  resetCarrierCache();

  return ok(null);
}

// ────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────

/**
 * What each transition means, in one place, because the words matter more
 * than the code:
 *
 * - **ACTIVE** — normal service.
 * - **SUSPENDED** — still reachable, but every write is refused by the
 *   tenant extension. An operations team can still read their own
 *   consignment history while a payment dispute is settled. A suspension
 *   is not a lockout and must not become one.
 * - **CLOSED** — sign-in refused entirely; `tenantContextFor` returns null
 *   and the host stops resolving. Data is retained.
 */
export type LifecycleAction = "activate" | "suspend" | "close";

const LIFECYCLE: Record<
  LifecycleAction,
  { to: TenantStatus; needsReason: boolean; verb: string }
> = {
  activate: { to: "ACTIVE", needsReason: false, verb: "tenant.activate" },
  suspend: { to: "SUSPENDED", needsReason: true, verb: "tenant.suspend" },
  close: { to: "CLOSED", needsReason: true, verb: "tenant.close" },
};

export async function changeTenantStatus(
  orgId: string,
  action: LifecycleAction,
  reason: string | null,
  actor: PlatformOperator,
): Promise<PlatformResult<{ status: TenantStatus }>> {
  const rule = LIFECYCLE[action];
  const trimmed = reason?.trim() ?? "";

  // The reason is required by the product, not by the column. Suspending a
  // company without recording why is the single entry in this log most
  // likely to be read a year later, in an argument.
  if (rule.needsReason && trimmed.length < 8) {
    return fail("Give a reason — at least a sentence. It is recorded against the tenant.");
  }

  const org = await platformDb.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      activatedAt: true,
      suspendedAt: true,
      suspendReason: true,
    },
  });
  if (!org) return fail("That tenant no longer exists.");
  if (org.status === rule.to) {
    return fail(`${org.name} is already ${rule.to.toLowerCase()}.`);
  }

  const now = new Date();
  const data: Prisma.OrganizationUpdateInput = { status: rule.to };

  if (action === "activate") {
    // First activation stamps the date; a re-activation after suspension
    // keeps the original, which is what "customer since" means.
    if (!org.activatedAt) data.activatedAt = now;
    data.suspendedAt = null;
    data.suspendReason = null;
    data.isActive = true;
  } else if (action === "suspend") {
    data.suspendedAt = now;
    data.suspendReason = trimmed;
  } else {
    data.isActive = false;
    data.suspendReason = trimmed;
  }

  const meta = await requestMeta();

  await platformDb.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: orgId }, data });

    // Closing a tenant ends any support session inside it in the same
    // breath. A grant that outlives the tenant's own sign-in would be the
    // one way back into a company that has been switched off.
    if (action === "close") {
      await tx.impersonationGrant.updateMany({
        where: { orgId, endedAt: null },
        data: { endedAt: now, endedBy: actor.id },
      });
    }

    await recordPlatformAudit(
      {
        action: rule.verb,
        actor,
        org,
        entity: "Organization",
        entityId: orgId,
        before: { status: org.status, suspendReason: org.suspendReason },
        after: { status: rule.to, suspendReason: data.suspendReason ?? null },
        reason: trimmed || undefined,
        ...meta,
      },
      tx,
    );
  });

  // Status is part of the cached resolution, and a suspension has to bite
  // in seconds rather than at the end of the 30-second window.
  bustTenantCache();

  return ok({ status: rule.to });
}
