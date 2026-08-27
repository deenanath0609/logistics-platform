import type {
  ExceptionKind,
  ExceptionPriority,
  ExceptionStatus,
} from "@/generated/prisma/client";

/**
 * What the exception tower knows about each kind of problem.
 *
 * Pure data, straight out of docs/BRD.html §A.11: who is told, how loud it
 * is by default, and how long the network will tolerate nobody touching
 * it. Kept as a table rather than as branches so the escalation ladder,
 * the filter chips, and the seed all read the same rows.
 */

export type KindDef = {
  kind: ExceptionKind;
  label: string;
  /** The team the BRD names as owning this problem. */
  defaultOwner: string;
  /** How it got noticed — shown in the detail header. */
  detectedBy: string;
  priority: ExceptionPriority;
  /**
   * Minutes of inaction before level 1 fires, when no `EscalationRule`
   * row exists. A configured ladder always wins; this is the floor so an
   * unconfigured install still escalates instead of silently pooling.
   */
  escalateAfterMinutes: number;
};

const DEFS: KindDef[] = [
  {
    kind: "SLA_AT_RISK",
    label: "SLA at risk",
    defaultOwner: "Origin branch manager",
    detectedBy: "SLA scanner",
    priority: "NORMAL",
    // "Immediate visibility" in the BRD: the point of at-risk is that
    // somebody looks now, so the ladder starts almost straight away.
    escalateAfterMinutes: 30,
  },
  {
    kind: "SLA_BREACHED",
    label: "SLA breached",
    defaultOwner: "Operations manager",
    detectedBy: "SLA scanner",
    priority: "HIGH",
    escalateAfterMinutes: 120,
  },
  {
    kind: "NO_GPS_UPDATE",
    label: "No GPS update",
    defaultOwner: "Transport desk",
    detectedBy: "Ping monitor",
    priority: "NORMAL",
    escalateAfterMinutes: 60,
  },
  {
    kind: "VEHICLE_STOPPED",
    label: "Vehicle stopped",
    defaultOwner: "Transport desk",
    detectedBy: "Stoppage monitor",
    priority: "NORMAL",
    escalateAfterMinutes: 120,
  },
  {
    kind: "ROUTE_DEVIATION",
    label: "Route deviation",
    defaultOwner: "Transport desk",
    detectedBy: "Deviation monitor",
    priority: "HIGH",
    escalateAfterMinutes: 30,
  },
  {
    kind: "DELIVERY_FAILED",
    label: "Delivery failed",
    defaultOwner: "Destination branch",
    detectedBy: "Agent app",
    priority: "NORMAL",
    escalateAfterMinutes: 240,
  },
  {
    kind: "SHORT_RECEIVED",
    label: "Short received",
    defaultOwner: "Dispatching branch",
    detectedBy: "Hub inbound scan",
    priority: "HIGH",
    escalateAfterMinutes: 1440,
  },
  {
    kind: "EXCESS_RECEIVED",
    label: "Excess received",
    defaultOwner: "Dispatching branch",
    detectedBy: "Hub inbound scan",
    priority: "NORMAL",
    escalateAfterMinutes: 1440,
  },
  {
    kind: "DAMAGED",
    label: "Damaged",
    defaultOwner: "Claims desk",
    detectedBy: "Any scan",
    priority: "HIGH",
    escalateAfterMinutes: 1440,
  },
  {
    kind: "POD_PENDING",
    label: "POD pending",
    defaultOwner: "Destination branch",
    detectedBy: "POD monitor",
    priority: "LOW",
    escalateAfterMinutes: 2880,
  },
  {
    kind: "HUB_DWELL",
    label: "Idle at hub",
    defaultOwner: "Hub in-charge",
    detectedBy: "Dwell monitor",
    priority: "NORMAL",
    escalateAfterMinutes: 720,
  },
  {
    kind: "COD_SHORTFALL",
    label: "COD shortfall",
    defaultOwner: "Branch accounts",
    detectedBy: "Settlement check",
    priority: "CRITICAL",
    escalateAfterMinutes: 480,
  },
  {
    kind: "CUSTOMER_COMPLAINT",
    label: "Customer complaint",
    defaultOwner: "Customer support",
    detectedBy: "Portal or support desk",
    priority: "NORMAL",
    escalateAfterMinutes: 240,
  },
  {
    kind: "DOCUMENT_EXPIRED",
    label: "Document expired",
    defaultOwner: "Transport desk",
    detectedBy: "Document monitor",
    priority: "HIGH",
    escalateAfterMinutes: 1440,
  },
  {
    kind: "OTHER",
    label: "Other",
    defaultOwner: "Duty manager",
    detectedBy: "Raised by hand",
    priority: "NORMAL",
    escalateAfterMinutes: 720,
  },
];

export const KIND_DEFS: Record<ExceptionKind, KindDef> = Object.fromEntries(
  DEFS.map((def) => [def.kind, def]),
) as Record<ExceptionKind, KindDef>;

export const KIND_ORDER: ExceptionKind[] = DEFS.map((def) => def.kind);

export function kindLabel(kind: ExceptionKind): string {
  return KIND_DEFS[kind]?.label ?? kind.replace(/_/g, " ").toLowerCase();
}

// ────────────────────────────────────────────────────────────
// Severity and ordering
// ────────────────────────────────────────────────────────────

export const PRIORITY_LABEL: Record<ExceptionPriority, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  NORMAL: "Normal",
  LOW: "Low",
};

export const PRIORITY_RANK: Record<ExceptionPriority, number> = {
  CRITICAL: 3,
  HIGH: 2,
  NORMAL: 1,
  LOW: 0,
};

