import { prisma } from "@/lib/prisma";
import type { AuditAction, Prisma } from "@/generated/prisma/client";

/**
 * Audit for events with no actor and no request.
 *
 * `recordAudit` in `@/server/services/audit` is the right helper for
 * anything a person did: it reaches for `headers()` to capture the IP and
 * user agent, which is exactly what you want from a server action. The GPS
 * pipeline has neither — it runs on a timer, outside any request — and
 * calling it there logs a failure on every arrival instead of writing a row.
 *
 * So system-generated changes get their own path to the same immutable
 * table, with `userId` null and the provider named in the payload. That
 * null is not a gap in the trail; it is the fact being recorded. A report
 * asking "which arrivals were automatic?" reads it directly, which is the
 * requirement in docs/BRD.html §A.9 — a mixed fleet needs to distinguish a
 * geofence arrival from a supervisor's manual entry, and both must be there.
 */
export async function recordSystemAudit(input: {
  action: AuditAction;
  entity: string;
  entityId: string;
  entityRef?: string | null;
  orgId?: string | null;
  branchId?: string | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  reason?: string;
  deviceId?: string | null;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        orgId: input.orgId ?? undefined,
        userId: undefined,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        entityRef: input.entityRef ?? undefined,
        branchId: input.branchId ?? undefined,
        before: input.before,
        after: input.after,
        reason: input.reason,
        deviceId: input.deviceId ?? undefined,
      },
    });
  } catch (error) {
    // Auditing must never be the reason a valid arrival fails to record.
    console.error("[tracking/audit] failed to record", {
      entity: input.entity,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : error,
    });
  }
}
