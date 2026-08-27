import type { Metadata } from "next";
import { headers } from "next/headers";
import { AlertTriangle, PackageSearch, Timer } from "lucide-react";
import { lookupTracking, trackingHref } from "@/lib/portal/tracking";
import { TrackForm } from "@/components/portal/track-form";
import { TrackingCard } from "@/components/portal/tracking-card";

export const metadata: Metadata = {
  title: "Track a consignment",
  description:
    "Enter an LR number or your own reference to see where a consignment is.",
};

export const dynamic = "force-dynamic";

/**
 * Public tracking. No login, per docs/BRD.html §A.14.
 *
 * The query lives in the URL so the result is shareable, and the lookup is
 * throttled per caller because an endpoint that accepts an identifier
 * without a credential is an enumeration target.
 */
export default async function TrackPage({
  searchParams,
}: {
  searchParams: Promise<{ lr?: string }>;
}) {
  const { lr } = await searchParams;
  const query = (lr ?? "").trim();

  const result = query
    ? await lookupTracking(query, await headers())
    : ({ ok: false, reason: "EMPTY" } as const);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-primary">
          Track a consignment
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          Where is it?
        </h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Every milestone below was produced by someone actually handling the
          freight — a scan at the dock, a load onto a vehicle, a signature at
          the door.
        </p>
      </div>

      <TrackForm defaultValue={query} />

      {result.ok === false && result.reason === "RATE_LIMITED" && (
        <Notice
          tone="warn"
          icon="timer"
          title="Too many lookups"
          body={`Give it ${result.retryAfterSeconds} second${
            result.retryAfterSeconds === 1 ? "" : "s"
          } and try again. Tracking is throttled to keep the service quick for everyone.`}
        />
      )}

      {result.ok && result.found.length === 0 && (
        <Notice
          tone="muted"
          icon="search"
          title="Nothing found"
          body="Check the number and try again. If the consignment was booked in the last few minutes it may not be searchable yet."
        />
      )}

      {result.ok && result.found.length > 0 && (
        <div className="flex flex-col gap-5">
          {result.notFound.length > 0 && (
            <Notice
              tone="warn"
              icon="alert"
              title={`${result.notFound.length} not found`}
              body={result.notFound.join(", ")}
            />
          )}

          {result.found.map((tracking) => (
            <TrackingCard
              key={tracking.lrNumber}
              tracking={tracking}
              showPermalink={result.found.length > 1}
            />
          ))}

          {result.found.length === 1 && (
            <p className="text-xs text-muted-foreground">
              Share this consignment with{" "}
              <span className="font-mono">
                {trackingHref([result.found[0].lrNumber])}
              </span>
              .
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Icons are chosen here from a name rather than passed in as components —
 * a Lucide component cannot cross a server/client boundary as a prop, and
 * keeping the mapping local means it never has to.
 */
function Notice({
  tone,
  icon,
  title,
  body,
}: {
  tone: "warn" | "muted";
  icon: "timer" | "search" | "alert";
  title: string;
  body: string;
}) {
  const Icon =
    icon === "timer" ? Timer : icon === "search" ? PackageSearch : AlertTriangle;

  return (
    <div
      className={
        tone === "warn"
          ? "flex items-start gap-3 rounded-lg border border-warn/40 bg-warn-muted px-4 py-3 text-warn"
          : "flex items-start gap-3 rounded-lg border border-dashed px-4 py-6 text-muted-foreground"
      }
      role={tone === "warn" ? "alert" : undefined}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm break-words opacity-90">{body}</p>
      </div>
    </div>
  );
}
