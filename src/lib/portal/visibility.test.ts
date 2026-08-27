import { describe, it, expect } from "vitest";
import type { ShipmentEventType, ShipmentStatus } from "@/generated/prisma/client";
import {
  CUSTOMER_STATUS_LABELS,
  STATUS_LABELS,
} from "@/lib/shipment/state-machine";
import {
  customerShipmentFilter,
  customerOwnedFilter,
  toPublicTimeline,
  toPublicTracking,
  toneFor,
  VisibilityError,
  type InternalEventLike,
} from "./visibility";

// Every status the enum has. Declared as a Record so a status added to the
// schema breaks this file at compile time rather than silently escaping the
// exhaustiveness checks below.
const ALL_STATUSES = Object.keys(STATUS_LABELS) as ShipmentStatus[];

const EVENT_TYPES = {
  BOOKING_CREATED: 1, BOOKING_AMENDED: 1, PICKUP_ASSIGNED: 1,
  PICKUP_ATTEMPTED: 1, PICKUP_COMPLETED: 1, INBOUND_SCAN: 1,
  WEIGHT_CAPTURED: 1, SORTED: 1, MANIFEST_ADDED: 1, MANIFEST_REMOVED: 1,
  LOADED: 1, GATE_OUT: 1, IN_TRANSIT_PING: 1, GEOFENCE_ENTER: 1,
  GEOFENCE_EXIT: 1, GATE_IN: 1, UNLOADED: 1, DISCREPANCY_RAISED: 1,
  DAMAGE_RECORDED: 1, HELD: 1, HOLD_RELEASED: 1, DELIVERY_ASSIGNED: 1,
  RUN_STARTED: 1, DELIVERY_ATTEMPTED: 1, DELIVERED: 1, COD_COLLECTED: 1,
  POD_SYNCED: 1, RTO_INITIATED: 1, CANCELLED: 1, CLOSED: 1,
  STATUS_CORRECTED: 1,
} satisfies Record<ShipmentEventType, 1>;

const ALL_EVENT_TYPES = Object.keys(EVENT_TYPES) as ShipmentEventType[];

function at(iso: string): Date {
  return new Date(iso);
}

function event(
  eventType: ShipmentEventType,
  occurredAt: string,
  resultingStatus: ShipmentStatus | null,
  cityName: string | null = null,
  extra: Record<string, unknown> = {},
): InternalEventLike {
  return { eventType, occurredAt: at(occurredAt), resultingStatus, cityName, ...extra };
}

// ────────────────────────────────────────────────────────────
// 1. Account scoping
// ────────────────────────────────────────────────────────────

describe("customerShipmentFilter", () => {
  it("pins every query to the session's own account", () => {
    const filter = customerShipmentFilter({
      customerId: "cust_alpha",
      visibleBranchIds: [],
    });

    expect(filter.consignorId).toBe("cust_alpha");
    expect(filter.deletedAt).toBeNull();
  });

  it("cannot return another customer's rows, for any pair of accounts", () => {
    const accounts = ["cust_a", "cust_b", "cust_c", "cust_d"];

    for (const mine of accounts) {
      for (const theirs of accounts.filter((id) => id !== mine)) {
        for (const branches of [[], ["br_1"], ["br_1", "br_2"]]) {
          const filter = customerShipmentFilter({
            customerId: mine,
            visibleBranchIds: branches,
          });

          // The only equality the filter permits is to my own account.
          expect(filter.consignorId).toBe(mine);
          expect(filter.consignorId).not.toBe(theirs);
          // …and no alternative branch of the query can reach around it,
          // because `consignorId` is a sibling of `OR`, not inside it.
          expect(JSON.stringify(filter)).not.toContain(theirs);
        }
      }
    }
  });

  it("keeps the account pinned even when a branch rule is present", () => {
    const filter = customerShipmentFilter({
      customerId: "cust_alpha",
      visibleBranchIds: ["br_plant", "br_depot"],
    });

    expect(filter.consignorId).toBe("cust_alpha");
    expect(filter.OR).toEqual([
      { bookingBranchId: { in: ["br_plant", "br_depot"] } },
      { originBranchId: { in: ["br_plant", "br_depot"] } },
    ]);
  });

  it("adds no branch rule when the login sees the whole account", () => {
    const filter = customerShipmentFilter({
      customerId: "cust_alpha",
      visibleBranchIds: [],
    });
    expect(filter.OR).toBeUndefined();
  });

  it("exposes exactly the keys it means to — nothing widens it later", () => {
    const wide = customerShipmentFilter({
      customerId: "cust_alpha",
      visibleBranchIds: [],
    });
    const scoped = customerShipmentFilter({
      customerId: "cust_alpha",
      visibleBranchIds: ["br_1"],
    });

    expect(Object.keys(wide).sort()).toEqual(["consignorId", "deletedAt"]);
    expect(Object.keys(scoped).sort()).toEqual([
      "OR",
      "consignorId",
      "deletedAt",
    ]);
  });

  it("refuses to build a filter with no account rather than matching everything", () => {
    expect(() =>
      customerShipmentFilter({ customerId: "", visibleBranchIds: [] }),
    ).toThrow(VisibilityError);

    expect(() =>
      customerShipmentFilter({ customerId: "   ", visibleBranchIds: [] }),
    ).toThrow(VisibilityError);

    expect(() =>
      customerOwnedFilter({ customerId: "", visibleBranchIds: [] }),
    ).toThrow(VisibilityError);
  });

  it("ignores blank branch ids instead of matching no rows at all", () => {
    const filter = customerShipmentFilter({
      customerId: "cust_alpha",
      visibleBranchIds: ["", "  "],
    });
    expect(filter.OR).toBeUndefined();
    expect(filter.consignorId).toBe("cust_alpha");
  });
});

