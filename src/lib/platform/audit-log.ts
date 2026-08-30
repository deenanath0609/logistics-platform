import { platformDb } from "@/lib/platform/db";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Reading the operator trail.
 *
 * Filterable by tenant and by operator, which are the two questions
 * actually asked of it: "what has been done to this carrier?" and "what
 * has this person done?". Nothing tenant-facing may reach this module —
 * see the note on `PlatformAuditLog` in the schema.
 */

export const AUDIT_PAGE_SIZE = 50;

export type AuditFilters = {
  orgId?: string;
  adminId?: string;
  action?: string;
  page?: number;
};

export async function listPlatformAudit(filters: AuditFilters) {
  const page = Math.max(1, filters.page ?? 1);

  const where: Prisma.PlatformAuditLogWhereInput = {
    ...(filters.orgId ? { targetOrgId: filters.orgId } : {}),
    ...(filters.adminId ? { platformAdminId: filters.adminId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
  };

  const [rows, total] = await Promise.all([
    platformDb.platformAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * AUDIT_PAGE_SIZE,
      take: AUDIT_PAGE_SIZE,
      include: { platformAdmin: { select: { name: true, email: true } } },
    }),
    platformDb.platformAuditLog.count({ where }),
  ]);

  return { rows, total, page };
}

/** The values the filter selects offer, drawn from what is actually there. */
export async function auditFilterOptions() {
  const [orgs, admins, actions] = await Promise.all([
    platformDb.organization.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    platformDb.platformAdmin.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    platformDb.platformAuditLog.findMany({
      distinct: ["action"],
      orderBy: { action: "asc" },
      select: { action: true },
    }),
  ]);

  return { orgs, admins, actions: actions.map((a) => a.action) };
}

/** Recent activity for the overview, and for one tenant's detail page. */
export async function recentAudit(orgId?: string, take = 12) {
  return platformDb.platformAuditLog.findMany({
    where: orgId ? { targetOrgId: orgId } : {},
    orderBy: { createdAt: "desc" },
    take,
    include: { platformAdmin: { select: { name: true } } },
  });
}
