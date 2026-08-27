import type { ComplaintPriority, ComplaintStatus } from "@/generated/prisma/client";
import { STATUS_LABEL, PRIORITY_LABEL } from "@/lib/complaints/workflow";
import type { SlaState } from "@/lib/complaints/sla";
import { cn } from "@/lib/utils";

/**
 * Status, priority and SLA as three separate marks.
 *
 * They are genuinely three facts — a complaint can be actively worked on,
 * low priority, and still breached — and collapsing them into one badge
 * would hide the combination that most needs looking at.
 */

const PILL =
  "inline-block whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider";

const STATUS_TONE: Record<ComplaintStatus, string> = {
  OPEN: "bg-warn-muted text-warn",
  ASSIGNED: "bg-info-muted text-info",
  INVESTIGATING: "bg-info-muted text-info",
  ACTION_TAKEN: "bg-accent text-accent-foreground",
  RESOLVED: "bg-ok-muted text-ok",
  CLOSED: "bg-muted text-muted-foreground",
  REOPENED: "bg-bad-muted text-bad",
};

export function ComplaintStatusPill({
  status,
  className,
}: {
  status: ComplaintStatus;
  className?: string;
}) {
  return (
    <span className={cn(PILL, STATUS_TONE[status], className)}>
      {STATUS_LABEL[status]}
    </span>
  );
}

const PRIORITY_TONE: Record<ComplaintPriority, string> = {
  LOW: "text-muted-foreground",
  NORMAL: "text-muted-foreground",
  HIGH: "text-warn",
  CRITICAL: "text-bad",
};

export function PriorityMark({ priority }: { priority: ComplaintPriority }) {
  return (
    <span
      className={cn(
        "font-mono text-[0.6rem] uppercase tracking-wider",
        PRIORITY_TONE[priority],
      )}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

const SLA_TONE: Record<SlaState, string> = {
  MET: "bg-ok-muted text-ok",
  ON_TRACK: "bg-muted text-muted-foreground",
  AT_RISK: "bg-warn-muted text-warn",
  BREACHED: "bg-bad-muted text-bad",
  UNTRACKED: "bg-muted text-muted-foreground",
};

const SLA_LABEL: Record<SlaState, string> = {
  MET: "Met",
  ON_TRACK: "On track",
  AT_RISK: "At risk",
  BREACHED: "Breached",
  UNTRACKED: "No SLA",
};

export function SlaPill({
  state,
  label,
  className,
}: {
  state: SlaState;
  /** Overrides the default word — used to prefix "Response" or "Resolution". */
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn(PILL, SLA_TONE[state], className)}>
      {label ?? SLA_LABEL[state]}
    </span>
  );
}

export { SLA_LABEL };
