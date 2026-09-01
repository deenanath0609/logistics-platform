import type { Metadata } from "next";
import { format } from "date-fns";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { AuditFilters } from "./filters";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Audit trail" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

const ACTION_TONE: Record<string, string> = {
  CREATE: "bg-ok-muted text-ok",
  UPDATE: "bg-info-muted text-info",
  DELETE: "bg-bad-muted text-bad",
  STATUS_CHANGE: "bg-accent text-accent-foreground",
  LOGIN: "bg-muted text-muted-foreground",
  LOGOUT: "bg-muted text-muted-foreground",
  PERMISSION_CHANGE: "bg-warn-muted text-warn",
  EXPORT: "bg-warn-muted text-warn",
  OVERRIDE: "bg-bad-muted text-bad",
  APPROVE: "bg-ok-muted text-ok",
  CANCEL: "bg-bad-muted text-bad",
};

function summarise(before: unknown, after: unknown): string {
  const changed = after && typeof after === "object" ? Object.keys(after) : [];
  if (changed.length === 0) return "—";
  const shown = changed.slice(0, 4).join(", ");
  return changed.length > 4 ? `${shown} +${changed.length - 4} more` : shown;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    entity?: string;
    action?: string;
    page?: string;
  }>;
}) {
  const user = await requirePermission("audit.read");
  const { q, entity, action, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const where = {
    // `audit.read` is not a sensitive permission, so it falls into the
    // "every read" bundle that Branch Manager holds — and this page had no
    // branch filter at all. A branch manager could therefore read the whole
    // carrier's trail: role grants, user creations, rate overrides and
    // cancellations at every other branch, with the before/after values on
    // each row. Every other listing in the product scopes; this one did not.
    //
    // `recordAudit` stamps `branchId` from the actor's home branch when the
    // caller does not name one, so a scoped reader sees the rows their own
    // branches caused. Rows with no branch at all are network-level acts and
    // stay with the network-scoped roles — which is what `branchScope`'s
    // `{ in: [...] }` already says, since it does not match null.
    ...branchScope(user, "branchId"),
    ...(entity ? { entity } : {}),
    ...(action ? { action: action as never } : {}),
    ...(q
      ? {
          OR: [
            { entityRef: { contains: q, mode: "insensitive" as const } },
            { entityId: { contains: q } },
            { user: { name: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const [rows, total, entities] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { user: { select: { name: true, mobile: true } } },
    }),
    prisma.auditLog.count({ where }),
    // Scoped too: the filter list is derived from the rows, so an unscoped
    // one would name entities this reader is not allowed to see and offer a
    // filter that returns nothing.
    prisma.auditLog.findMany({
      where: branchScope(user, "branchId"),
      distinct: ["entity"],
      select: { entity: true },
      orderBy: { entity: "asc" },
    }),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Audit trail"
        description="Every change, with who made it and what it replaced. The table grants no UPDATE or DELETE — a correction is a new row, never an edit to an old one."
        actions={<SearchInput placeholder="Search reference, id, user" />}
      />

      <AuditFilters
        entities={entities.map((e) => e.entity)}
        selectedEntity={entity}
        selectedAction={action}
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing recorded yet"
            description="Changes made through the app appear here immediately."
          />
        ) : (
          <Table className="min-w-[940px]">
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Changed</TableHead>
                <TableHead>By</TableHead>
                <TableHead>From</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground tabular">
                    {format(row.createdAt, "dd MMM HH:mm:ss")}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${
                        ACTION_TONE[row.action] ?? "bg-muted text-muted-foreground"
                      }`}
                    >
                      {row.action.replace(/_/g, " ")}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs font-medium">{row.entity}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.entityRef ?? (
                      <span className="text-muted-foreground">
                        {row.entityId.slice(0, 8)}…
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                    {row.reason ? (
                      <span className="text-warn">{row.reason}</span>
                    ) : (
                      summarise(row.before, row.after)
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.user?.name ?? (
                      <span className="text-muted-foreground">System</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.ipAddress ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        baseParams={{ q, entity, action }}
        pathname="/admin/audit"
      />
    </>
  );
}
