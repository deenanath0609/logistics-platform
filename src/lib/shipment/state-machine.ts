import type {
  ShipmentStatus,
  ShipmentEventType,
} from "@/generated/prisma/client";

/**
 * The shipment state machine.
 *
 * This module is the ONLY thing in the codebase permitted to decide what
 * `Shipment.currentStatus` becomes. Everything else appends an event and
 * lets the projection follow — see docs/BRD.html §A.1 and §B.4.
 *
 * Transitions are data, not control flow, so the rules can be read,
 * tested, and rendered as documentation without executing anything.
 */

export type TransitionContext = {
  currentStatus: ShipmentStatus;
  /** Branch the event happened at, if any. */
  branchId?: string | null;
  /** The shipment's destination — decides origin vs hub receipt. */
  destinationBranchId: string;
  originBranchId: string;
  attemptCount: number;
  maxDeliveryAttempts: number;
};

export type TransitionRule = {
  event: ShipmentEventType;
  /** Statuses this event may be applied from. Empty means "creation only". */
  from: ShipmentStatus[];
  /**
   * Resulting status. A function when the target depends on where the
   * event happened — an inbound scan means something different at the
   * origin branch than at a transshipment hub.
   *
   * Returning null means the event is recorded without moving the status,
   * which is the correct outcome for weighing, loading, and GPS pings.
   */
  to: ShipmentStatus | null | ((ctx: TransitionContext) => ShipmentStatus | null);
  /** Permission the actor must hold. */
  permission: string;
  /** Fields the event must carry, checked before anything is written. */
  requires?: Array<"branchId" | "userId" | "reasonCodeId" | "remarks" | "latitude">;
  /** One-line description used in the timeline UI and the audit trail. */
  describe: string;
};

const PRE_DISPATCH: ShipmentStatus[] = [
  "BOOKED",
  "PICKUP_ASSIGNED",
  "PICKED_UP",
  "RECEIVED_AT_ORIGIN",
  "PROCESSED",
  "MANIFESTED",
];

const IN_NETWORK: ShipmentStatus[] = [
  "PICKED_UP",
  "RECEIVED_AT_ORIGIN",
  "PROCESSED",
  "MANIFESTED",
  "DISPATCHED",
  "IN_TRANSIT",
  "ARRIVED_AT_HUB",
  "RECEIVED_AT_HUB",
  "ASSIGNED_FOR_DELIVERY",
  "OUT_FOR_DELIVERY",
];