// ────────────────────────────────────────────────────────────
// 2. The customer-facing timeline
// ────────────────────────────────────────────────────────────

describe("toPublicTimeline", () => {
  it("collapses internal handling steps into one 'In transit' line", () => {
    const milestones = toPublicTimeline(
      [
        event("BOOKING_CREATED", "2026-08-01T09:00:00Z", "BOOKED", "Delhi"),
        event("PICKUP_COMPLETED", "2026-08-01T14:00:00Z", "PICKED_UP", "Delhi"),
        event("INBOUND_SCAN", "2026-08-01T18:00:00Z", "RECEIVED_AT_ORIGIN", "Delhi"),
        event("WEIGHT_CAPTURED", "2026-08-01T18:10:00Z", null, "Delhi"),
        event("SORTED", "2026-08-01T19:00:00Z", "PROCESSED", "Delhi"),
        event("MANIFEST_ADDED", "2026-08-01T20:00:00Z", "MANIFESTED", "Delhi"),
        event("LOADED", "2026-08-01T21:00:00Z", null, "Delhi"),
        event("GATE_OUT", "2026-08-01T22:00:00Z", "DISPATCHED", "Delhi"),
      ],
      "DISPATCHED",
    );

    expect(milestones.map((m) => m.label)).toEqual([
      "Booked",
      "Picked up",
      "In transit",
      "Dispatched",
    ]);
  });

  it("never says 'sorted', 'manifested', 'processed' or 'received at'", () => {
    const milestones = toPublicTimeline(
      ALL_EVENT_TYPES.map((type, index) =>
        event(
          type,
          new Date(Date.UTC(2026, 7, 1, index)).toISOString(),
          ALL_STATUSES[index % ALL_STATUSES.length],
          "Delhi",
        ),
      ),
      "IN_TRANSIT",
    );

    const words = JSON.stringify(milestones).toLowerCase();
    for (const banned of [
      "sorted",
      "manifest",
      "processed",
      "received at origin",
      "received at hub",
      "arrived at hub",
      "assigned for delivery",
      "pod uploaded",
      "lost",
    ]) {
      expect(words).not.toContain(banned);
    }
  });

  it("keeps a genuine second city rather than collapsing real movement", () => {
    const milestones = toPublicTimeline(
      [
        event("GATE_OUT", "2026-08-01T22:00:00Z", "DISPATCHED", "Delhi"),
        event("IN_TRANSIT_PING", "2026-08-02T04:00:00Z", "IN_TRANSIT", "Delhi"),
        event("GATE_IN", "2026-08-02T10:00:00Z", "ARRIVED_AT_HUB", "Nagpur"),
        event("INBOUND_SCAN", "2026-08-02T11:00:00Z", "RECEIVED_AT_HUB", "Nagpur"),
      ],
      "RECEIVED_AT_HUB",
    );

    expect(milestones.map((m) => [m.label, m.city])).toEqual([
      ["Dispatched", "Delhi"],
      ["In transit", "Delhi"],
      ["Reached destination city", "Nagpur"],
    ]);
  });

  it("drops events that change nothing the customer can see", () => {
    const milestones = toPublicTimeline(
      [
        event("BOOKING_CREATED", "2026-08-01T09:00:00Z", "BOOKED", "Delhi"),
        event("WEIGHT_CAPTURED", "2026-08-01T10:00:00Z", null, "Delhi"),
        event("HELD", "2026-08-01T11:00:00Z", null, "Delhi"),
        event("DISCREPANCY_RAISED", "2026-08-01T12:00:00Z", null, "Delhi"),
        event("DAMAGE_RECORDED", "2026-08-01T13:00:00Z", null, "Delhi"),
        event("HOLD_RELEASED", "2026-08-01T14:00:00Z", null, "Delhi"),
        event("COD_COLLECTED", "2026-08-01T15:00:00Z", null, "Delhi"),
      ],
      "BOOKED",
    );

    expect(milestones).toHaveLength(1);
    expect(milestones[0].label).toBe("Booked");
  });

  it("never produces a line for a lost consignment", () => {
    const milestones = toPublicTimeline(
      [
        event("BOOKING_CREATED", "2026-08-01T09:00:00Z", "BOOKED", "Delhi"),
        event("STATUS_CORRECTED", "2026-08-05T09:00:00Z", "LOST", "Delhi"),
      ],
      "LOST",
    );

    expect(milestones.map((m) => m.label)).toEqual(["Booked"]);
  });

  it("reports a failed delivery without the reason behind it", () => {
    const milestones = toPublicTimeline(
      [
        event("RUN_STARTED", "2026-08-03T08:00:00Z", "OUT_FOR_DELIVERY", "Jaipur"),
        event("DELIVERY_ATTEMPTED", "2026-08-03T13:00:00Z", "RECEIVED_AT_HUB", "Jaipur", {
          reasonCode: { code: "DF-CLOSED", name: "Premises closed" },
          remarks: "Guard says the factory shuts on Wednesdays",
          user: { name: "Ramesh Yadav" },
        }),
      ],
      "RECEIVED_AT_HUB",
    );

    // The consignment is back at the local facility owed another visit,
    // which is the truth and is what the customer needs. Why it failed is
    // an internal exception note and stays behind.
    expect(milestones.map((m) => m.label)).toEqual([
      "Out for delivery",
      "Delivery attempted",
      "Reached destination city",
    ]);

    const payload = JSON.stringify(milestones);
    expect(payload).not.toContain("DF-CLOSED");
    expect(payload).not.toContain("Premises closed");
    expect(payload).not.toContain("Ramesh Yadav");
    expect(payload).not.toContain("Wednesdays");
  });

  it("sorts by when things happened, not by the order they synced", () => {
    const milestones = toPublicTimeline(
      [
        event("PICKUP_COMPLETED", "2026-08-01T14:00:00Z", "PICKED_UP", "Delhi"),
        event("BOOKING_CREATED", "2026-08-01T09:00:00Z", "BOOKED", "Delhi"),
      ],
      "PICKED_UP",
    );

    expect(milestones.map((m) => m.label)).toEqual(["Booked", "Picked up"]);
  });

  it("shows where the shipment actually is after a status correction", () => {
    const milestones = toPublicTimeline(
      [event("BOOKING_CREATED", "2026-08-01T09:00:00Z", "BOOKED", "Delhi")],
      "DELIVERED",
      at("2026-08-04T10:00:00Z"),
    );

    expect(milestones.map((m) => m.label)).toEqual(["Booked", "Delivered"]);
    expect(milestones[1].at).toBe("2026-08-04T10:00:00.000Z");
    expect(milestones[1].city).toBeNull();
  });

  it("returns nothing at all for a shipment with no events", () => {
    expect(toPublicTimeline([], "BOOKED")).toEqual([]);
  });

  it("handles every status in the enum without throwing", () => {
    for (const status of ALL_STATUSES) {
      const milestones = toPublicTimeline(
        [event("BOOKING_CREATED", "2026-08-01T09:00:00Z", status, "Delhi")],
        status,
        at("2026-08-01T09:00:00Z"),
      );
      expect(Array.isArray(milestones)).toBe(true);
      for (const milestone of milestones) {
        expect(Object.keys(milestone).sort()).toEqual(["at", "city", "key", "label"]);
      }
    }
  });

  it("labels only statuses the customer is meant to be told about", () => {
    const unlabelled = ALL_STATUSES.filter((s) => !CUSTOMER_STATUS_LABELS[s]);
    // LOST is deliberately absent: a claim is a conversation, not a
    // tracking line. Anything else appearing here is a bug in the map.
    expect(unlabelled).toEqual(["LOST"]);
  });
});

