import Link from "next/link";
import { format, parseISO } from "date-fns";
import { ArrowRight, Link2, Package } from "lucide-react";
import type { PublicTracking } from "@/lib/portal/visibility";
import { PortalStatusPill } from "./status-pill";
import { PublicTimeline } from "./public-timeline";

/**
 * One consignment on the public tracking page.
 *
 * Every field comes from `PublicTracking` and nothing else is fetched here,
 * which is what keeps a multi-LR lookup from becoming a different, laxer
 * surface than a single one.
 */
export function TrackingCard({
  tracking,
  showPermalink = false,
}: {
  tracking: PublicTracking;
  showPermalink?: boolean;
}) {
  const expected = tracking.expectedDeliveryAt
    ? parseISO(tracking.expectedDeliveryAt)
    : null;
  const delivered = tracking.deliveredAt ? parseISO(tracking.deliveredAt) : null;

  return (
    <article className="flex flex-col gap-5 rounded-lg border bg-card p-5 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="flex flex-wrap items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
            <span>{tracking.fromCity ?? "—"}</span>
            <ArrowRight className="size-3" aria-hidden />
            <span>{tracking.toCity ?? "—"}</span>
          </p>
          <h2 className="font-mono text-xl font-semibold tracking-tight">
            {tracking.lrNumber}
          </h2>
          {tracking.reference && (
            <p className="text-xs text-muted-foreground">
              Your reference{" "}
              <span className="font-mono">{tracking.reference}</span>
            </p>
          )}
        </div>

        <div className="flex flex-col items-end gap-2">
          <PortalStatusPill label={tracking.status} tone={tracking.tone} />
          {showPermalink && (
            <Link
              href={`/track/${encodeURIComponent(tracking.lrNumber)}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Link2 className="size-3" aria-hidden />
              Shareable link
            </Link>
          )}
        </div>
      </header>

      <dl className="flex flex-wrap gap-x-6 gap-y-2 border-y py-3 text-sm">
        <Fact
          label="Packages"
          value={
            <span className="inline-flex items-center gap-1.5">
              <Package className="size-3.5 text-muted-foreground" aria-hidden />
              {tracking.packageCount}
            </span>
          }
        />
        <Fact
          label="Booked"
          value={format(parseISO(tracking.bookedAt), "dd MMM yyyy")}
        />
        {delivered ? (
          <Fact
            label="Delivered"
            value={format(delivered, "dd MMM yyyy · HH:mm")}
          />
        ) : expected ? (
          <Fact label="Expected" value={format(expected, "dd MMM yyyy")} />
        ) : null}
      </dl>

      <PublicTimeline milestones={tracking.milestones} />
    </article>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
        {label}
      </dt>
      <dd className="font-medium tabular">{value}</dd>
    </div>
  );
}
