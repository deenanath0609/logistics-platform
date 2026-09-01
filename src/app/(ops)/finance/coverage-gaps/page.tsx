import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission, can } from "@/lib/auth/session";
import { coverageGaps } from "@/lib/pricing/rerate";
import { endOfBusinessDay, startOfBusinessDay } from "@/lib/time/business-day";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { ReasonAction } from "@/components/finance/reason-action";
import { BackLink } from "@/components/finance/finance-shell";
import { formatDate } from "@/components/finance/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { rerateShipmentAction } from "./actions";

export const metadata: Metadata = { title: "Rate card coverage gaps" };
export const dynamic = "force-dynamic";

export default async function CoverageGapsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requirePermission("ratecard.read");
  const canRerate = can(user, "ratecard.manage");
  const { from, to } = await searchParams;

  const rows = await coverageGaps(
    {
      orgId: user.orgId,
      // The bounds are calendar days off the query string, widened to the
      // instants the business day actually covers — a UTC-truncated window
      // loses the first five and a half hours of every Indian day.
      from: from ? startOfBusinessDay(new Date(from)) : undefined,
      to: to ? endOfBusinessDay(new Date(to)) : undefined,
    },
    user,
  );

  // A lane appearing twenty times is one rate card to write, not twenty.
  const byLane = new Map<string, number>();
  for (const row of rows) {
    const lane = `${row.origin} → ${row.destination}`;
    byLane.set(lane, (byLane.get(lane) ?? 0) + 1);
  }
  const lanes = [...byLane.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  return (
    <>
      <BackLink href="/finance/rate-cards" label="Rate cards" />

      <PageHeader
        eyebrow="Finance"
        title="Rate card coverage gaps"
        description="Consignments no rate rule matched. They booked with an unrated flag rather than silently at zero, which is the whole point — a lane that prices at nothing looks fine on every screen until the month-end invoice is short."
      />

      {lanes.length > 0 && (
        <div className="mb-6 rounded-lg border bg-card p-4">
          <p className="pb-3 font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
            Lanes to price, most frequent first
          </p>
          <ul className="flex flex-wrap gap-2">
            {lanes.map(([lane, count]) => (
              <li
                key={lane}
                className="rounded-md border bg-background px-2.5 py-1 text-xs"
              >
                <span className="font-mono">{lane}</span>
                <span className="ml-2 text-muted-foreground">{count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title="Every lane is priced"
            description="No consignment has booked unrated. That is the state to keep it in."
          />
        ) : (
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>LR</TableHead>
                <TableHead>Booked</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Lane</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Why it could not be priced</TableHead>
                {canRerate && <TableHead className="text-right">Action</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.shipmentId}>
                  <TableCell className="font-mono text-xs font-medium">
                    <Link href={`/shipments/${row.shipmentId}`} className="hover:underline">
                      {row.lrNumber}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">{formatDate(row.bookedAt)}</TableCell>
                  <TableCell className="text-sm">{row.customerName ?? "Walk-in"}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.origin} → {row.destination}
                  </TableCell>
                  <TableCell className="text-xs">{row.mode}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{row.reason}</TableCell>
                  {canRerate && (
                    <TableCell className="text-right">
                      <ReasonAction
                        id={row.shipmentId}
                        title={`Re-rate ${row.lrNumber}?`}
                        description="Runs the engine again against today's cards. The original calculation is kept — a second one is stored, and the delta is recorded."
                        reasonLabel="Why it is being re-priced"
                        reasonPlaceholder="Added the DEL-JAI slab to the published tariff."
                        confirmLabel="Re-rate"
                        icon="shield"
                        size="xs"
                        variant="outline"
                        action={rerateShipmentAction}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>
    </>
  );
}