describe("toneFor", () => {
  it("gives every status a tone", () => {
    for (const status of ALL_STATUSES) {
      expect(["pending", "moving", "done", "exception"]).toContain(
        toneFor(status),
      );
    }
  });

  it("reads delivery as done and RTO as an exception", () => {
    expect(toneFor("DELIVERED")).toBe("done");
    expect(toneFor("CLOSED")).toBe("done");
    expect(toneFor("RTO_INITIATED")).toBe("exception");
    expect(toneFor("CANCELLED")).toBe("exception");
    expect(toneFor("IN_TRANSIT")).toBe("moving");
    expect(toneFor("BOOKED")).toBe("pending");
  });
});

// ────────────────────────────────────────────────────────────
// 3. The leak test
// ────────────────────────────────────────────────────────────

/**
 * Every string here is something a public tracking page must never carry.
 * The values are distinctive so a substring scan over the whole payload is
 * a real assertion rather than a formality.
 */
const SECRETS = {
  branchName: "Okhla Phase II Hub",
  branchCode: "HUB-DEL-OKH",
  vehicleNumber: "DL01AB4477",
  driverName: "Sukhwinder Singh",
  agentName: "Ramesh Yadav",
  staffName: "Priya Menon",
  bookingClerk: "Anil Bhatt",
  reasonCode: "DF-CLOSED",
  reasonName: "Premises closed",
  internalRemark: "Consignee disputes the weight, hold billing",
  exceptionNote: "Carton 3 crushed at the Okhla dock, do not tell the customer",
  freightAmount: "18450.00",
  codAmount: "96000.00",
  declaredValue: "245000.00",
  grandTotal: "21771.00",
  consigneePhone: "9812345678",
  consignorPhone: "9988776655",
  consigneeAddress: "Plot 44, Sitapura Industrial Area",
  manifestNumber: "MFT-DEL-0099",
  tripNumber: "TRP-DEL-0042",
  deviceId: "SCANNER-OKH-07",
  latitude: "28.5355123",
  longitude: "77.3910456",
  internalStatus: "MANIFESTED",
} as const;

