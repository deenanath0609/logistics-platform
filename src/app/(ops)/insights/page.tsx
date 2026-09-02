import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { KpiCard } from "@/components/reports/kpi-card";
import {
  CutBars,
  ExceptionMix,
  OnTimeTrend,
  VolumeTrend,
} from "@/components/reports/charts";
import { ReportFilterBar } from "@/components/reports/filter-bar";
import {
  describeFilters,
  filtersToParams,
  parseFilters,
  restrictToDeclared,
} from "@/lib/reports/filters";
import { DAMAGE_CAPTURE_CAVEAT, gatherInsights } from "@/lib/reports/insights";
import { scopeNote } from "@/lib/reports/scope";
import type { FilterKey } from "@/lib/reports/types";
import {
  KPI_THRESHOLDS,
  formatMinutes,
  formatPercent,
  gradeKpi,
} from "@/lib/reports/kpi";

export const metadata: Metadata = { title: "Insights" };
export const dynamic = "force-dynamic";

/** One list, so the bar and the parser cannot disagree about what applies. */
const INSIGHT_FILTERS: FilterKey[] = [
  "dates",
  "branch",
  "customer",
  "serviceType",
  "mode",
];

/**
 * The management dashboard — docs/BRD.html §A.17.
 *
 * Every KPI here is the same function the report library uses, fed from
 * the same event log, so "the dashboard says 94% and the report says 91%"
 * cannot happen. Each card carries its own denominator, because the first
 * question anyone senior asks about a percentage is "out of how many?",
 * and a dashboard that cannot answer that gets one more meeting and then
 * stops being opened.
 */