export const TRANSITIONS: TransitionRule[] = [
  {
    event: "BOOKING_CREATED",
    from: [],
    to: "BOOKED",
    permission: "shipment.create",
    describe: "Booking created",
  },
  {
    event: "BOOKING_AMENDED",
    from: PRE_DISPATCH,
    to: null,
    permission: "shipment.update",
    describe: "Booking amended",
  },
  {
    event: "PICKUP_ASSIGNED",
    from: ["BOOKED", "PICKUP_ASSIGNED"],
    to: "PICKUP_ASSIGNED",
    permission: "pickup.assign",
    describe: "Assigned for pickup",
  },
  {
    event: "PICKUP_ATTEMPTED",
    from: ["PICKUP_ASSIGNED"],
    // Stays assigned. A failed attempt is history, not a status change —
    // the shipment is still owed a collection.
    to: null,
    permission: "pickup.execute",
    requires: ["reasonCodeId"],
    describe: "Pickup attempted",
  },
  {
    event: "PICKUP_COMPLETED",
    from: ["BOOKED", "PICKUP_ASSIGNED"],
    to: "PICKED_UP",
    permission: "pickup.execute",
    describe: "Picked up",
  },
  {
    event: "INBOUND_SCAN",
    from: ["BOOKED", "PICKED_UP", "DISPATCHED", "IN_TRANSIT", "ARRIVED_AT_HUB"],
    // The same physical act — a package scanned at a dock — means
    // "entered the network" at the origin and "arrived here" anywhere else.
    //
    // `BOOKED` is here because a great deal of freight never gets collected:
    // the consignor books and carries it to the counter themselves, which is
    // what "Needs pickup" being off on the booking form means. Without this
    // there was no way for such a consignment to enter the network at all —
    // the only routes out of `BOOKED` were the two pickup events, so the
    // branch had to raise a collection and complete it for a van that never
    // left the yard. That is a false record of who moved the goods, written
    // into an append-only log to work around a missing edge.
    to: (ctx) =>
      ctx.currentStatus === "PICKED_UP" || ctx.currentStatus === "BOOKED"
        ? "RECEIVED_AT_ORIGIN"
        : "RECEIVED_AT_HUB",
    permission: "scan.inbound",
    requires: ["branchId"],
    describe: "Received",
  },
  {
    event: "WEIGHT_CAPTURED",
    from: ["RECEIVED_AT_ORIGIN", "RECEIVED_AT_HUB", "PROCESSED"],
    to: null,
    permission: "weight.capture",
    requires: ["branchId"],
    describe: "Weight captured",
  },
  {
    event: "SORTED",
    from: ["RECEIVED_AT_ORIGIN", "RECEIVED_AT_HUB"],
    to: "PROCESSED",
    permission: "scan.sort",
    requires: ["branchId"],
    describe: "Sorted and routed",
  },
  {
    event: "MANIFEST_ADDED",
    from: ["PROCESSED"],
    to: "MANIFESTED",
    permission: "manifest.update",
    describe: "Added to manifest",
  },
  {
    event: "MANIFEST_REMOVED",
    from: ["MANIFESTED"],
    to: "PROCESSED",
    permission: "manifest.update",
    describe: "Removed from manifest",
  },
  {
    event: "LOADED",
    from: ["MANIFESTED"],
    to: null,
    permission: "loading.execute",
    describe: "Loaded onto vehicle",
  },
  {
    event: "GATE_OUT",
    from: ["MANIFESTED", "PROCESSED"],
    to: "DISPATCHED",
    permission: "trip.dispatch",
    describe: "Dispatched",
  },
  // The three the tracking pipeline writes. A crossing detected from GPS
  // carries `source: "GPS"` and is not permission-checked at all, so the
  // code below only ever governs a *human* posting one of these by hand —
  // which is a movement recorded against every consignment on the trip,
  // not a look at a map. `tracking.read` was the wrong measure of that: it
  // is in `allReads`, so MANAGEMENT ("read-only visibility of the whole
  // network") and CUSTOMER_SUPPORT both held it and could advance custody.
  // `trip.dispatch` is what the equivalent typed events — GATE_IN and
  // GATE_OUT — have always required.
  {
    event: "GEOFENCE_EXIT",
    from: ["DISPATCHED"],
    to: "IN_TRANSIT",
    permission: "trip.dispatch",
    describe: "In transit",
  },
  {
    event: "IN_TRANSIT_PING",
    from: ["DISPATCHED", "IN_TRANSIT"],
    to: "IN_TRANSIT",
    permission: "trip.dispatch",
    describe: "In transit",
  },
  {
    event: "GEOFENCE_ENTER",
    from: ["IN_TRANSIT", "DISPATCHED"],
    to: "ARRIVED_AT_HUB",
    permission: "trip.dispatch",
    describe: "Arrived",
  },
  {
    event: "GATE_IN",
    from: ["IN_TRANSIT", "DISPATCHED"],
    to: "ARRIVED_AT_HUB",
    permission: "trip.dispatch",
    requires: ["branchId"],
    describe: "Arrived",
  },
  {
    event: "UNLOADED",
    from: ["ARRIVED_AT_HUB", "RECEIVED_AT_HUB"],
    to: null,
    permission: "scan.inbound",
    requires: ["branchId"],
    describe: "Unloaded",
  },
  {
    event: "DISCREPANCY_RAISED",
    from: IN_NETWORK,
    to: null,
    permission: "receipt.close",
    requires: ["reasonCodeId"],
    describe: "Discrepancy raised",
  },
  {
    event: "DAMAGE_RECORDED",
    from: IN_NETWORK,
    to: null,
    permission: "damage.record",
    requires: ["reasonCodeId"],
    describe: "Damage recorded",
  },
  {
    event: "HELD",
    from: IN_NETWORK,
    to: null,
    permission: "shipment.hold",
    requires: ["reasonCodeId"],
    describe: "Placed on hold",
  },
  {
    event: "HOLD_RELEASED",
    from: IN_NETWORK,
    to: null,
    permission: "shipment.hold",
    describe: "Hold released",
  },
  {
    event: "DELIVERY_ASSIGNED",
    from: ["RECEIVED_AT_HUB", "ASSIGNED_FOR_DELIVERY"],
    to: "ASSIGNED_FOR_DELIVERY",
    permission: "delivery.assign",
    describe: "Assigned for delivery",
  },
  {
    event: "RUN_STARTED",
    from: ["ASSIGNED_FOR_DELIVERY"],
    to: "OUT_FOR_DELIVERY",
    permission: "delivery.execute",
    describe: "Out for delivery",
  },
  {
    event: "DELIVERY_ATTEMPTED",
    from: ["OUT_FOR_DELIVERY"],
    // Back to the branch, not to a "failed" status. The consignment is
    // physically at the hub again and owed another attempt; the failure
    // lives in its own attempt row and exception.
    to: "RECEIVED_AT_HUB",
    permission: "delivery.execute",
    requires: ["reasonCodeId"],
    describe: "Delivery attempted",
  },
  {
    event: "DELIVERED",
    from: ["OUT_FOR_DELIVERY"],
    to: "DELIVERED",
    permission: "delivery.execute",
    describe: "Delivered",
  },
  {
    event: "COD_COLLECTED",
    from: ["OUT_FOR_DELIVERY", "DELIVERED"],
    to: null,
    permission: "cod.collect",
    describe: "COD collected",
  },
  {
    event: "POD_SYNCED",
    from: ["DELIVERED", "POD_UPLOADED"],
    to: "POD_UPLOADED",
    permission: "delivery.execute",
    describe: "Proof of delivery uploaded",
  },
  {
    event: "CLOSED",
    from: ["POD_UPLOADED", "DELIVERED", "RTO_DELIVERED"],
    to: "CLOSED",
    permission: "shipment.update",
    describe: "Closed",
  },
  {
    event: "RTO_INITIATED",
    from: ["RECEIVED_AT_HUB", "ASSIGNED_FOR_DELIVERY", "OUT_FOR_DELIVERY"],
    to: "RTO_INITIATED",
    permission: "delivery.rto",
    requires: ["reasonCodeId"],
    describe: "Return to origin initiated",
  },
  {
    event: "CANCELLED",
    from: PRE_DISPATCH,
    to: "CANCELLED",
    permission: "shipment.cancel",
    requires: ["reasonCodeId"],
    describe: "Cancelled",
  },
  {
    event: "STATUS_CORRECTED",
    // Deliberately reachable from anywhere: the whole point is fixing a
    // state the normal rules cannot reach. Gated behind its own sensitive
    // permission and a mandatory reason.
    from: [],
    to: null,
    permission: "shipment.correct_status",
    requires: ["reasonCodeId", "remarks"],
    describe: "Status corrected",
  },
];

