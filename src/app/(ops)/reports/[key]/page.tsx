import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { Pagination } from "@/components/data/data-shell";
import { Button } from "@/components/ui/button";
import { ReportFilterBar } from "@/components/reports/filter-bar";
import { ReportActions } from "@/components/reports/actions-bar";
import { ReportTable } from "@/components/reports/report-table";
import { describeFilters, filtersToParams, parseFilters } from "@/lib/reports/filters";
import { reportFor } from "@/lib/reports/registry";
import { scopeNote } from "@/lib/reports/scope";
import { MAX_CSV_ROWS, MAX_XLSX_ROWS } from "@/lib/reports/export";
import { PAGE_SIZE } from "@/lib/reports/types";
import { saveReportViewAction } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const { key } = await params;
  return { title: reportFor(key)?.title ?? "Report" };
}

/**
 * One report, run.
 *
 * The page is a shell: it resolves the definition, parses the filters,
 * calls the runner for one page, and renders. Everything specific to the
 * report lives in the runner, which is what keeps nineteen reports from
 * becoming nineteen slightly different screens.
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { key } = await params;
  const report = reportFor(key);
  if (!report) notFound();

  const user = await requireUser();
  // Guarded here rather than only in the index: a pasted URL must hit the
  // same wall as a click.
  if (!user.permissions.has(report.permission)) redirect("/forbidden");

  const raw = await searchParams;
  const filters = parseFilters(raw);
  const page = Math.max(1, Number(raw.page ?? 1) || 1);

  const [result, options, names] = await Promise.all([
    report.run({ user, filters, page, pageSize: PAGE_SIZE }),
    loadFilterOptions(user.orgId, user.branchIds),
    loadFilterNames(filters),
  ]);

  const query = filtersToParams(filters);
  const note = scopeNote(user);
  const canExport = user.permissions.has("report.export");

  return (
    <>
      <PageHeader
        eyebrow="Report"
        title={report.title}
        description={report.description}
        actions={
          <Button variant="outline" size="sm" render={<Link href="/reports" />}>
            <ArrowLeft />
            Library
          </Button>
        }
      />

      <p className="mb-4 font-mono text-[0.65rem] uppercase tracking-[0.13em] text-muted-foreground">
        {describeFilters(filters, names)}
        {note && <span className="ml-2 text-warn">{note}</span>}
      </p>

      {report.filters.length > 0 && (
        <ReportFilterBar
          filters={report.filters}
          options={options}
          current={query}
        />
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground tabular">
          {result.unavailable
            ? "Nothing to show yet"
            : `${result.total.toLocaleString("en-IN")} row(s)`}
        </p>
        <ReportActions
          reportKey={report.key}
          canExport={canExport}
          exportNote={`CSV exports up to ${MAX_CSV_ROWS.toLocaleString("en-IN")} rows and streams; XLSX is capped at ${MAX_XLSX_ROWS.toLocaleString("en-IN")} because the whole workbook has to be built in memory.`}
          saveAction={saveReportViewAction}
        />
      </div>

      <ReportTable result={result} />

      {!result.unavailable && result.total > PAGE_SIZE && (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={result.total}
          baseParams={query}
          pathname={`/reports/${report.key}`}
        />
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────

/**
 * Filter dropdown contents.
 *
 * Branches are already limited to what this user may see, so the picker
 * cannot offer a branch whose report would come back empty — which reads
 * as a broken report rather than as a permission boundary.
 */
async function loadFilterOptions(orgId: string, branchIds: string[] | null) {
  const [branches, customers, serviceTypes] = await Promise.all([
    prisma.branch.findMany({
      where: {
        orgId,
        isActive: true,
        deletedAt: null,
        ...(branchIds ? { id: { in: branchIds } } : {}),
      },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
      take: 500,
    }),
    prisma.customer.findMany({
      where: { orgId, isActive: true, deletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true },
      take: 500,
    }),
    prisma.serviceType.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return {
    branches: branches.map((b) => ({
      value: b.id,
      label: `${b.code} — ${b.name}`,
    })),
    customers: customers.map((c) => ({
      value: c.id,
      label: `${c.name} (${c.code})`,
    })),
    serviceTypes: serviceTypes.map((s) => ({ value: s.id, label: s.name })),
  };
}

/** Names for the header sentence, so it does not read as a row of cuids. */
async function loadFilterNames(filters: ReturnType<typeof parseFilters>) {
  const branchIds = [
    filters.branchId,
    filters.originBranchId,
    filters.destinationBranchId,
  ].filter((id): id is string => Boolean(id));

  const [branches, customer, serviceType] = await Promise.all([
    branchIds.length
      ? prisma.branch.findMany({
          where: { id: { in: branchIds } },
          select: { id: true, code: true },
        })
      : Promise.resolve([]),
    filters.customerId
      ? prisma.customer.findUnique({
          where: { id: filters.customerId },
          select: { name: true },
        })
      : Promise.resolve(null),
    filters.serviceTypeId
      ? prisma.serviceType.findUnique({
          where: { id: filters.serviceTypeId },
          select: { name: true },
        })
      : Promise.resolve(null),
  ]);

  const codeById = new Map(branches.map((b) => [b.id, b.code]));

  return {
    branch: filters.branchId ? (codeById.get(filters.branchId) ?? null) : null,
    origin: filters.originBranchId
      ? (codeById.get(filters.originBranchId) ?? null)
      : null,
    destination: filters.destinationBranchId
      ? (codeById.get(filters.destinationBranchId) ?? null)
      : null,
    customer: customer?.name ?? null,
    serviceType: serviceType?.name ?? null,
  };
}
