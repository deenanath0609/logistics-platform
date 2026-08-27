import { format, parseISO } from "date-fns";
import { MapPin } from "lucide-react";
import type { PublicMilestone } from "@/lib/portal/visibility";
import { cn } from "@/lib/utils";

/**
 * The milestone list a consignee sees — dates and city names only.
 *
 * It renders `PublicMilestone`, which has exactly four fields. There is no
 * branch, vehicle, agent or remark on the props to render even if someone
 * wanted to; the boundary is in the type, not in this file's discipline.
 * See docs/BRD.html §A.14.
 */
export function PublicTimeline({
  milestones,
  className,
}: {
  milestones: PublicMilestone[];
  className?: string;
}) {
  if (milestones.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        Nothing has been recorded against this consignment yet.
      </p>
    );
  }

  // Newest first: the thing a person opened the page to find out is where
  // it is now, not where it started.
  const ordered = [...milestones].reverse();

  return (
    <ol className={cn("flex flex-col", className)}>
      {ordered.map((milestone, index) => {
        const isCurrent = index === 0;
        const isLast = index === ordered.length - 1;
        const at = parseISO(milestone.at);

        return (
          <li
            key={milestone.key}
            className="grid grid-cols-[20px_minmax(0,1fr)] gap-3"
          >
            <div className="relative flex justify-center">
              <span
                className={cn(
                  "mt-1.5 size-2.5 shrink-0 rounded-full ring-4 ring-background",
                  isCurrent ? "bg-primary" : "bg-border",
                )}
              />
              {!isLast && <span className="absolute top-4 bottom-0 w-px bg-border" />}
            </div>

            <div className={cn("flex flex-col gap-0.5", isLast ? "pb-0" : "pb-5")}>
              <span
                className={cn(
                  "text-sm",
                  isCurrent ? "font-semibold" : "font-medium text-foreground/85",
                )}
              >
                {milestone.label}
              </span>

              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="font-mono tabular">
                  {format(at, "dd MMM yyyy · HH:mm")}
                </span>
                {milestone.city && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="size-3" aria-hidden />
                    {milestone.city}
                  </span>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
