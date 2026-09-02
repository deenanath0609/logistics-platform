import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_OUTBOUND_KEYS,
  PUBLIC_EVENT_SELECT,
  PUBLIC_SHIPMENT_SELECT,
  findForbiddenKey,
  toPartnerShipment,
  toPublicEvent,
  toPublicTracking,
  toWebhookBody,
} from "./public-payload";

/**
 * ── Why this file exists next to `signature.test.ts` ────────────────────
 *
 * That file already asserts `findForbiddenKey(toPublicTracking(SHIPMENT))`
 * is null, and it passes — but not for the reason it reads as. Its
 * `SHIPMENT` fixture is built from the *allowlist*: it has no `branchId`,
 * no `driverId`, no `freightAmount`, no `grandTotal`. So the assertion is
 * asking whether a clean object stayed clean. Rewrite `toPublicTracking`
 * as `return { ...shipment }` and every one of those tests still passes,
 * including `expect(serialised).not.toContain("freight")` — there is no
 * freight in the fixture to find.
 *
 * The leak this module exists to stop is a Prisma row reaching the
 * projection with more on it than the allowlist asked for: a `findUnique`
 * written without a `select`, an `include` added for a new screen, a
 * column added to `PUBLIC_SHIPMENT_SELECT` in passing. So the fixtures
 * here are deliberately *dirty* — they carry every forbidden field a real
 * row would — and the assertions are that those specific values do not
 * come out the other side. A spread would fail all of them.
 *
 * The second half asks the question no test asked at all: the projection
 * is only as narrow as the `select` that feeds it, and
 * `PUBLIC_SHIPMENT_SELECT` / `PUBLIC_EVENT_SELECT` were named by nothing
 * outside the route handlers.
 */

/** Values that must never appear in an outbound body, whatever the key. */
const SENTINEL = {
  branch: "br_LEAK_9f3",
  vehicle: "DL01AB1111",
  driver: "drv_LEAK_7c2",
  staff: "usr_LEAK_4a8",
  freight: "18450.00",
  grandTotal: "21771.00",
  declaredValue: "250000.00",
  reasonCode: "rc_LEAK_1b6",
  org: "org_LEAK_2e5",
} as const;

/**
 * A shipment row as it arrives from a `findUnique` with no `select` — the
 * shape a future contributor will hand this module by accident.
 */
const DIRTY_SHIPMENT = {
  // The allowlisted half.
  lrNumber: "CL/DEL/2627/000431",
  mode: "PTL",
  currentStatus: "IN_TRANSIT",
  statusUpdatedAt: new Date("2026-08-26T09:15:00Z"),
  bookedAt: new Date("2026-08-25T11:00:00Z"),
  expectedDeliveryAt: new Date("2026-08-28T18:00:00Z"),
  deliveredAt: null,
  packageCount: 3,
  isOnHold: false,
  attemptCount: 0,
  chargeableWeight: { toString: () => "48.500" },
  paymentType: "TOPAY",
  codAmount: { toString: () => "4500.00" },
  customerReference: "SO-2026-00184",
  consignorName: "Ramesh Traders",
  consignorPhone: "9876543210",
  consigneeName: "Sharma Distributors",
  consigneePhone: "9812345670",
  consigneePincode: "302001",
  serviceType: { code: "PTL-STD" },
  originBranch: { city: { name: "Delhi" } },
  destinationBranch: { city: { name: "Jaipur" } },

  // Everything a real row also carries, and none of it is ours to publish.
  id: "shp_LEAK_0a1",
  orgId: SENTINEL.org,
  originBranchId: SENTINEL.branch,
  destinationBranchId: SENTINEL.branch,
  currentBranchId: SENTINEL.branch,
  bookingBranchId: SENTINEL.branch,
  branchCode: "HO-DEL",
  vehicleId: "veh_LEAK_5d9",
  vehicleNumber: SENTINEL.vehicle,
  driverId: SENTINEL.driver,
  driverName: "Ramesh Kumar",
  tripId: "trp_LEAK_3f7",
  manifestId: "mnf_LEAK_8b4",
  bookedById: SENTINEL.staff,
  userId: SENTINEL.staff,
  consignorId: "cus_LEAK_6c3",
  customerId: "cus_LEAK_6c3",
  freightAmount: SENTINEL.freight,
  chargesTotal: "1200.00",
  taxAmount: "2121.00",
  grandTotal: SENTINEL.grandTotal,
  declaredValue: SENTINEL.declaredValue,
  costAmount: "14000.00",
  deviceId: "dev_LEAK_2a9",
};

