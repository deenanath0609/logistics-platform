import type { ComplaintStatus } from "@/generated/prisma/client";

/**
 * The complaint workflow.
 *
 * `OPEN → ASSIGNED → INVESTIGATING → ACTION_TAKEN → RESOLVED → CLOSED`,
 * plus a reopen path from either end state back into the middle.
 *
 * Pure, so the buttons on the detail screen and the guard in the server
 * action are reading the same table rather than two copies of it that
 * drift apart.
 */

export type Transition = {
  to: ComplaintStatus;
  /** Verb on the button. */
  label: string;
  /** Permission the actor needs. */
  permission: "complaint.create" | "complaint.read" | "complaint.resolve";
  /** True when the form must collect free text before allowing it. */
  requiresNote: boolean;
  /** True when the transition must name an owner. */
  requiresAssignee: boolean;
  /** One line explaining what it means, shown under the button. */
  describe: string;
};

const NONE: Transition[] = [];

export const TRANSITIONS: Record<ComplaintStatus, Transition[]> = {
  OPEN: [
    {
      to: "ASSIGNED",
      label: "Assign",
      permission: "complaint.create",
      requiresNote: false,
      requiresAssignee: true,
      describe: "Give it an owner. Nothing moves until someone owns it.",
    },
  ],
  ASSIGNED: [
    {
      to: "INVESTIGATING",
      label: "Start investigating",
      permission: "complaint.create",
      requiresNote: false,
      requiresAssignee: false,
      describe: "Work has begun — the customer can see this.",
    },
    {
      to: "ASSIGNED",
      label: "Reassign",
      permission: "complaint.create",
      requiresNote: false,
      requiresAssignee: true,
      describe: "Hand it to someone else.",
    },
  ],
  INVESTIGATING: [
    {
      to: "ACTION_TAKEN",
      label: "Record action taken",
      permission: "complaint.create",
      requiresNote: true,
      requiresAssignee: false,
      describe: "What was actually done. Goes into the thread.",
    },
  ],
  ACTION_TAKEN: [
    {
      to: "RESOLVED",
      label: "Resolve",
      permission: "complaint.resolve",
      requiresNote: true,
      requiresAssignee: false,
      describe: "The resolution note the customer will read.",
    },
    {
      to: "INVESTIGATING",
      label: "Back to investigation",
      permission: "complaint.create",
      requiresNote: true,
      requiresAssignee: false,
      describe: "The action did not settle it.",
    },
  ],
  RESOLVED: [
    {
      to: "CLOSED",
      label: "Close",
      permission: "complaint.resolve",
      requiresNote: false,
      requiresAssignee: false,
      describe: "No further action expected.",
    },
    {
      to: "REOPENED",
      label: "Reopen",
      permission: "complaint.create",
      requiresNote: true,
      requiresAssignee: false,
      describe: "The customer came back. The original SLA stands.",
    },
  ],
  CLOSED: [
    {
      to: "REOPENED",
      label: "Reopen",
      permission: "complaint.create",
      requiresNote: true,
      requiresAssignee: false,
      describe: "The customer came back. The original SLA stands.",
    },
  ],
  REOPENED: [
    {
      to: "INVESTIGATING",
      label: "Investigate again",
      permission: "complaint.create",
      requiresNote: false,
      requiresAssignee: false,
      describe: "Pick the thread back up.",
    },
    {
      to: "ASSIGNED",
      label: "Reassign",
      permission: "complaint.create",
      requiresNote: false,
      requiresAssignee: true,
      describe: "Hand it to someone else.",
    },
  ],
};

export function allowedTransitions(from: ComplaintStatus): Transition[] {
  return TRANSITIONS[from] ?? NONE;
}

export function findTransition(
  from: ComplaintStatus,
  to: ComplaintStatus,
): Transition | null {
  return allowedTransitions(from).find((t) => t.to === to) ?? null;
}

/** Statuses that stop the ageing clock. */
export const SETTLED: ComplaintStatus[] = ["RESOLVED", "CLOSED"];

/** Statuses a duty manager considers still on their plate. */
export const LIVE: ComplaintStatus[] = [
  "OPEN",
  "ASSIGNED",
  "INVESTIGATING",
  "ACTION_TAKEN",
  "REOPENED",
];

export function isSettled(status: ComplaintStatus): boolean {
  return SETTLED.includes(status);
}

export const STATUS_LABEL: Record<ComplaintStatus, string> = {
  OPEN: "Open",
  ASSIGNED: "Assigned",
  INVESTIGATING: "Investigating",
  ACTION_TAKEN: "Action taken",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  REOPENED: "Reopened",
};

export const CATEGORY_LABEL: Record<string, string> = {
  DELAY: "Delay",
  DAMAGE: "Damage",
  MISSING: "Missing",
  WRONG_DELIVERY: "Wrong delivery",
  BILLING: "Billing",
  POD_ISSUE: "POD issue",
  PICKUP_ISSUE: "Pickup issue",
  BEHAVIOUR: "Behaviour",
  OTHER: "Other",
};

export const PRIORITY_LABEL: Record<string, string> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  CRITICAL: "Critical",
};
