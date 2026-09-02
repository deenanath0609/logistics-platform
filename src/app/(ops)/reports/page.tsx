import type { Metadata } from "next";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { requireUser, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { ReportIcon } from "@/components/reports/icon";
import { SavedReportList } from "@/components/reports/saved-list";
import { listSavedReports } from "@/lib/reports/saved";
import { REPORT_GROUPS, visibleReports } from "@/lib/reports/registry";
import { GROUP_DESCRIPTION, GROUP_LABEL } from "@/lib/reports/types";
import { scopeNote } from "@/lib/reports/scope";
import { deleteSavedReportAction } from "./actions";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

/**
 * The report library — docs/BRD.html §A.17.
 *
 * Grouped exactly as the BRD groups them, and filtered by permission: a
 * report somebody cannot run is not listed at all rather than listed and
 * then refused. Every card says what the report is for in one sentence,
 * because "Dispatch & manifest" tells a new branch manager nothing about
 * whether it is the one they want.
 */
export default async function ReportsIndexPage() {
  const user = await requireUser();

  // From the registry's own helper rather than a second copy of the same
  // filter, so the index and anything else that asks "what may they run?"
  // cannot drift apart.
  const visible = visibleReports(user.permissions);

  if (visible.length === 0) {
    return (
      <>
        <PageHeader
          eyebrow="Reports"
          title="Report library"
          description="Nothing here yet."
        />
        <p className="rounded-lg border border-dashed bg-muted/40 px-4 py-3.5 text-sm text-muted-foreground">
          Running reports needs one of the reporting permissions. Ask an
          administrator for operational, financial or management reporting.
        </p>
      </>
    );
  }

  const saved = await listSavedReports(user);
  const note = scopeNote(user);

  return (
    <>
      <PageHeader
        eyebrow="Reports"
        title="Report library"
        description={
          note ??
          "Every report filters by date range, branch, customer, lane, service and mode, and exports to CSV and XLSX."
        }
      />

      {can(user, "report.management") && (
        <Link
          href="/insights"
          className="mb-6 flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3.5 transition-colors hover:border-primary/40 hover:bg-accent/40"
        >
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.13em] text-primary">
              Management dashboard
            </span>
            <span className="text-sm">
              The KPI set with trend, cut by lane, branch, customer and service.
            </span>
          </div>
          <ReportIcon name="Gauge" className="size-5 text-muted-foreground" />
        </Link>
      )}

      <section className="mb-8 flex flex-col gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Saved views
        </h2>
        <SavedReportList
          rows={saved.map((row) => ({
            id: row.id,
            reportKey: row.reportKey,
            reportTitle: row.reportTitle,
            name: row.name,
            query: row.query,
            isShared: row.isShared,
            isMine: row.isMine,
            ownerName: row.ownerName,
            lastRunAt: row.lastRunAt
              ? formatDistanceToNow(row.lastRunAt, { addSuffix: true })
              : null,
            // Mirrors `deleteSavedReport`'s own rule, rather than the
            // narrower "mine only" the list used to draw.
            canRemove: row.isMine || can(user, "settings.manage"),
          }))}
          deleteAction={deleteSavedReportAction}
        />
      </section>

      {REPORT_GROUPS.map((group) => {
        const reports = visible.filter((report) => report.group === group);
        if (reports.length === 0) return null;

        return (
          <section key={group} className="mb-8 flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
                {GROUP_LABEL[group]}
              </h2>
              <p className="max-w-prose text-sm text-muted-foreground">
                {GROUP_DESCRIPTION[group]}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {reports.map((report) => (
                <Link
                  key={report.key}
                  href={`/reports/${report.key}`}
                  className="group flex flex-col gap-2 rounded-lg border bg-card p-3.5 transition-colors hover:border-primary/40 hover:bg-accent/40"
                >
                  <span className="flex items-center gap-2">
                    <ReportIcon
                      name={report.icon}
                      className="text-muted-foreground transition-colors group-hover:text-primary"
                    />
                    <span className="text-sm font-medium">{report.title}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {report.description}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