const DIRTY_EVENTS = [
  {
    eventType: "GATE_OUT",
    occurredAt: new Date("2026-08-26T09:15:00Z"),
    remarks: "Loaded",
    resultingStatus: "IN_TRANSIT",
    branch: { city: { name: "Delhi" } },
    // The internal half of an event row.
    id: "evt_LEAK_1a1",
    branchId: SENTINEL.branch,
    vehicleId: "veh_LEAK_5d9",
    driverId: SENTINEL.driver,
    userId: SENTINEL.staff,
    reasonCodeId: SENTINEL.reasonCode,
    payload: { branchId: SENTINEL.branch, driverName: "Ramesh Kumar" },
  },
];

const sentinels = Object.values(SENTINEL);

function assertNoSentinel(payload: unknown, label: string) {
  const serialised = JSON.stringify(payload);
  for (const value of sentinels) {
    expect(serialised, `${label} published ${value}`).not.toContain(value);
  }
  expect(findForbiddenKey(payload), label).toBeNull();
}

// ── the projections, given a row that has everything ────────────────────

describe("toPublicTracking, handed a full database row", () => {
  const payload = toPublicTracking(
    DIRTY_SHIPMENT as never,
    DIRTY_EVENTS as never,
  );

  it("drops every internal field rather than carrying it through", () => {
    assertNoSentinel(payload, "public tracking");
  });

  it("returns exactly the agreed keys and nothing that arrived alongside", () => {
    expect(Object.keys(payload).sort()).toEqual(
      [
        "attemptCount",
        "bookedAt",
        "deliveredAt",
        "destination",
        "events",
        "expectedDeliveryAt",
        "isOnHold",
        "lrNumber",
        "mode",
        "origin",
        "packageCount",
        "status",
        "statusUpdatedAt",
      ].sort(),
    );
  });

  it("still says nothing about money, even on a COD consignment", () => {
    // The old fixture had `codAmount: null`, so "carries no money" held
    // whatever the code did. This one is TOPAY with ₹4,500 on it.
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain("4500");
    expect(serialised).not.toContain("codAmount");
    expect(serialised).not.toContain("TOPAY");
  });

  it("names the city and never the branch behind it", () => {
    expect(payload.origin).toBe("Delhi");
    expect(payload.destination).toBe("Jaipur");
    expect(JSON.stringify(payload)).not.toContain("HO-DEL");
  });
});

describe("toPublicEvent", () => {
  it("keeps the event to five fields and forgets the payload", () => {
    const event = toPublicEvent(DIRTY_EVENTS[0] as never);

    expect(Object.keys(event).sort()).toEqual(
      ["eventType", "location", "occurredAt", "remarks", "status"].sort(),
    );
    assertNoSentinel(event, "public event");
  });

  it("falls back to the event type when no status resulted", () => {
    const event = toPublicEvent({
      ...DIRTY_EVENTS[0],
      resultingStatus: null,
    } as never);

    expect(event.status).toBe("GATE_OUT");
  });

  it("reports no location rather than guessing when the branch has no city", () => {
    expect(
      toPublicEvent({ ...DIRTY_EVENTS[0], branch: null } as never).location,
    ).toBeNull();
    expect(
      toPublicEvent({ ...DIRTY_EVENTS[0], branch: { city: null } } as never)
        .location,
    ).toBeNull();
  });
});

describe("toPartnerShipment, handed a full database row", () => {
  const payload = toPartnerShipment(
    DIRTY_SHIPMENT as never,
    DIRTY_EVENTS as never,
  );

  it("drops every internal field rather than carrying it through", () => {
    assertNoSentinel(payload, "partner shipment");
  });

  it("gives the partner back their own COD figure and none of our costs", () => {
    expect(payload.codAmount).toBe("4500.00");
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(SENTINEL.freight);
    expect(serialised).not.toContain(SENTINEL.declaredValue);
  });

  it("masks both phone numbers, not only the consignee's", () => {
    expect(JSON.stringify(payload)).not.toContain("9812345670");
    expect(JSON.stringify(payload)).not.toContain("9876543210");
    expect(payload.consignor.phone).toBe("98xxxxx210");
    expect(payload.consignee.phone).toBe("98xxxxx670");
  });

  it("returns exactly the agreed keys", () => {
    expect(Object.keys(payload).sort()).toEqual(
      [
        "attemptCount",
        "bookedAt",
        "chargeableWeight",
        "codAmount",
        "consignee",
        "consignor",
        "customerReference",
        "deliveredAt",
        "destination",
        "events",
        "expectedDeliveryAt",
        "isOnHold",
        "lrNumber",
        "mode",
        "origin",
        "packageCount",
        "paymentType",
        "serviceCode",
        "status",
        "statusUpdatedAt",
      ].sort(),
    );
  });
});

