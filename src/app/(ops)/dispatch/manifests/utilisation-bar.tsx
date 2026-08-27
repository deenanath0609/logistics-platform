import { cn } from "@/lib/utils";

/**
 * Capacity against the assigned vehicle.
 *
 * The point of the bar is the empty half, not the full one — BRD §A.7 asks
 * for a dispatcher to notice a half-empty truck *before* it leaves — so a
 * lightly loaded vehicle is amber rather than a reassuring neutral, and an
 * overloaded one is red and clipped at the line it crossed.
 *
 * A plain server component: it renders no icons and holds no state, so it
 * needs no client boundary.
 */
export function UtilisationBar({
  percent,
  tone,
  capacityKg,
  label,
  compact = false,
}: {
  percent: number | null;
  tone: "ok" | "warn" | "bad" | "muted";
  capacityKg: number | null;
  label?: string;
  compact?: boolean;
}) {
  if (percent === null || capacityKg === null) {
    return (
      <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
        No capacity on file
      </span>
    );
  }

  const FILL: Record<string, string> = {
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
    muted: "bg-muted-foreground",
  };
  const TEXT: Record<string, string> = {
    ok: "text-ok",
    warn: "text-warn",
    bad: "text-bad",
    muted: "text-muted-foreground",
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn("font-mono text-xs font-semibold tabular", TEXT[tone])}>
          {percent}%
        </span>
        {!compact && (
          <span className="font-mono text-[0.6rem] text-muted-foreground tabular">
            of {capacityKg} kg
          </span>
        )}
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-[width]", FILL[tone])}
          style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
        />
      </div>

      {label && !compact && (
        <p className={cn("text-xs", TEXT[tone])}>{label}</p>
      )}
    </div>
  );
}
