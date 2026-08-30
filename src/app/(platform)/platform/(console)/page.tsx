import type { Metadata } from "next";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { PageHeader } from "@/components/shell/page-header";
import { TenantStatusBadge, STATUS_ORDER } from "@/components/platform/status-badge";
import { recentAudit } from "@/lib/platform/audit-log";
import { listActiveGrants } from "@/lib/platform/impersonation";
import { tenantStatusCounts } from "@/lib/platform/tenants";
import { requireCapability, operatorCan } from "@/lib/platform/session";

export const metadata: Metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

/**
 * What an operator wants to know on opening the console: how many carriers
 * there are and in what state, whether anybody is currently inside one,
 * and what has been done lately.
 */
export default async function ConsoleOverviewPage() {
  const operator = await requireCapability("tenant.read");

  const counts = await tenantStatusCounts();
  const byStatus = new Map(counts.map((row) => [row.status, row.count]));
  const total = counts.reduce((sum, row) => sum + row.count, 0);

  const grants = operatorCan(operator, "impersonate")
    ? await listActiveGrants()
    : [];
  const recent = operatorCan(operator, "audit.read") ? await recentAudit() : [];

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title={`${total} tenant${total === 1 ? "" : "s"}`}
        description="Carriers on the platform, and what the operator team has been doing to them."
      />

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {STATUS_ORDER.map((status) => (
          <Link
            key={status}
            href={`/platform/tenants?status=${status}`}
            className="flex flex-col gap-2 rounded-lg border bg-card p-4 transition-colors hover:border-primary/40"
          >
            <TenantStatusBadge status={status} className="self-start" />
            <span className="text-2xl font-semibold tabular">
              {byStatus.get(status) ?? 0}
            </span>
          </Link>
        ))}
      </div>

      {operatorCan(operator, "impersonate") && (
        <section className="mt-8 flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-semibold tracking-tight">
              Support sessions open now
            </h2>
            <Link
              href="/platform/impersonation"
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              All sessions
            </Link>
          </div>

          {grants.length === 0 ? (
            <p className="rounded-lg border border-dashed bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              Nobody is inside a customer&rsquo;s data right now.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {grants.map((grant) => (
                <li
                  key={grant.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn-muted px-4 py-3 text-sm"
                >
                  <span>
                    <strong>{grant.platformAdmin.name}</strong> in{" "}
                    {grant.org?.name ?? grant.orgId} —{" "}
                    {grant.allowWrites ? "read and write" : "read-only"}
                  </span>
                  <span className="font-mono text-xs">
                    expires {formatDistanceToNow(grant.expiresAt, { addSuffix: true })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {operatorCan(operator, "audit.read") && (
        <section className="mt-8 flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-semibold tracking-tight">
              Recent operator actions
            </h2>
            <Link
              href="/platform/audit"
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Full log
            </Link>
          </div>

          {recent.length === 0 ? (
            <p className="rounded-lg border border-dashed bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              Nothing recorded yet.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border bg-card">
              {recent.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm"
                >
                  <span className="font-mono text-xs">{row.action}</span>
                  <span className="text-muted-foreground">
                    {row.targetOrgSlug ?? "—"} ·{" "}
                    {row.platformAdmin?.name ?? "out of band"} ·{" "}
                    {formatDistanceToNow(row.createdAt, { addSuffix: true })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