export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("report.management");

  const raw = await searchParams;
  // The same narrowing the report pages do: the bar below draws five
  // controls, so a pasted `?sla=` or `?q=` must be neither applied nor
  // announced in the header sentence.
  const filters = restrictToDeclared(parseFilters(raw), INSIGHT_FILTERS);

  const [insights, options] = await Promise.all([
    gatherInsights(user, filters),
    loadOptions(user.orgId, user.branchIds),
  ]);

  const note = scopeNote(user);
  const delta =
    insights.onTime.percent !== null && insights.onTimePrevious !== null
      ? Number((insights.onTime.percent - insights.onTimePrevious).toFixed(1))
      : null;

  return (
    <>
      <PageHeader
        eyebrow="Management"
        title="Insights"
        description="The KPI set from §A.17, cut by lane, branch, customer and service. Every figure comes from the shipment event log."
        actions={
          <Button variant="outline" size="sm" render={<Link href="/reports" />}>
            Report library
          </Button>
        }
      />

      <p className="mb-4 font-mono text-[0.65rem] uppercase tracking-[0.13em] text-muted-foreground">
        {describeFilters(filters)}
        {note && <span className="ml-2 text-warn">{note}</span>}
      </p>

      <ReportFilterBar
        filters={INSIGHT_FILTERS}
        options={options}
        current={filtersToParams(filters)}
      />

      {insights.sampled && (
        <p className="mb-4 rounded-lg border border-warn/40 bg-warn-muted px-3 py-2 text-xs text-warn">
          These figures are computed from the most recent{" "}
          {insights.sampleSize.toLocaleString("en-IN")} deliveries in the window,
          not all of them. Narrow the date range or pick a branch for exact
          numbers — a sampled KPI quoted as an exact one is worse than no KPI.
        </p>
      )}

      {(insights.truncated.cod ||
        insights.truncated.trips ||
        insights.truncated.dwell) && (
        <p className="mb-4 rounded-lg border border-warn/40 bg-warn-muted px-3 py-2 text-xs text-warn">
          Some supporting samples hit their ceiling in this window:{" "}
          {[
            insights.truncated.cod && "COD ageing buckets",
            insights.truncated.trips && "truck utilisation",
            insights.truncated.dwell && "hub dwell",
          ]
            .filter(Boolean)
            .join(", ")}
          . Narrow the range or pick a branch. The COD rupee total and count
          are exact whatever the buckets hold.
        </p>
      )}

      {/* ── Headline KPIs ────────────────────────────────── */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="On-time delivery"
          value={formatPercent(insights.onTime.percent)}
          grade={gradeKpi(insights.onTime.percent, KPI_THRESHOLDS.onTimeDelivery)}
          detail={`${insights.onTime.numerator.toLocaleString("en-IN")} of ${insights.onTime.denominator.toLocaleString("en-IN")} measured deliveries`}
          delta={delta}
          better="higher"
          caveat={
            insights.onTime.unmeasured > 0
              ? `${insights.onTime.unmeasured.toLocaleString("en-IN")} delivered on a lane with no SLA policy`
              : undefined
          }
        />

        <KpiCard
          label="First-attempt delivery"
          value={formatPercent(insights.firstAttempt.percent)}
          grade={gradeKpi(insights.firstAttempt.percent, KPI_THRESHOLDS.firstAttempt)}
          detail={`${insights.firstAttempt.numerator.toLocaleString("en-IN")} of ${insights.firstAttempt.denominator.toLocaleString("en-IN")} deliveries`}
          better="higher"
        />

        <KpiCard
          label="SLA breach"
          value={formatPercent(insights.slaBreach.percent)}
          grade={gradeKpi(insights.slaBreach.percent, KPI_THRESHOLDS.slaBreach)}
          detail={`${insights.slaBreach.numerator.toLocaleString("en-IN")} of ${insights.slaBreach.denominator.toLocaleString("en-IN")} with a commitment`}
          better="lower"
        />

        <KpiCard
          label="Average transit"
          value={formatMinutes(insights.transit.averageMinutes)}
          grade={insights.transit.samples > 0 ? "good" : "unknown"}
          detail={
            insights.transit.samples > 0
              ? `median ${formatMinutes(insights.transit.medianMinutes)} · ${insights.transit.samples.toLocaleString("en-IN")} shipments`
              : "No pickup-to-delivery pair in this window"
          }
        />

        <KpiCard
          label="Hub dwell"
          value={formatMinutes(insights.dwell.averageMinutes)}
          grade={insights.dwell.samples > 0 ? "good" : "unknown"}
          detail={
            insights.dwell.samples > 0
              ? `median ${formatMinutes(insights.dwell.medianMinutes)} · ${insights.dwell.samples.toLocaleString("en-IN")} completed visits`
              : "Nothing has both arrived and left in this window"
          }
        />

        <KpiCard
          label="Truck load utilisation"
          value={formatPercent(insights.utilisation.weightPercent)}
          grade={gradeKpi(insights.utilisation.weightPercent, KPI_THRESHOLDS.utilisation)}
          detail={`by weight across ${insights.utilisation.trips.toLocaleString("en-IN")} trips`}
          caveat={
            insights.utilisation.volumeUnknown > 0
              ? `${insights.utilisation.volumeUnknown} trip(s) on a vehicle type with no cubic capacity`
              : undefined
          }
          better="higher"
        />

        <KpiCard
          label="Damage & loss"
          value={formatPercent(insights.damageLoss.percent)}
          grade={gradeKpi(insights.damageLoss.percent, KPI_THRESHOLDS.damageLoss)}
          detail={`${insights.damageLoss.numerator.toLocaleString("en-IN")} of ${insights.damageLoss.denominator.toLocaleString("en-IN")} handled`}
          // Permanent until damage capture exists. The label is §A.17's and
          // the measurement is narrower than the label, which is the sort of
          // gap a reader has no way to spot from the number.
          caveat={DAMAGE_CAPTURE_CAVEAT}
          better="lower"
        />

        <KpiCard
          label="COD held"
          value={`₹${insights.cod.total.toDecimalPlaces(0).toNumber().toLocaleString("en-IN")}`}
          grade={
            insights.cod.count === 0
              ? "good"
              : insights.cod.oldestBucket === "0–1 d"
                ? "good"
                : insights.cod.oldestBucket === "2–3 d"
                  ? "watch"
                  : "bad"
          }
          detail={`${insights.cod.count.toLocaleString("en-IN")} collection(s) not yet remitted`}
          caveat={
            insights.cod.oldestBucket && insights.cod.oldestBucket !== "0–1 d"
              ? `oldest sitting in the ${insights.cod.oldestBucket} bucket`
              : undefined
          }
        />
      </section>

      {/* ── Trend ────────────────────────────────────────── */}
      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <Panel
          title="On-time delivery over the window"
          hint="A gap in the line is a day with nothing to measure, not a day the network scored zero."
        >
          <OnTimeTrend data={insights.trend} />
        </Panel>

        <Panel
          title="Delivered against breached"
          hint="Volume and failure together: a breach count means nothing without the volume under it."
        >
          <VolumeTrend data={insights.trend} />
        </Panel>
      </section>

      {/* ── Cuts ─────────────────────────────────────────── */}
      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <Panel title="Worst lanes" hint="On-time %, weakest ten first.">
          <Cut data={insights.byLane} />
        </Panel>

        <Panel
          title="Worst destination branches"
          hint="The branch that received it owns the delivery promise."
        >
          <Cut data={insights.byBranch} />
        </Panel>

        <Panel title="Customers to talk to" hint="On-time % by consignor account.">
          <Cut data={insights.byCustomer} />
        </Panel>

        <Panel title="By service type" hint="Express and surface do not fail alike.">
          <Cut data={insights.byService} />
        </Panel>
      </section>

      {/* ── Exceptions ───────────────────────────────────── */}
      <section className="mt-8">
        <Panel
          title={`Open exceptions — ${insights.openExceptions.toLocaleString("en-IN")}`}
          hint="What is open right now in the branch this screen is filtered to — the date range above does not apply to it, because an exception raised last month and still open is a problem today. The tower has the detail."
          action={
            <Button variant="outline" size="sm" render={<Link href="/exceptions" />}>
              Open the tower
            </Button>
          }
        >
          {insights.exceptionMix.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing open. Either a good shift, or the scanner has not run yet.
            </p>
          ) : (
            <ExceptionMix data={insights.exceptionMix} />
          )}
        </Panel>
      </section>

      {/* ── COD ageing ───────────────────────────────────── */}
      <section className="mt-8">
        <Panel
          title="COD ageing"
          hint="Cash collected at the door but not yet remitted. Every bucket past the first is money sitting in the network."
        >
          <ul className="grid gap-3 sm:grid-cols-4">
            {insights.cod.aged.map((bucket, index) => (
              <li
                key={bucket.label}
                className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 ${
                  index === 0
                    ? "bg-card"
                    : bucket.amount > 0
                      ? "border-warn/40 bg-warn-muted"
                      : "bg-card"
                }`}
              >
                <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
                  {bucket.label}
                </span>
                <span className="text-lg font-semibold tabular">
                  ₹{bucket.amount.toLocaleString("en-IN")}
                </span>
                <span className="text-xs text-muted-foreground tabular">
                  {bucket.count} collection(s)
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </section>
    </>
  );
}

// ────────────────────────────────────────────────────────────

function Panel({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            {title}
          </h2>
          {hint && (
            <p className="max-w-prose text-xs text-muted-foreground">{hint}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Cut({ data }: { data: Array<{ label: string; value: number | null; volume: number }> }) {
  if (data.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Nothing measurable in this window.
      </p>
    );
  }
  return <CutBars data={data} />;
}

async function loadOptions(orgId: string, branchIds: string[] | null) {
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
    branches: branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })),
    customers: customers.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` })),
    serviceTypes: serviceTypes.map((s) => ({ value: s.id, label: s.name })),
  };
}