function internalShipment() {
  return {
    // Public-facing
    lrNumber: "CL2608250001",
    currentStatus: "OUT_FOR_DELIVERY" as ShipmentStatus,
    statusUpdatedAt: at("2026-08-04T08:00:00Z"),
    packageCount: 3,
    bookedAt: at("2026-08-01T09:00:00Z"),
    expectedDeliveryAt: at("2026-08-05T18:00:00Z"),
    deliveredAt: null,
    customerReference: "PO-2026-8891",
    fromCity: "Delhi",
    toCity: "Jaipur",

    // Everything below is internal and must not survive the projection.
    orgId: "org_1",
    bookingBranchId: "br_1",
    originBranch: { code: SECRETS.branchCode, name: SECRETS.branchName },
    destinationBranch: { code: "HUB-JAI", name: "Sitapura Depot" },
    currentBranch: { code: SECRETS.branchCode, name: SECRETS.branchName },
    bookedBy: { name: SECRETS.bookingClerk },
    consignorName: "Kalyan Textiles",
    consignorPhone: SECRETS.consignorPhone,
    consigneeName: "Sitapura Weaves",
    consigneePhone: SECRETS.consigneePhone,
    consigneeAddress: SECRETS.consigneeAddress,
    freightAmount: SECRETS.freightAmount,
    chargesTotal: SECRETS.freightAmount,
    grandTotal: SECRETS.grandTotal,
    codAmount: SECRETS.codAmount,
    declaredValue: SECRETS.declaredValue,
    specialInstructions: SECRETS.internalRemark,
    holdReason: { code: SECRETS.reasonCode, name: SECRETS.reasonName },
    charges: [{ chargeType: { name: "Fuel surcharge" }, amount: SECRETS.freightAmount }],
  };
}

