import type {
  DeliveryRunStatus,
  DeliveryTaskStatus,
} from "@/generated/prisma/client";
import { cn } from "@/lib/utils";

/**
 * Run and stop status in the same visual language as `StatusPill`: tone
 * follows meaning, so a manager scanning the day sees where the trouble is
 * without reading a word.
 */

const RUN_TONE: Record<DeliveryRunStatus, string> = {
  PLANNED: "bg-muted text-muted-foreground",
  STARTED: "bg-warn-muted text-warn",
  COMPLETED: "bg-ok-muted text-ok",
  CANCELLED: "bg-bad-muted text-bad",
};

const RUN_LABEL: Record<DeliveryRunStatus, string> = {
  PLANNED: "Planned",
  STARTED: "Out",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const TASK_TONE: Record<DeliveryTaskStatus, string> = {
  PENDING: "bg-muted text-muted-foreground",
  OUT_FOR_DELIVERY: "bg-warn-muted text-warn",
  DELIVERED: "bg-ok-muted text-ok",
  FAILED: "bg-bad-muted text-bad",
  RETURNED: "bg-bad-muted text-bad",
  CANCELLED: "bg-bad-muted text-bad",
};

const TASK_LABEL: Record<DeliveryTaskStatus, string> = {
  PENDING: "Pending",
  OUT_FOR_DELIVERY: "At the door",
  DELIVERED: "Delivered",
  FAILED: "Attempted",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
};

const BASE =
  "inline-block whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider";

export function RunStatusPill({
  status,
  className,
}: {
  status: DeliveryRunStatus;
  className?: string;
}) {
  return (
    <span className={cn(BASE, RUN_TONE[status], className)}>
      {RUN_LABEL[status]}
    </span>
  );
}

export function TaskStatusPill({
  status,
  className,
}: {
  status: DeliveryTaskStatus;
  className?: string;
}) {
  return (
    <span className={cn(BASE, TASK_TONE[status], className)}>
      {TASK_LABEL[status]}
    </span>
  );
}
