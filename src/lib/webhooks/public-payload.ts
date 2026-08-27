/**
 * What is allowed to leave the building.
 *
 * One allowlist serves the public tracking endpoint, the partner shipment
 * lookup and every webhook body, because three separately maintained
 * projections is three chances to leak. Anything not named here does not
 * go out — the shape is built field by field rather than by spreading a
 * database row and deleting the awkward parts, which is the version that
 * quietly starts leaking again the next time a column is added.
 *
 * Never exposed: branch codes and names, vehicle and driver identity, the
 * staff member who handled it, freight, charges, tax and margin. A
 * consignee learning which of our drivers is late is our problem to
 * manage, not theirs to see; and a customer's rate is not their
 * competitor's business.
 */

export type PublicEvent = {
  status: string;
  eventType: string;
  occurredAt: string;
  /** City only. A branch code would name our network. */
  location: string | null;
  remarks: string | null;
};

export type PublicTracking = {
  lrNumber: string;
  status: string;
  statusUpdatedAt: string;
  mode: string;
  origin: string | null;
  destination: string | null;
  bookedAt: string;
  expectedDeliveryAt: string | null;
  deliveredAt: string | null;
  packageCount: number;
  isOnHold: boolean;
  attemptCount: number;
  events: PublicEvent[];
};

export type PartnerShipment = PublicTracking & {
  serviceCode: string;
  customerReference: string | null;
  paymentType: string;
  codAmount: string | null;
  consignor: { name: string; phone: string };
  consignee: { name: string; phone: string; pincode: string };
  chargeableWeight: string;
};

/** The `select` both readers use. Adding a column here is a deliberate act. */
export const PUBLIC_SHIPMENT_SELECT = {
  lrNumber: true,
  mode: true,
  currentStatus: true,
  statusUpdatedAt: true,
  bookedAt: true,
  expectedDeliveryAt: true,
  deliveredAt: true,
  packageCount: true,
  isOnHold: true,
  attemptCount: true,
  chargeableWeight: true,
  paymentType: true,
  codAmount: true,
  customerReference: true,
  consignorName: true,
  consignorPhone: true,
  consigneeName: true,
  consigneePhone: true,
  consigneePincode: true,
  serviceType: { select: { code: true } },
  originBranch: { select: { city: { select: { name: true } } } },
  destinationBranch: { select: { city: { select: { name: true } } } },
} as const;

// `payload` is deliberately absent: it carries whatever the emitting
// handler needed, which has included branch ids and reason codes.
export const PUBLIC_EVENT_SELECT = {
  eventType: true,
  occurredAt: true,
  remarks: true,
  resultingStatus: true,
  branch: { select: { city: { select: { name: true } } } },
} as const;

type SourceShipment = {
  lrNumber: string;
  mode: string;
  currentStatus: string;
  statusUpdatedAt: Date;
  bookedAt: Date;
  expectedDeliveryAt: Date | null;
  deliveredAt: Date | null;
  packageCount: number;
  isOnHold: boolean;
  attemptCount: number;
  chargeableWeight: { toString(): string };
  paymentType: string;
  codAmount: { toString(): string } | null;
  customerReference: string | null;
  consignorName: string;
  consignorPhone: string;
  consigneeName: string;
  consigneePhone: string;
  consigneePincode: string;
  serviceType: { code: string };
  originBranch: { city: { name: string } | null } | null;
  destinationBranch: { city: { name: string } | null } | null;
};

type SourceEvent = {
  eventType: string;
  occurredAt: Date;
  remarks: string | null;
  resultingStatus: string | null;
  branch: { city: { name: string } | null } | null;
};

