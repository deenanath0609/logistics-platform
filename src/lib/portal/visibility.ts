import type { Prisma, ShipmentEventType, ShipmentStatus } from "@/generated/prisma/client";
import {
  CUSTOMER_STATUS_LABELS,
  STATUS_GROUPS,
} from "@/lib/shipment/state-machine";

/**
 * What a customer is allowed to see, decided in one pure module.
 *
 * Two jobs, both of them security boundaries rather than display choices:
 *
 *  1. `customerShipmentFilter` — the `where` fragment that pins every
 *     portal query to one account. Nothing in the portal queries shipments
 *     without it.
 *
 *  2. `toPublicTimeline` / `toPublicTracking` — the projection from the
 *     internal record to the consignee-facing one. Everything internal is
 *     dropped by *construction*: the return values are object literals with
 *     a fixed set of keys, so a column added to `Shipment` next year cannot
 *     appear on the public tracking page by accident.
 *
 * No database, no clock, no session lookup — which is what makes
 * visibility.test.ts able to prove both properties exhaustively.
 *
 * docs/BRD.html §A.14: milestones with "dates and city names only.
 * Internal branch names, vehicle numbers, driver identities, cost data,
 * and internal exception notes are never exposed."
 */

// ────────────────────────────────────────────────────────────
// 1. Account scoping
// ────────────────────────────────────────────────────────────

/**
 * The parts of a portal session that decide visibility. Structural rather
 * than the whole `CustomerSession`, so the rules can be tested without
 * building an auth session.
 */
export type CustomerVisibility = {
  customerId: string;
  /**
   * Branches of their own account this login may see. Empty means the
   * whole account — never "no branches", and never "every branch in the
   * network", which is the same word meaning three different things if it
   * is not written down.
   */
  visibleBranchIds: string[];
};

export class VisibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisibilityError";
  }
}

/**
 * A Prisma `where` fragment restricting shipments to one customer account.
 *
 * The customer is the consignor: they booked it, they pay for it, and they
 * are the only party the platform has authenticated. A consignee tracks by
 * LR on the public page instead.
 *
 * `consignorId` is written last and unconditionally, so no branch rule or
 * caller-supplied extra can widen it. An empty `customerId` throws rather
 * than producing a filter that matches the whole table.
 */
export function customerShipmentFilter(
  session: CustomerVisibility,
): Prisma.ShipmentWhereInput {
  const customerId = session.customerId?.trim();
  if (!customerId) {
    throw new VisibilityError(
      "A portal shipment query needs an account. Refusing to build an unscoped filter.",
    );
  }

  const branchIds = session.visibleBranchIds.filter((id) => id.trim().length > 0);

  const branchRule: Prisma.ShipmentWhereInput =
    branchIds.length > 0
      ? {
          // A plant manager sees what their plant sent, not the group's
          // whole traffic.
          OR: [
            { bookingBranchId: { in: branchIds } },
            { originBranchId: { in: branchIds } },
          ],
        }
      : {};

  return {
    ...branchRule,
    deletedAt: null,
    consignorId: customerId,
  };
}

/**
 * The same rule for any model that hangs directly off the account —
 * addresses, pickup requests, sub-users.
 */
export function customerOwnedFilter(session: CustomerVisibility): {
  customerId: string;
} {
  const customerId = session.customerId?.trim();
  if (!customerId) {
    throw new VisibilityError(
      "A portal query needs an account. Refusing to build an unscoped filter.",
    );
  }
  return { customerId };
}

// ────────────────────────────────────────────────────────────
// 2. The public projection
// ────────────────────────────────────────────────────────────

/**
 * Accepts an internal event row as it comes out of Prisma — relations,
 * remarks, reason codes and all — precisely so that handing the raw row to
 * this function is safe. Everything not named in `PublicMilestone` is
 * dropped.
 *
 * `cityName` is resolved by the caller from the event's branch. The branch
 * itself never travels: a city is public geography, a branch code is the
 * shape of the network.
 */
export type InternalEventLike = {
  eventType: ShipmentEventType;
  occurredAt: Date;
  resultingStatus: ShipmentStatus | null;
  /** City the event happened in. Null when the event carried no branch. */
  cityName?: string | null;
  [extra: string]: unknown;
};

export type PublicMilestone = {
  /** Stable list key. Derived from label and time, never from a row id. */
  key: string;
  label: string;
  /** ISO 8601. A plain string cannot smuggle a relation or a Decimal. */
  at: string;
  city: string | null;
};

/**
 * A handful of events deserve a line of their own even though their
 * resulting status says something else — a failed delivery attempt returns
 * the consignment to the hub, and "Reached destination city" is not what
 * happened. The reason code behind the failure is deliberately not carried
 * across; that is an internal exception note.
 */
const CUSTOMER_EVENT_LABELS: Partial<Record<ShipmentEventType, string>> = {
  PICKUP_ATTEMPTED: "Pickup attempted",
  DELIVERY_ATTEMPTED: "Delivery attempted",
};

function labelFor(event: InternalEventLike): string | null {
  const override = CUSTOMER_EVENT_LABELS[event.eventType];
  if (override) return override;
  if (!event.resultingStatus) return null;
  // Statuses with no customer label — LOST — produce no line at all. An
  // automated tracker is not how someone learns their goods are gone.
  return CUSTOMER_STATUS_LABELS[event.resultingStatus] ?? null;
}

