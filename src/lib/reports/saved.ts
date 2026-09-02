import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { filtersToParams } from "./filters";
import { reportFor } from "./registry";
import type { ReportFilters } from "./types";

/**
 * Saved reports.
 *
 * A filter set someone wants back tomorrow. The report itself is code;
 * this stores only the shape — which is why a saved report keeps working
 * when a column is added, and why it cannot be used to smuggle a query
 * past the branch scope: the filters are re-applied through the same
 * scoping the live screen uses, every time it is opened.
 */

export type SavedReportSummary = {
  id: string;
  reportKey: string;
  reportTitle: string;
  name: string;
  query: string;
  isShared: boolean;
  isMine: boolean;
  ownerName: string | null;
  lastRunAt: Date | null;
  createdAt: Date;
};

/**
 * What this user can open: their own, plus anything shared.
 *
 * Shared is org-wide rather than role-scoped on purpose — the permission
 * on the report is what decides whether they can run it, and duplicating
 * that decision here would let the two drift apart.
 */
export async function listSavedReports(
  user: SessionUser,
  reportKey?: string,
): Promise<SavedReportSummary[]> {
  const rows = await listRows(user, reportKey);

  /**
   * Only views this reader could actually open.
   *
   * Shared is org-wide, which used to mean a Branch Manager saw a
   * colleague's "Vendor payable — March" on their own index: its title,
   * its filters, and a link that answered 403. The permission on the
   * report decides, exactly as it does everywhere else — and a report key
   * that has since been removed from the library drops out rather than
   * rendering as its own raw key.
   */
  const visible = rows.filter((row) => {
    const report = reportFor(row.reportKey);
    return report ? user.permissions.has(report.permission) : false;
  });

  const ownerIds = [
    ...new Set(visible.map((row) => row.ownerId).filter((id): id is string => Boolean(id))),
  ];
  const owners = ownerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(owners.map((owner) => [owner.id, owner.name]));

  return visible.map((row) => ({
    id: row.id,
    reportKey: row.reportKey,
    reportTitle: reportFor(row.reportKey)?.title ?? row.reportKey,
    name: row.name,
    query: toQueryString(row.filters),
    isShared: row.isShared,
    isMine: row.ownerId === user.id,
    ownerName: row.ownerId ? (nameById.get(row.ownerId) ?? null) : null,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
  }));
}

async function listRows(user: SessionUser, reportKey?: string) {
  return prisma.savedReport.findMany({
    where: {
      orgId: user.orgId,
      ...(reportKey ? { reportKey } : {}),
      OR: [{ ownerId: user.id }, { isShared: true }],
    },
    orderBy: [{ reportKey: "asc" }, { name: "asc" }],
    take: 200,
    select: {
      id: true,
      reportKey: true,
      name: true,
      filters: true,
      isShared: true,
      ownerId: true,
      lastRunAt: true,
      createdAt: true,
    },
  });
}

/** `SavedReport.filters` is JSON; only string values survive the trip. */
function toQueryString(filters: unknown): string {
  if (!filters || typeof filters !== "object") return "";

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters as Record<string, unknown>)) {
    if (typeof value === "string" && value) params.set(key, value);
  }
  return params.toString();
}

export type SaveResult =
  | { ok: true; id: string; message: string }
  | { ok: false; error: string };

export async function createSavedReport(
  input: {
    reportKey: string;
    name: string;
    filters: ReportFilters;
    isShared: boolean;
  },
  user: SessionUser,
): Promise<SaveResult> {
  const report = reportFor(input.reportKey);
  if (!report) return { ok: false, error: "No such report." };

  // The permission on the report is the gate. Saving a filter set for a
  // report you cannot run would create a link that fails on open — worse
  // than refusing here, because it fails for whoever you shared it with.
  if (!user.permissions.has(report.permission)) {
    return { ok: false, error: "You cannot run that report." };
  }

  const name = input.name.trim();
  if (name.length < 2) return { ok: false, error: "Give it a name." };
  if (name.length > 80) return { ok: false, error: "That name is too long." };

  const saved = await prisma.savedReport.create({
    data: {
      orgId: user.orgId,
      reportKey: input.reportKey,
      name,
      filters: filtersToParams(input.filters),
      ownerId: user.id,
      isShared: input.isShared,
    },
    select: { id: true },
  });

  return {
    ok: true,
    id: saved.id,
    message: input.isShared
      ? `Saved and shared with the team as "${name}".`
      : `Saved as "${name}".`,
  };
}

export async function deleteSavedReport(
  id: string,
  user: SessionUser,
): Promise<SaveResult> {
  const saved = await prisma.savedReport.findUnique({
    where: { id },
    select: { id: true, ownerId: true, name: true, orgId: true },
  });

  if (!saved || saved.orgId !== user.orgId) {
    return { ok: false, error: "That saved report is gone." };
  }

  // A shared report belongs to whoever made it. Letting anyone delete it
  // means one person's tidy-up removes everybody else's shortcut.
  const mayDelete =
    saved.ownerId === user.id || user.permissions.has("settings.manage");

  if (!mayDelete) {
    return { ok: false, error: "Only the person who saved it can remove it." };
  }

  await prisma.savedReport.delete({ where: { id } });
  return { ok: true, id, message: `Removed "${saved.name}".` };
}

/**
 * Stamped when a saved report is opened, so stale ones are visible.
 *
 * Nothing called this. The index renders "Last opened …" from `lastRunAt`
 * and no code path ever wrote the column, so every saved view in the
 * product read "Never opened" for ever — including one somebody had opened
 * that morning. The report page now calls it with the `saved` id its own
 * link carries.
 *
 * Scoped by organisation, because the id arrives in a query string: an
 * unscoped `update` by id would let a pasted URL stamp another carrier's
 * row, which is a small thing to write and a bad thing to be able to write.
 */
export async function touchSavedReport(
  id: string,
  user: SessionUser,
): Promise<void> {
  try {
    await prisma.savedReport.updateMany({
      where: { id, orgId: user.orgId },
      data: { lastRunAt: new Date() },
    });
  } catch (error) {
    // Opening a saved report that has since been deleted is not an error
    // worth showing anyone — the report still runs. Logged rather than
    // swallowed: a silent catch here is how a broken write stays broken.
    console.error("[reports] could not stamp a saved view as opened", error);
  }
}
