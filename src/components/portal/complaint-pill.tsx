import { cn } from "@/lib/utils";

/**
 * The complaint status pill.
 *
 * Takes a coarse tone, like the shipment one: the internal SLA state —
 * on track, at risk, breached — is how the company measures itself, and
 * putting "BREACHED" in front of the customer whose consignment is missing
 * is a way of talking about ourselves at the worst possible moment.
 */
export type ComplaintTone = "open" | "working" | "settled";

const TONE: Record<ComplaintTone, string> = {
  open: "bg-warn-muted text-warn",
  working: "bg-info-muted text-info",
  settled: "bg-ok-muted text-ok",
};

export function ComplaintStatusPill({
  label,
  tone,
  className,
}: {
  label: string;
  tone: ComplaintTone;
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
