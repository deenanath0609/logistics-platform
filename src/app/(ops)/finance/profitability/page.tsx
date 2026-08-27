import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth/session";
import {
  tripProfitability,
  shipmentProfitability,
  profitabilitySummary,
} from "@/lib/billing/profitability";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { StatTiles, MoneyCell } from "@/components/finance/finance-shell";
import { formatDate, formatMoneyShort, isoDate } from "@/components/finance/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Profitability" };
export const dynamic = "force-dynamic";

/** Tone for a margin: below zero is losing money on the run. */
function marginTone(percent: string | null): string {
  if (percent === null) return "text-muted-foreground";
  const numeric = Number(percent);
  if (numeric < 0) return "text-bad";
  if (numeric < 10) return "text-warn";
  return "text-ok";
}

export default async function ProfitabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; view?: string }>;
}) {
  const user = await requirePermission("report.financial");
  const { from, to, view } = await searchParams;

  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodFrom = from ? new Date(from) : defaultFrom;
  const periodTo = to ? new Date(to) : now;

  const byShipment = view === "shipment";

  const [summary, trips, shipments] = await Promise.all([
    profitabilitySummary({ from: periodFrom, to: periodTo }, user),
    byShipment
      ? Promise.resolve([])
      : tripProfitability({ from: periodFrom, to: periodTo }, user),
    byShipment
      ? shipmentProfitability({ from: periodFrom, to: periodTo }, user)
      : Promise.resolve([]),
  ]);

  const params = `from=${isoDate(periodFrom)}&to=${isoDate(periodTo)}`;

  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Profitability"
        description="Revenue less vendor freight less trip expenses. Overhead is deliberately not apportioned — a made-up allocation reads as precision it does not have, and contribution is the number an operations manager can act on."
      />

      <StatTiles
        items={[
          { label: "Revenue on trips", value: formatMoneyShort(summary.revenue.toFixed(2)) },
          {
            label: "Vendor freight",
            value: formatMoneyShort(summary.vendorFreight.toFixed(2)),
            tone: "warn",
          },
          {
            label: "Trip expenses",
            value: formatMoneyShort(summary.expenses.toFixed(2)),
            tone: "warn",
          },
          {
            label: "Contribution",
            value: formatMoneyShort(summary.contribution.toFixed(2)),
            tone: summary.contribution.lessThan(0) ? "bad" : "ok",
            hint: summary.marginPercent
              ? `${summary.marginPercent.toFixed(1)}% margin`
              : undefined,
          },
          {
            label: "Invoiced",
            value: formatMoneyShort(summary.invoiced.toFixed(2)),
            hint: "Billed in the same window",
          },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2 pb-4">
        <ViewChip label="By trip" href={`/finance/profitability?${params}`} active={!byShipment} />
        <ViewChip
          label="By consignment"
          href={`/finance/profitability?${params}&view=shipment`}
          active={byShipment}
        />
        <span className="text-xs text-muted-foreground">
          {formatDate(periodFrom)} – {formatDate(periodTo)}
        </span>
      </div>

      {byShipment ? (
        <>
          <p className="pb-3 text-sm text-muted-foreground">
            Line-haul cost is a trip-level fact, so the cost against a consignment is an
            apportionment by revenue share — an allocation, not a measurement.
          </p>
          <TableFrame>
            {shipments.length === 0 ? (
              <EmptyState title="Nothing in this window" />
            ) : (
              <Table className="min-w-[880px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>LR</TableHead>
                    <TableHead>Booked</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Lane</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Allocated cost</TableHead>
                    <TableHead className="text-right">Contribution</TableHead>
                    <TableHead className="text-right">Margin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shipments.map((row) => (
                    <TableRow key={row.shipmentId}>
                      <TableCell className="font-mono text-xs">
                        <Link href={`/shipments/${row.shipmentId}`} className="hover:underline">
                          {row.lrNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs">{formatDate(row.bookedAt)}</TableCell>
                      <TableCell className="text-sm">{row.customerName ?? "Walk-in"}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {row.lane}
                      </TableCell>
                      <TableCell className="text-right">
                        <MoneyCell value={row.revenue.toFixed(2)} />
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <MoneyCell
                          value={row.allocatedCost.toFixed(2)}
                          tone="text-muted-foreground"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <MoneyCell
                          value={row.contribution.toFixed(2)}
                          strong
                          tone={marginTone(row.marginPercent?.toFixed(1) ?? null)}
                        />
                      </TableCell>
                      <TableCell
                        className={`text-right text-xs tabular ${marginTone(
                          row.marginPercent?.toFixed(1) ?? null,
                        )}`}
                      >
                        {row.marginPercent ? `${row.marginPercent.toFixed(1)}%` : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableFrame>
        </>
      ) : (
        <TableFrame>
          {trips.length === 0 ? (
            <EmptyState title="No trips in this window" />
          ) : (
            <Table className="min-w-[1000px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Trip</TableHead>
                  <TableHead>Departed</TableHead>
                  <TableHead>Lane</TableHead>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">LRs</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Vendor freight</TableHead>
                  <TableHead className="text-right">Expenses</TableHead>
                  <TableHead className="text-right">Contribution</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trips.map((row) => (
                  <TableRow key={row.tripId}>
                    <TableCell className="font-mono text-xs font-medium">{row.number}</TableCell>
                    <TableCell className="text-xs">{formatDate(row.departedAt)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.origin} → {row.destination}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.vehicleNumber}</TableCell>
                    <TableCell className="text-sm">{row.vendorName ?? "Own fleet"}</TableCell>
                    <TableCell className="text-right text-xs tabular">
                      {row.shipmentCount}
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyCell value={row.revenue.toFixed(2)} />
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      <MoneyCell
                        value={row.vendorFreight.toFixed(2)}
                        tone="text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      <MoneyCell value={row.expenses.toFixed(2)} tone="text-muted-foreground" />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyCell
                        value={row.contribution.toFixed(2)}
                        strong
                        tone={marginTone(row.marginPercent?.toFixed(1) ?? null)}
                      />
                    </TableCell>
                    <TableCell
                      className={`text-right text-xs tabular ${marginTone(
                        row.marginPercent?.toFixed(1) ?? null,
                      )}`}
                    >
                      {row.marginPercent ? `${row.marginPercent.toFixed(1)}%` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableFrame>
      )}
    </>
  );
}

function ViewChip({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-2.5 py-0.5 font-mono text-[0.65rem] uppercase tracking-wider transition-colors ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-muted"
      }`}
    >
      {label}
    </Link>
  );
}