function internalEvents(): InternalEventLike[] {
  return [
    event("BOOKING_CREATED", "2026-08-01T09:00:00Z", "BOOKED", "Delhi", {
      branch: { code: SECRETS.branchCode, name: SECRETS.branchName },
      user: { name: SECRETS.bookingClerk },
      payload: { grandTotal: SECRETS.grandTotal, paymentType: "COD" },
    }),
    event("PICKUP_COMPLETED", "2026-08-01T14:00:00Z", "PICKED_UP", "Delhi", {
      user: { name: SECRETS.staffName },
      deviceId: SECRETS.deviceId,
      latitude: SECRETS.latitude,
      longitude: SECRETS.longitude,
    }),
    event("SORTED", "2026-08-01T19:00:00Z", "PROCESSED", "Delhi", {
      branch: { code: SECRETS.branchCode, name: SECRETS.branchName },
      remarks: SECRETS.internalRemark,
    }),
    event("MANIFEST_ADDED", "2026-08-01T20:00:00Z", "MANIFESTED", "Delhi", {
      manifestId: SECRETS.manifestNumber,
      payload: { manifestNumber: SECRETS.manifestNumber },
    }),
    event("GATE_OUT", "2026-08-01T22:00:00Z", "DISPATCHED", "Delhi", {
      vehicleId: SECRETS.vehicleNumber,
      tripId: SECRETS.tripNumber,
      payload: { vehicleNumber: SECRETS.vehicleNumber, driver: SECRETS.driverName },
    }),
    event("DAMAGE_RECORDED", "2026-08-02T06:00:00Z", null, "Nagpur", {
      reasonCode: { code: "DM-CRUSH", name: "Crushed in transit" },
      remarks: SECRETS.exceptionNote,
    }),
    event("GATE_IN", "2026-08-03T10:00:00Z", "ARRIVED_AT_HUB", "Jaipur", {
      branch: { code: "HUB-JAI", name: "Sitapura Depot" },
      user: { name: SECRETS.staffName },
    }),
    event("RUN_STARTED", "2026-08-04T08:00:00Z", "OUT_FOR_DELIVERY", "Jaipur", {
      user: { name: SECRETS.agentName },
      payload: { agentName: SECRETS.agentName, runNumber: "RUN-JAI-0031" },
    }),
  ];
}

describe("toPublicTracking — the leak test", () => {
  const tracking = toPublicTracking(internalShipment(), internalEvents());
  const payload = JSON.stringify(tracking);

  it("carries the milestones a consignee is entitled to", () => {
    expect(tracking.lrNumber).toBe("CL2608250001");
    expect(tracking.fromCity).toBe("Delhi");
    expect(tracking.toCity).toBe("Jaipur");
    expect(tracking.status).toBe("Out for delivery");
    expect(tracking.tone).toBe("moving");
    expect(tracking.milestones.map((m) => m.label)).toEqual([
      "Booked",
      "Picked up",
      "In transit",
      "Dispatched",
      "Reached destination city",
      "Out for delivery",
    ]);
  });

  it.each(Object.entries(SECRETS))(
    "never exposes %s",
    (_name, secret) => {
      expect(payload).not.toContain(secret);
    },
  );

  it("exposes no key beyond the ones it declares", () => {
    expect(Object.keys(tracking).sort()).toEqual([
      "bookedAt",
      "deliveredAt",
      "expectedDeliveryAt",
      "fromCity",
      "isDelivered",
      "lrNumber",
      "milestones",
      "packageCount",
      "reference",
      "status",
      "toCity",
      "tone",
    ]);

    for (const milestone of tracking.milestones) {
      expect(Object.keys(milestone).sort()).toEqual(["at", "city", "key", "label"]);
    }
  });

  it("leaks nothing when the whole internal row is handed straight in", () => {
    // The paranoid case: a future caller forgets to pick columns and
    // passes the Prisma row. The projection must still hold.
    const raw = {
      ...internalShipment(),
      everythingElse: SECRETS,
    };
    const scan = JSON.stringify(toPublicTracking(raw, internalEvents()));

    for (const secret of Object.values(SECRETS)) {
      expect(scan).not.toContain(secret);
    }
  });

  it("keeps the customer's own reference, which is not internal data", () => {
    expect(tracking.reference).toBe("PO-2026-8891");
  });
});
