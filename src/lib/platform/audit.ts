import { platformDb } from "@/lib/platform/db";
import type { Prisma } from "@/generated/prisma/client";

/**
 * The operator's audit trail.
 *
 * Separate from `AuditLog` on purpose, and the separation is the feature.
 * `AuditLog` belongs to a tenant and a tenant may read it; suspending a
 * company, opening a support session, moving a subdomain are not a
 * tenant's business to browse, and the row has to survive the tenant it
 * describes. Hence `targetOrgId` as a plain column rather than a relation,
 * and hence a table nothing tenant-facing ever queries.
 *
 * Nothing merges the two. A tenant-visible echo of an operator action, if
 * one is ever wanted, is a deliberate second write with a deliberate
 * decision about what it may say — not a join.
 */

/** A Prisma client or an open transaction. */
type Db = typeof platformDb | Prisma.TransactionClient;

export type PlatformAuditActor = {
  id: string;
  name: string;
} | null;

export type PlatformAuditInput = {
  /** Dotted verb, e.g. "tenant.suspend". Kept stable — reports filter on it. */
  action: string;
  actor: PlatformAuditActor;
  /**
   * The tenant acted on. The slug is copied, not joined: this row must
   * still name the company after the company row is gone.
   */
  org?: { id: string; slug: string } | null;
  /** Model name, e.g. "Organization". */
  entity?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  /** Required by the caller for anything destructive. Not enforced here. */
  reason?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** Never written to the trail in plaintext. */
const REDACTED = new Set([
  "passwordHash",
  "password",
  "secret",
  "token",
  "keyHash",
]);

function sanitise(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitise);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, val]) => [
      key,
      REDACTED.has(key) ? "«redacted»" : sanitise(val),
    ]),
  );
}

/**
 * Writes one operator audit row.
 *
 * Unlike `recordAudit`, this does **not** swallow failures when it is
 * handed a transaction: the caller passes the open transaction so the row
 * and the change it describes commit together, and a suspension that
 * happened with no trail is worse than a suspension that failed. Calls
 * outside a transaction — sign-in, sign-out — pass no client and are
 * best-effort, because refusing a login because the log is down helps
 * nobody.
 */
export async function recordPlatformAudit(
  input: PlatformAuditInput,
  db?: Db,
): Promise<void> {
  const data = {
    platformAdminId: input.actor?.id ?? null,
    action: input.action,
    targetOrgId: input.org?.id ?? null,
    targetOrgSlug: input.org?.slug ?? null,
    entity: input.entity ?? null,
    entityId: input.entityId ?? null,
    before: (sanitise(input.before) ?? undefined) as never,
    after: (sanitise(input.after) ?? undefined) as never,
    reason: input.reason ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  };

  if (db) {
    await db.platformAuditLog.create({ data });
    return;
  }

  try {
    await platformDb.platformAuditLog.create({ data });
  } catch (error) {
    console.error("[platform-audit] failed to record", {
      action: input.action,
      error: error instanceof Error ? error.message : error,
    });
  }
}

/**
 * The before/after pair for an edit, reduced to the fields that actually
 * moved.
 *
 * A whole-row snapshot on both sides makes every entry look like a rewrite
 * and buries the one field someone changed. Returning null when nothing
 * moved lets a caller skip the write entirely.
 */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T> } | null {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const [key, next] of Object.entries(after)) {
    const previous = before[key as keyof T];
    // Dates and Decimals do not compare with `!==`, so compare their
    // rendered form. Everything on these models is a scalar.
    const same =
      previous instanceof Date && next instanceof Date
        ? previous.getTime() === next.getTime()
        : String(previous ?? "") === String(next ?? "");
    if (same) continue;
    changedBefore[key] = previous ?? null;
    changedAfter[key] = next ?? null;
  }

  if (Object.keys(changedAfter).length === 0) return null;
  return {
    before: changedBefore as Partial<T>,
    after: changedAfter as Partial<T>,
  };
}

/**
 * Where the action came from. Read from the request rather than passed in,
 * so no call site can forget it or lie about it.
 */
export async function requestMeta(): Promise<{
  ipAddress: string | null;
  userAgent: string | null;
}> {
  try {
    const { headers } = await import("next/headers");
    const { getEnv } = await import("@/lib/env");
    const { clientIpFrom } = await import("@/lib/net/client-ip");
    const list = await headers();

    // Only a vouched-for address is recorded. This used to take the
    // leftmost `X-Forwarded-For` entry, which is the one value in the whole
    // chain the caller writes — so the actor of an audited action could
    // choose the address the trail would remember them by, which is worse
    // than remembering none.
    const ip = clientIpFrom(list, getEnv().TRUSTED_PROXY_HOPS);

    return {
      ipAddress: ip.trusted ? ip.value : null,
      userAgent: list.get("user-agent") ?? null,
    };
  } catch {
    // Scripts and workers have no request. Losing the address is fine;
    // losing the row is not.
    return { ipAddress: null, userAgent: null };
  }
}
