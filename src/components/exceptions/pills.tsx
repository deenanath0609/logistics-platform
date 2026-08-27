import type {
  ExceptionPriority,
  ExceptionStatus,
} from "@/generated/prisma/client";
import {
  PRIORITY_LABEL,
  PRIORITY_TONE,
  STATUS_LABEL,
  STATUS_TONE,
} from "@/lib/exceptions/kinds";
import { cn } from "@/lib/utils";

/**
 * Severity and status, in colour and in words.
 *
 * A duty manager scanning eighty rows should see where the trouble is
 * before reading any of them — but the word is still there, because the
 * colour alone is no use printed, projected, or to anyone who cannot
 * separate the red from the amber.
 */

export function PriorityPill({
  priority,
  className,
}: {
  priority: ExceptionPriority;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider",
        PRIORITY_TONE[priority],
        className,
      )}
    >
      {priority === "CRITICAL" && <span aria-hidden>▲</span>}
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

export function ExceptionStatusPill({
  status,
  className,
}: {
  status: ExceptionStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider",
        STATUS_TONE[status],
        className,
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** How far up the ladder this has climbed. Nothing shown at level zero. */
export function EscalationMark({ level }: { level: number }) {
  if (level <= 0) return null;

  return (
    <span
      className="inline-block whitespace-nowrap rounded-sm bg-bad-muted px-1.5 py-0.5 font-mono text-[0.55rem] font-semibold uppercase tracking-wider text-bad"
      title={`Escalated ${level} time(s) because nobody acted`}
    >
      L{level}
    </span>
  );
}
