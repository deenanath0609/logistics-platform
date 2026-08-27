import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import type { AuditAction } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";

export type AuditInput = {
  user: SessionUser | null;
  action: AuditAction;
  /** Model name, e.g. "Branch". */
  entity: string;
  entityId: string;
  /** Human-readable identifier for search, e.g. "HUB-DEL". */
  entityRef?: string;
  branchId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Required for OVERRIDE and STATUS_CHANGE. */
  reason?: string;
};

/** Fields never written to the audit trail in plaintext. */
const REDACTED = new Set([
  "passwordHash",
  "codeHash",
  "keyHash",
  "password",
  "secret",
  "token",
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
 * Writes one audit row.
 *
 * Auditing must never be the reason a valid operation fails, so a failure
 * here is logged and swallowed. The database grants no UPDATE or DELETE on
 * this table — corrections are new rows.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const headerList = await headers();

    await prisma.auditLog.create({
      data: {
        orgId: input.user?.orgId,
        userId: input.user?.id,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        entityRef: input.entityRef,
        branchId: input.branchId ?? input.user?.primaryBranch?.id,
        before: (sanitise(input.before) ?? undefined) as never,
        after: (sanitise(input.after) ?? undefined) as never,
        reason: input.reason,
        ipAddress:
          headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          headerList.get("x-real-ip") ??
          undefined,
        userAgent: headerList.get("user-agent") ?? undefined,
      },
    });
  } catch (error) {
    console.error("[audit] failed to record", {
      entity: input.entity,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : error,
    });
  }
}

/** Shallow diff, so an update audit shows only what actually changed. */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T> } {
  const changedBefore: Partial<T> = {};
  const changedAfter: Partial<T> = {};

  for (const key of Object.keys(after) as Array<keyof T>) {
    const nextValue = after[key];
    if (nextValue === undefined) continue;
    if (String(before[key]) === String(nextValue)) continue;
    changedBefore[key] = before[key];
    changedAfter[key] = nextValue;
  }

  return { before: changedBefore, after: changedAfter };
}
