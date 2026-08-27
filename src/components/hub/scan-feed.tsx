"use client";

import { CheckCircle2, Loader2, TriangleAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The running list of what has been scanned this session.
 *
 * Newest first and colour-coded, because the only question an operator
 * asks of this list is "did the last one go through". Everything else —
 * counts, line ticks — lives above it.
 */

export type ScanTone = "ok" | "warn" | "bad" | "pending";

export type ScanFeedItem = {
  /** Stable across the optimistic row and the server's answer. */
  key: string;
  tone: ScanTone;
  barcode: string;
  message: string;
  lrNumber?: string | null;
  packageSequence?: number | null;
  packageCount?: number | null;
  destinationBranchCode?: string | null;
  at?: string | null;
};

const TONE_STYLES: Record<ScanTone, { row: string; icon: string }> = {
  ok: { row: "bg-ok-muted text-ok", icon: "text-ok" },
  warn: { row: "bg-warn-muted text-warn", icon: "text-warn" },
  bad: { row: "bg-bad-muted text-bad", icon: "text-bad" },
  pending: { row: "bg-muted text-muted-foreground", icon: "text-muted-foreground" },
};

function ToneIcon({ tone }: { tone: ScanTone }) {
  const className = cn("size-4 shrink-0", TONE_STYLES[tone].icon);
  if (tone === "pending") return <Loader2 className={cn(className, "animate-spin")} />;
  if (tone === "ok") return <CheckCircle2 className={className} />;
  if (tone === "warn") return <TriangleAlert className={className} />;
  return <XCircle className={className} />;
}

export function ScanFeed({
  items,
  emptyLabel = "Nothing scanned yet. Pull the trigger.",
  className,
}: {
  items: ScanFeedItem[];
  emptyLabel?: string;
  className?: string;
}) {
  if (items.length === 0) {
    return (
      <p className={cn("rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground", className)}>
        {emptyLabel}
      </p>
    );
  }

  return (
    <ol className={cn("flex flex-col gap-1", className)}>
      {items.map((item) => (
        <li
          key={item.key}
          className={cn(
            "flex items-start gap-2.5 rounded-lg px-3 py-2",
            TONE_STYLES[item.tone].row,
          )}
        >
          <span className="pt-0.5">
            <ToneIcon tone={item.tone} />
          </span>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-sm font-semibold break-all">
                {item.barcode}
              </span>
              {item.packageSequence != null && item.packageCount != null && (
                <span className="font-mono text-[0.6rem] uppercase tracking-wider opacity-80">
                  box {item.packageSequence}/{item.packageCount}
                </span>
              )}
              {item.destinationBranchCode && (
                <span className="rounded-sm bg-background/50 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider">
                  → {item.destinationBranchCode}
                </span>
              )}
            </div>
            <p className="text-xs opacity-90">{item.message}</p>
          </div>

          {item.at && (
            <span className="shrink-0 font-mono text-[0.6rem] tabular opacity-70">
              {new Date(item.at).toLocaleTimeString("en-IN", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
              })}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Big count tiles above the feed. */
export function ScanTally({
  items,
}: {
  items: Array<{ label: string; value: number | string; tone?: "ok" | "warn" | "bad" | "muted" }>;
}) {
  const TONE: Record<string, string> = {
    ok: "bg-ok-muted text-ok",
    warn: "bg-warn-muted text-warn",
    bad: "bg-bad-muted text-bad",
    muted: "bg-muted text-foreground",
  };

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className={cn(
            "flex flex-col gap-0.5 rounded-lg px-3 py-2",
            TONE[item.tone ?? "muted"],
          )}
        >
          <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] opacity-80">
            {item.label}
          </span>
          <span className="text-xl font-semibold tabular">{item.value}</span>
        </div>
      ))}
    </div>
  );
}