/**
 * Middle digits removed.
 *
 * Enough for a partner to confirm they have the right consignment, not
 * enough for a scraped response to become a marketing list.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return "xxxxxx";
  return `${digits.slice(0, 2)}${"x".repeat(digits.length - 5)}${digits.slice(-3)}`;
}

export function toPublicEvent(event: SourceEvent): PublicEvent {
  return {
    status: event.resultingStatus ?? event.eventType,
    eventType: event.eventType,
    occurredAt: event.occurredAt.toISOString(),
    location: event.branch?.city?.name ?? null,
    remarks: event.remarks,
  };
}

export function toPublicTracking(
  shipment: SourceShipment,
  events: SourceEvent[] = [],
): PublicTracking {
  return {
    lrNumber: shipment.lrNumber,
    status: shipment.currentStatus,
    statusUpdatedAt: shipment.statusUpdatedAt.toISOString(),
    mode: shipment.mode,
    origin: shipment.originBranch?.city?.name ?? null,
    destination: shipment.destinationBranch?.city?.name ?? null,
    bookedAt: shipment.bookedAt.toISOString(),
    expectedDeliveryAt: shipment.expectedDeliveryAt?.toISOString() ?? null,
    deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
    packageCount: shipment.packageCount,
    isOnHold: shipment.isOnHold,
    attemptCount: shipment.attemptCount,
    events: events.map((event) => toPublicEvent(event)),
  };
}

/**
 * The partner view: the public payload plus the party details the partner
 * supplied in the first place. Still no branch, vehicle, driver, staff or
 * money that belongs to us rather than to them.
 */
export function toPartnerShipment(
  shipment: SourceShipment,
  events: SourceEvent[] = [],
): PartnerShipment {
  return {
    ...toPublicTracking(shipment, events),
    serviceCode: shipment.serviceType.code,
    customerReference: shipment.customerReference,
    paymentType: shipment.paymentType,
    codAmount: shipment.codAmount ? shipment.codAmount.toString() : null,
    chargeableWeight: shipment.chargeableWeight.toString(),
    consignor: {
      name: shipment.consignorName,
      phone: maskPhone(shipment.consignorPhone),
    },
    consignee: {
      name: shipment.consigneeName,
      phone: maskPhone(shipment.consigneePhone),
      pincode: shipment.consigneePincode,
    },
  };
}

/**
 * Keys that must never appear in an outbound body, at any depth.
 *
 * Asserted in the tests: a future contributor who spreads a Prisma row
 * into a response gets a failing test rather than a support incident.
 */
export const FORBIDDEN_OUTBOUND_KEYS: readonly string[] = [
  "branchId",
  "originBranchId",
  "destinationBranchId",
  "currentBranchId",
  "bookingBranchId",
  "branchCode",
  "vehicleId",
  "vehicleNumber",
  "driverId",
  "driverName",
  "tripId",
  "manifestId",
  "userId",
  "bookedById",
  "orgId",
  "consignorId",
  "customerId",
  "freightAmount",
  "chargesTotal",
  "taxAmount",
  "grandTotal",
  "declaredValue",
  "costAmount",
  "reasonCodeId",
  "deviceId",
];

/** Recursively looks for a forbidden key. Used by the leak test. */
export function findForbiddenKey(value: unknown, path = ""): string | null {
  if (value === null || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenKey(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_OUTBOUND_KEYS.includes(key)) return `${path}.${key}`;
    const found = findForbiddenKey(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

/**
 * The webhook body for one outbox event.
 *
 * The outbox payload carries internal fields — `branchId`, `reasonCodeId`,
 * the event's own id — because internal handlers need them. None of that
 * is forwarded: the webhook body is rebuilt from an allowlist, exactly
 * like the HTTP responses.
 */
export function toWebhookBody(event: {
  eventType: string;
  aggregate: string;
  aggregateId: string;
  payload: unknown;
}): Record<string, unknown> {
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};

  const data: Record<string, unknown> = {};

  if (event.aggregate === "Shipment") {
    if (typeof payload.lrNumber === "string") data.lrNumber = payload.lrNumber;
    if (typeof payload.currentStatus === "string") data.status = payload.currentStatus;
    if (typeof payload.previousStatus === "string") {
      data.previousStatus = payload.previousStatus;
    }
    if (typeof payload.eventType === "string") data.eventType = payload.eventType;
    if (typeof payload.occurredAt === "string") data.occurredAt = payload.occurredAt;
  }

  return {
    event: event.eventType,
    aggregate: event.aggregate,
    data,
    sentAt: new Date().toISOString(),
  };
}