describe("toWebhookBody, handed an outbox payload full of internals", () => {
  const body = toWebhookBody({
    eventType: "shipment.status_changed",
    aggregate: "Shipment",
    aggregateId: "shp_LEAK_0a1",
    // The whole row, plus the handful of fields the outbox actually adds.
    // This is what an outbox payload looks like in practice: the emitting
    // handler put everything it had on it.
    payload: {
      ...DIRTY_SHIPMENT,
      previousStatus: "PICKED_UP",
      occurredAt: "2026-08-26T09:15:00.000Z",
      reasonCodeId: SENTINEL.reasonCode,
    },
  });

  it("rebuilds the body from the allowlist instead of forwarding it", () => {
    assertNoSentinel(body, "webhook body");
    expect(Object.keys(body.data as object).sort()).toEqual(
      ["lrNumber", "occurredAt", "previousStatus", "status"].sort(),
    );
  });

  it("sends an empty data object for an aggregate it has no shape for", () => {
    const other = toWebhookBody({
      eventType: "trip.closed",
      aggregate: "Trip",
      aggregateId: "trp_LEAK_3f7",
      payload: { driverId: SENTINEL.driver, vehicleNumber: SENTINEL.vehicle },
    });

    expect(other.data).toEqual({});
    assertNoSentinel(other, "trip webhook body");
  });
});

// ── the `select` that feeds all of the above ────────────────────────────

/**
 * The projections are only as narrow as the query behind them. Both API
 * route handlers spread `PUBLIC_SHIPMENT_SELECT` straight into a Prisma
 * `select`, so a column added here is a column fetched — and one line
 * further on, a column available to publish.
 */
describe("the public select", () => {
  it("asks the database for no forbidden column", () => {
    expect(findForbiddenKey(PUBLIC_SHIPMENT_SELECT)).toBeNull();
    expect(findForbiddenKey(PUBLIC_EVENT_SELECT)).toBeNull();
  });

  it("never selects the event payload, which carries whatever the emitter needed", () => {
    expect(PUBLIC_EVENT_SELECT).not.toHaveProperty("payload");
    expect(PUBLIC_EVENT_SELECT).not.toHaveProperty("branchId");
  });

  it("reaches a branch only through its city", () => {
    // `branch: { select: { city: … } }` is safe; `branch: true` would hand
    // back the code and the name, which is what the module exists to hide.
    for (const key of ["originBranch", "destinationBranch"] as const) {
      const node = PUBLIC_SHIPMENT_SELECT[key];
      expect(typeof node, key).toBe("object");
      expect(Object.keys(node.select), key).toEqual(["city"]);
    }
    expect(Object.keys(PUBLIC_EVENT_SELECT.branch.select)).toEqual(["city"]);
  });

  it("selects no column the projection has no field for", () => {
    // A column selected and then dropped is a leak waiting for the next
    // person who spreads the row: it is already in memory.
    const declared = new Set(Object.keys(PUBLIC_SHIPMENT_SELECT));
    const consumed = new Set([
      "lrNumber",
      "mode",
      "currentStatus",
      "statusUpdatedAt",
      "bookedAt",
      "expectedDeliveryAt",
      "deliveredAt",
      "packageCount",
      "isOnHold",
      "attemptCount",
      "chargeableWeight",
      "paymentType",
      "codAmount",
      "customerReference",
      "consignorName",
      "consignorPhone",
      "consigneeName",
      "consigneePhone",
      "consigneePincode",
      "serviceType",
      "originBranch",
      "destinationBranch",
    ]);

    expect([...declared].filter((key) => !consumed.has(key))).toEqual([]);
  });
});

describe("the forbidden key list", () => {
  it("names the identifiers a Prisma shipment row actually carries", () => {
    // Guards the list itself: if a column is renamed in the schema the
    // entry here goes stale silently, and `findForbiddenKey` stops
    // catching the thing it was added for.
    for (const key of ["orgId", "originBranchId", "driverId", "grandTotal"]) {
      expect(FORBIDDEN_OUTBOUND_KEYS, key).toContain(key);
      expect(DIRTY_SHIPMENT, key).toHaveProperty(key);
    }
  });

  it("has no duplicates, which would hide a missing entry in a long list", () => {
    expect(new Set(FORBIDDEN_OUTBOUND_KEYS).size).toBe(
      FORBIDDEN_OUTBOUND_KEYS.length,
    );
  });
});