/**
 * Collapses the internal event log into the milestone list a consignee
 * sees.
 *
 * Internal steps disappear on their own: sorting, manifesting and loading
 * all map to "In transit" through `CUSTOMER_STATUS_LABELS`, and a run of
 * the same label in the same city becomes one line. Weighing, holds,
 * discrepancies and damage records change no status and carry no customer
 * label, so they never appear.
 */
export function toPublicTimeline(
  events: readonly InternalEventLike[],
  status: ShipmentStatus,
  /** Falls back to the last event when the status was reached by correction. */
  statusUpdatedAt?: Date,
): PublicMilestone[] {
  const ordered = [...events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );

  const milestones: PublicMilestone[] = [];

  for (const event of ordered) {
    const label = labelFor(event);
    if (!label) continue;

    const city = normaliseCity(event.cityName);
    const previous = milestones.at(-1);

    // Same thing, same place, twice — one line. A genuine second city
    // survives, because "In transit · Nagpur" after "In transit · Delhi"
    // is real movement rather than an internal step.
    if (previous && previous.label === label && previous.city === city) continue;

    milestones.push({
      key: `${label}|${event.occurredAt.toISOString()}`,
      label,
      at: event.occurredAt.toISOString(),
      city,
    });
  }

  // A status correction moves the shipment without an event the customer
  // can see. Show where it actually is rather than where the log stopped.
  const currentLabel = CUSTOMER_STATUS_LABELS[status];
  const last = milestones.at(-1);

  if (currentLabel && (!last || last.label !== currentLabel)) {
    const at = statusUpdatedAt ?? ordered.at(-1)?.occurredAt;
    if (at) {
      milestones.push({
        key: `${currentLabel}|${at.toISOString()}`,
        label: currentLabel,
        at: at.toISOString(),
        city: null,
      });
    }
  }

  return milestones;
}

function normaliseCity(city: unknown): string | null {
  return typeof city === "string" && city.trim().length > 0 ? city.trim() : null;
}

// ────────────────────────────────────────────────────────────
// 3. The whole public payload
// ────────────────────────────────────────────────────────────

/** Coarse tone for the status pill. The raw status never leaves the server. */
export type PublicTone = "pending" | "moving" | "done" | "exception";

export function toneFor(status: ShipmentStatus): PublicTone {
  if (STATUS_GROUPS.done.includes(status)) return "done";
  if (STATUS_GROUPS.exception.includes(status)) return "exception";
  if (
    STATUS_GROUPS.pending.includes(status) ||
    STATUS_GROUPS.inNetwork.includes(status)
  ) {
    return "pending";
  }
  return "moving";
}

/**
 * The internal shipment as Prisma hands it over. Permissive on purpose:
 * the projection below must be safe even when the caller passes the entire
 * row, relations included.
 */
export type InternalShipmentLike = {
  lrNumber: string;
  currentStatus: ShipmentStatus;
  statusUpdatedAt?: Date | null;
  packageCount: number;
  bookedAt: Date;
  expectedDeliveryAt?: Date | null;
  deliveredAt?: Date | null;
  customerReference?: string | null;
  /** Cities, resolved by the caller. Branches never travel. */
  fromCity?: string | null;
  toCity?: string | null;
  [extra: string]: unknown;
};

/**
 * Everything the public tracking page is allowed to know.
 *
 * Absent by construction and asserted absent in visibility.test.ts:
 * branch names and codes, vehicle numbers, driver and agent identities,
 * staff names, freight, charges, COD and declared value, internal remarks,
 * reason codes and exception notes, consignor and consignee contact
 * details, and the raw internal status.
 */
export type PublicTracking = {
  lrNumber: string;
  reference: string | null;
  fromCity: string | null;
  toCity: string | null;
  status: string;
  tone: PublicTone;
  packageCount: number;
  bookedAt: string;
  expectedDeliveryAt: string | null;
  deliveredAt: string | null;
  isDelivered: boolean;
  milestones: PublicMilestone[];
};

export function toPublicTracking(
  shipment: InternalShipmentLike,
  events: readonly InternalEventLike[],
): PublicTracking {
  const status = shipment.currentStatus;

  return {
    lrNumber: shipment.lrNumber,
    // The customer's own purchase-order reference, echoed back so a
    // multi-LR lookup is readable. Not internal data.
    reference: nullableText(shipment.customerReference),
    fromCity: normaliseCity(shipment.fromCity),
    toCity: normaliseCity(shipment.toCity),
    status: CUSTOMER_STATUS_LABELS[status] ?? "In progress",
    tone: toneFor(status),
    packageCount: Number(shipment.packageCount) || 0,
    bookedAt: shipment.bookedAt.toISOString(),
    expectedDeliveryAt: shipment.expectedDeliveryAt?.toISOString() ?? null,
    deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
    isDelivered: STATUS_GROUPS.done.includes(status),
    milestones: toPublicTimeline(
      events,
      status,
      shipment.statusUpdatedAt ?? undefined,
    ),
  };
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
