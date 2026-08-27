import type { PublicTone } from "@/lib/portal/visibility";
import { cn } from "@/lib/utils";

/**
 * The customer-facing status pill.
 *
 * Takes a coarse tone rather than a `ShipmentStatus`: the internal status
 * never crosses into the public payload, so there is nothing here to render
 * it from even by accident.
 */
const TONE: Record<PublicTone, string> = {
  pending: "bg-muted text-muted-foreground",
  moving: "bg-info-muted text-info",
  done: "bg-ok-muted text-ok",
  exception: "bg-bad-muted text-bad",
};

export function PortalStatusPill({
  label,
  tone,
  className,
}: {
  label: string;
  tone: PublicTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block whitespace-nowrap rounded-sm px-2 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider",
        TONE[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}
