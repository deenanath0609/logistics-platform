import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { ChevronLeft, PackageSearch, Timer } from "lucide-react";
import { lookupTracking } from "@/lib/portal/tracking";
import { TrackingCard } from "@/components/portal/tracking-card";
import { TrackForm } from "@/components/portal/track-form";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lrNumber: string }>;
}): Promise<Metadata> {
  const { lrNumber } = await params;
  return {
    title: `Track ${decodeURIComponent(lrNumber)}`,
    // A tracking link is pasted into email and chat; there is no reason for
    // it to be indexed, and every reason for it not to be.
    robots: { index: false, follow: false },
  };
}

/**
 * The shareable tracking link.
 *
 * Same lookup, same throttle and same projection as `/track` — a permalink
 * must not be a second, laxer way in. A number that does not exist and one
 * that does are answered identically, so this cannot be used to confirm
 * that an LR number is real.
 */
export default async function TrackByNumberPage({
  params,
}: {
  params: Promise<{ lrNumber: string }>;
}) {
  const { lrNumber } = await params;
  const number = decodeURIComponent(lrNumber);

  const result = await lookupTracking(number, await headers());
  const tracking = result.ok ? result.found[0] : undefined;

  return (
    <div className="flex flex-col gap-8">
      <Link
        href="/track"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Track another
      </Link>

      {tracking ? (
        <TrackingCard tracking={tracking} />
      ) : result.ok === false && result.reason === "RATE_LIMITED" ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-warn/40 bg-warn-muted px-4 py-3 text-warn"
        >
          <Timer className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-medium">Too many lookups</p>
            <p className="text-sm opacity-90">
              Give it {result.retryAfterSeconds} second
              {result.retryAfterSeconds === 1 ? "" : "s"} and reload.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex items-start gap-3 rounded-lg border border-dashed px-4 py-6 text-muted-foreground">
            <PackageSearch className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-sm font-medium">Nothing found</p>
              <p className="text-sm break-words">
                No consignment matches{" "}
                <span className="font-mono">{number}</span>.
              </p>
            </div>
          </div>
          <TrackForm defaultValue={number} />
        </div>
      )}
    </div>
  );
}