const BY_EVENT = new Map<ShipmentEventType, TransitionRule>(
  TRANSITIONS.map((rule) => [rule.event, rule]),
);

export const TERMINAL_STATUSES: ShipmentStatus[] = [
  "CLOSED",
  "CANCELLED",
  "LOST",
  "RTO_DELIVERED",
];

export function isTerminal(status: ShipmentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function ruleFor(event: ShipmentEventType): TransitionRule | undefined {
  return BY_EVENT.get(event);
}

export type TransitionResult =
  | { ok: true; nextStatus: ShipmentStatus | null; rule: TransitionRule }
  | { ok: false; reason: string; rule?: TransitionRule };

/**
 * Decides whether an event may be applied, and to what status it leads.
 *
 * Pure — no database, no clock, no permission lookup. The caller supplies
 * the context and enforces the permission, which makes every rule here
 * exhaustively testable.
 */
export function evaluateTransition(
  event: ShipmentEventType,
  ctx: TransitionContext,
  provided: {
    branchId?: string | null;
    userId?: string | null;
    reasonCodeId?: string | null;
    remarks?: string | null;
    latitude?: number | null;
  } = {},
  /** Target for STATUS_CORRECTED, which has no implicit destination. */
  correctedTo?: ShipmentStatus,
): TransitionResult {
  const rule = BY_EVENT.get(event);
  if (!rule) return { ok: false, reason: `Unknown event type "${event}"` };

  if (event === "BOOKING_CREATED") {
    return { ok: true, nextStatus: "BOOKED", rule };
  }

  if (event === "STATUS_CORRECTED") {
    const missing = missingFields(rule, provided);
    if (missing) return { ok: false, reason: missing, rule };
    if (!correctedTo) {
      return { ok: false, reason: "A corrected status must be specified", rule };
    }
    return { ok: true, nextStatus: correctedTo, rule };
  }

  if (isTerminal(ctx.currentStatus)) {
    return {
      ok: false,
      reason: `Shipment is ${humanise(ctx.currentStatus)} — no further events can be recorded. Use a status correction if this is wrong.`,
      rule,
    };
  }

  if (!rule.from.includes(ctx.currentStatus)) {
    return {
      ok: false,
      reason: `Cannot ${rule.describe.toLowerCase()} from ${humanise(ctx.currentStatus)}.`,
      rule,
    };
  }

  const missing = missingFields(rule, provided);
  if (missing) return { ok: false, reason: missing, rule };

  const nextStatus =
    typeof rule.to === "function" ? rule.to(ctx) : rule.to;

  return { ok: true, nextStatus, rule };
}

function missingFields(
  rule: TransitionRule,
  provided: Record<string, unknown>,
): string | null {
  for (const field of rule.requires ?? []) {
    const value = provided[field];
    if (value === undefined || value === null || value === "") {
      return `${LABELS[field]} is required to record "${rule.describe}".`;
    }
  }
  return null;
}

const LABELS: Record<string, string> = {
  branchId: "A branch",
  userId: "A user",
  reasonCodeId: "A reason",
  remarks: "Remarks",
  latitude: "Location",
};

export function humanise(status: ShipmentStatus): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ").toLowerCase();
}

