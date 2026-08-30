import type { Metadata } from "next";
import { format } from "date-fns";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, Pagination, TableFrame } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  auditFilterOptions,
  AUDIT_PAGE_SIZE,
  listPlatformAudit,
} from "@/lib/platform/audit-log";
import { requireCapability } from "@/lib/platform/session";
import { PlatformAuditFilters } from "./filters";

export const metadata: Metadata = { title: "Operator log" };
export const dynamic = "force-dynamic";

/** Which side of the platform an action touched, for colour only. */
function tone(action: string): string {
  if (action.startsWith("impersonation")) return "bg-warn-muted text-warn";
  if (action === "tenant.close" || action === "tenant.suspend") {
    return "bg-bad-muted text-bad";
  }
  if (action.startsWith("operator.signin")) return "bg-muted text-muted-foreground";
  if (action.startsWith("plan")) return "bg-info-muted text-info";
  return "bg-accent text-accent-foreground";
}

/** The field names that moved, rather than a wall of JSON. */
function summarise(after: unknown): string {
  if (!after || typeof after !== "object") return "—";
  const keys = Object.keys(after as Record<string, unknown>);
  if (keys.length === 0) return "—";
  const shown = keys.slice(0, 4).join(", ");
  return keys.length > 4 ? `${shown} +${keys.length - 4} more` : shown;
}

/**
 * Every operator action, in one place.
 *
 * This is a different table from the tenant-readable `AuditLog` and stays
 * that way: suspending a company and opening a support session are not a
 * tenant's business to browse, and these rows must survive the tenant they
 * describe — which is why the carrier is stored as a copied slug rather
 * than joined through a foreign key.
 */
export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    org?: string;
    admin?: string;
    action?: string;
    page?: string;
  }>;
}) {
  await requireCapability("audit.read");

  const params = await searchParams;
  const [{ rows, total, page }, options] = await Promise.all([
    listPlatformAudit({
      orgId: params.org,
      adminId: params.admin,
      action: params.action,
      page: Number(params.page ?? 1) || 1,
    }),
    auditFilterOptions(),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Operator log"
        description="Append-only. A correction is a new row, never an edit to an old one — and no tenant can read this table."
      />

      <PlatformAuditFilters
        orgs={options.orgs}
        admins={options.admins}
        actions={options.actions}
        selectedOrg={params.org}
        selectedAdmin={params.admin}
        selectedAction={params.action}
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing recorded"
            description="Operator actions appear here the moment they commit — the audit row is written in the same transaction as the change it describes."
          />
        ) : (
          <Table className="min-w-[1040px]">
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Operator</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Changed</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>From</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    {format(row.createdAt, "d MMM HH:mm:ss")}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`rounded-4xl px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.1em] ${tone(row.action)}`}
                    >
                      {row.action}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.platformAdmin?.name ?? (
                      <span className="text-muted-foreground">out of band</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.targetOrgSlug ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.entity ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {summarise(row.after)}
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate text-xs">
                    {row.reason ?? "—"}
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
        pageSize={AUDIT_PAGE_SIZE}
        total={total}
        pathname="/platform/audit"
        baseParams={{
          org: params.org,
          admin: params.admin,
          action: params.action,
        }}
      />
    </>
  );
}
