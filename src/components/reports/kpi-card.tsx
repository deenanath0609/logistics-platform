import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus } from "lucide-react";
import { GRADE_TONE, type Grade } from "@/lib/reports/kpi";
import { cn } from "@/lib/utils";

/**
 * One KPI, read at a glance.
 *
 * State is encoded three ways — colour, a word, and the direction of the
 * arrow — because a dashboard where meaning lives only in colour is a
 * dashboard that says nothing to the eight per cent of men who cannot
 * separate the red from the green, and nothing at all in a printout.
 */

export type KpiCardProps = {
  label: string;
  /** Already formatted: "94.2%", "21 h 20 m", "1,204". */
  value: string;
  grade: Grade;
  /** What the number is made of: "412 of 438 delivered". */
  detail?: string;
  /** Change against the previous window, in the KPI's own units. */
  delta?: number | null;
  /** Which direction of change is good. */
  better?: "higher" | "lower";
  /** Rendered when the KPI could not be measured. */
  caveat?: string;
};

const GRADE_WORD: Record<Grade, string> = {
  good: "On target",
  watch: "Watch",
  bad: "Off target",
  unknown: "No data",
};

export function KpiCard({
  label,
  value,
  grade,
  detail,
  delta,
  better = "higher",
  caveat,
}: KpiCardProps) {
  const improved =
    delta === null || delta === undefined || delta === 0
      ? null
      : better === "higher"
        ? delta > 0
        : delta < 0;

  const DeltaIcon =
    delta === null || delta === undefined
      ? Minus
      : delta === 0
        ? ArrowRight
        : delta > 0
          ? ArrowUpRight
          : ArrowDownRight;

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3.5">
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[0.55rem] font-semibold uppercase tracking-wider",
            GRADE_TONE[grade],
          )}
        >
          {GRADE_WORD[grade]}
        </span>
      </div>

      <span className="text-2xl font-semibold tabular">{value}</span>

      <div className="flex flex-col gap-0.5">
        {detail && (
          <span className="text-xs text-muted-foreground">{detail}</span>
        )}

        {delta !== null && delta !== undefined && (
          <span
            className={cn(
              "flex items-center gap-1 text-xs tabular",
              improved === null
                ? "text-muted-foreground"
                : improved
                  ? "text-ok"
                  : "text-bad",
            )}
          >
            <DeltaIcon className="size-3.5" aria-hidden />
            {delta > 0 ? "+" : ""}
            {delta.toFixed(1)} against the previous window
          </span>
        )}

        {caveat && <span className="text-xs text-warn">{caveat}</span>}
      </div>
    </div>
  );
}