export const STATUS_LABELS: Record<ShipmentStatus, string> = {
  BOOKED: "Booked",
  PICKUP_ASSIGNED: "Pickup assigned",
  PICKED_UP: "Picked up",
  RECEIVED_AT_ORIGIN: "Received at origin",
  PROCESSED: "Processed",
  MANIFESTED: "Manifested",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In transit",
  ARRIVED_AT_HUB: "Arrived at hub",
  RECEIVED_AT_HUB: "Received at hub",
  ASSIGNED_FOR_DELIVERY: "Assigned for delivery",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  POD_UPLOADED: "POD uploaded",
  CLOSED: "Closed",
  RTO_INITIATED: "RTO initiated",
  RTO_IN_TRANSIT: "RTO in transit",
  RTO_DELIVERED: "RTO delivered",
  LOST: "Lost",
  CANCELLED: "Cancelled",
};

/**
 * What the customer is told. Internal steps collapse — a consignee does
 * not need to know the difference between "sorted" and "manifested", and
 * exposing branch-level detail on a public tracking page leaks the
 * network's shape.
 */
export const CUSTOMER_STATUS_LABELS: Partial<Record<ShipmentStatus, string>> = {
  BOOKED: "Booked",
  PICKUP_ASSIGNED: "Pickup scheduled",
  PICKED_UP: "Picked up",
  RECEIVED_AT_ORIGIN: "In transit",
  PROCESSED: "In transit",
  MANIFESTED: "In transit",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In transit",
  ARRIVED_AT_HUB: "Reached destination city",
  RECEIVED_AT_HUB: "Reached destination city",
  ASSIGNED_FOR_DELIVERY: "Out for delivery soon",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  POD_UPLOADED: "Delivered",
  CLOSED: "Delivered",
  RTO_INITIATED: "Being returned to sender",
  RTO_IN_TRANSIT: "Being returned to sender",
  RTO_DELIVERED: "Returned to sender",
  CANCELLED: "Cancelled",
};

/** Groups used by dashboards and list filters. */
export const STATUS_GROUPS = {
  pending: ["BOOKED", "PICKUP_ASSIGNED"] as ShipmentStatus[],
  inNetwork: [
    "PICKED_UP",
    "RECEIVED_AT_ORIGIN",
    "PROCESSED",
    "MANIFESTED",
  ] as ShipmentStatus[],
  moving: ["DISPATCHED", "IN_TRANSIT", "ARRIVED_AT_HUB"] as ShipmentStatus[],
  lastMile: [
    "RECEIVED_AT_HUB",
    "ASSIGNED_FOR_DELIVERY",
    "OUT_FOR_DELIVERY",
  ] as ShipmentStatus[],
  done: ["DELIVERED", "POD_UPLOADED", "CLOSED"] as ShipmentStatus[],
  exception: [
    "RTO_INITIATED",
    "RTO_IN_TRANSIT",
    "RTO_DELIVERED",
    "LOST",
    "CANCELLED",
  ] as ShipmentStatus[],
};