export const PRIORITY_TONE: Record<ExceptionPriority, string> = {
  CRITICAL: "bg-bad-muted text-bad",
  HIGH: "bg-warn-muted text-warn",
  NORMAL: "bg-muted text-muted-foreground",
  LOW: "bg-muted text-muted-foreground",
};

export const STATUS_LABEL: Record<ExceptionStatus, string> = {
  OPEN: "Open",
  ACKNOWLEDGED: "Acknowledged",
  IN_PROGRESS: "In progress",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  DISMISSED: "Dismissed",
};

export const STATUS_TONE: Record<ExceptionStatus, string> = {
  OPEN: "bg-bad-muted text-bad",
  ACKNOWLEDGED: "bg-warn-muted text-warn",
  IN_PROGRESS: "bg-info-muted text-info",
  RESOLVED: "bg-ok-muted text-ok",
  CLOSED: "bg-ok-muted text-ok",
  DISMISSED: "bg-muted text-muted-foreground",
};

/** Statuses that still need somebody. The tower's default view. */
export const LIVE_STATUSES: ExceptionStatus[] = [
  "OPEN",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
];

export function isLive(status: ExceptionStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

// ────────────────────────────────────────────────────────────
// Transitions
// ────────────────────────────────────────────────────────────

export type ExceptionTransition = {
  to: ExceptionStatus;
  label: string;
  describe: string;
  /**
   * Nothing closes without a resolution note. An exception that vanishes
   * silently teaches everyone to ignore the tower, and the tower is only
   * worth having while people still read it.
   */
  requiresNote: boolean;
  permission: string;
};

const TRANSITIONS: Record<ExceptionStatus, ExceptionTransition[]> = {
  OPEN: [
    {
      to: "ACKNOWLEDGED",
      label: "Acknowledge",
      describe: "You have seen it and it is yours.",
      requiresNote: false,
      permission: "exception.assign",
    },
    {
      to: "IN_PROGRESS",
      label: "Start work",
      describe: "Something is being done about it right now.",
      requiresNote: false,
      permission: "exception.assign",
    },
    {
      to: "RESOLVED",
      label: "Resolve",
      describe: "Say what was done. This is what the next person reads.",
      requiresNote: true,
      permission: "exception.resolve",
    },
    {
      to: "DISMISSED",
      label: "Dismiss",
      describe: "Not a real problem. Say why, so the detector can be fixed.",
      requiresNote: true,
      permission: "exception.resolve",
    },
  ],
  ACKNOWLEDGED: [
    {
      to: "IN_PROGRESS",
      label: "Start work",
      describe: "Something is being done about it right now.",
      requiresNote: false,
      permission: "exception.assign",
    },
    {
      to: "RESOLVED",
      label: "Resolve",
      describe: "Say what was done. This is what the next person reads.",
      requiresNote: true,
      permission: "exception.resolve",
    },
    {
      to: "DISMISSED",
      label: "Dismiss",
      describe: "Not a real problem. Say why, so the detector can be fixed.",
      requiresNote: true,
      permission: "exception.resolve",
    },
  ],
  IN_PROGRESS: [
    {
      to: "RESOLVED",
      label: "Resolve",
      describe: "Say what was done. This is what the next person reads.",
      requiresNote: true,
      permission: "exception.resolve",
    },
    {
      to: "DISMISSED",
      label: "Dismiss",
      describe: "Not a real problem. Say why, so the detector can be fixed.",
      requiresNote: true,
      permission: "exception.resolve",
    },
  ],
  RESOLVED: [
    {
      to: "CLOSED",
      label: "Close",
      describe: "Signed off. No further action.",
      requiresNote: false,
      permission: "exception.resolve",
    },
    {
      to: "IN_PROGRESS",
      label: "Reopen",
      describe: "It came back, or the fix did not hold.",
      requiresNote: true,
      permission: "exception.resolve",
    },
  ],
  CLOSED: [
    {
      to: "IN_PROGRESS",
      label: "Reopen",
      describe: "It came back, or the fix did not hold.",
      requiresNote: true,
      permission: "exception.resolve",
    },
  ],
  DISMISSED: [
    {
      to: "OPEN",
      label: "Reopen",
      describe: "Dismissed too early.",
      requiresNote: true,
      permission: "exception.resolve",
    },
  ],
};

/** The transitions available from a status, filtered by what the user holds. */
export function transitionsFor(
  status: ExceptionStatus,
  permissions: ReadonlySet<string>,
): ExceptionTransition[] {
  return (TRANSITIONS[status] ?? []).filter((transition) =>
    permissions.has(transition.permission),
  );
}

export function transitionTo(
  status: ExceptionStatus,
  to: ExceptionStatus,
): ExceptionTransition | null {
  return (TRANSITIONS[status] ?? []).find((t) => t.to === to) ?? null;
}

// ────────────────────────────────────────────────────────────
// Sorting
// ────────────────────────────────────────────────────────────

export type Sortable = {
  priority: ExceptionPriority;
  detectedAt: Date;
};

/**
 * The duty manager's reading order: what is worst, then what has waited
 * longest. Sorting it any other way makes them do it themselves.
 */
export function bySeverityThenAge(a: Sortable, b: Sortable): number {
  return (
    PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
    a.detectedAt.getTime() - b.detectedAt.getTime()
  );
}

/** Minutes an exception has been open. Stops at resolution, not closure. */
export function ageMinutes(
  exception: { detectedAt: Date; resolvedAt?: Date | null },
  now: Date = new Date(),
): number {
  const end = exception.resolvedAt ?? now;
  return Math.max(
    0,
    Math.floor((end.getTime() - exception.detectedAt.getTime()) / 60_000),
  );
}
