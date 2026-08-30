import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOLERANCE_SECONDS,
  backoffSeconds,
  matchesEvent,
  signWebhook,
  verifyWebhook,
} from "./signature";
import { AUTH_FAILURE_RULE, DEFAULT_RATE_LIMIT } from "./rate-limit";
import {
  findForbiddenKey,
  maskPhone,
  toPartnerShipment,
  toPublicTracking,
  toWebhookBody,
} from "./public-payload";

const SECRET = "whsec_2f1c9d5a4b6e47c8a1d3f5079b2e6c48";
const NOW = 1_780_000_000;

describe("signWebhook", () => {
  it("is deterministic for the same secret, timestamp and body", () => {
    const body = JSON.stringify({ event: "shipment.delivered" });
    expect(signWebhook(SECRET, NOW, body)).toBe(signWebhook(SECRET, NOW, body));
  });

  it("changes when the body changes", () => {
    expect(signWebhook(SECRET, NOW, "{}")).not.toBe(signWebhook(SECRET, NOW, "{ }"));
  });

  it("changes when the timestamp changes — this is what stops a replay", () => {
    expect(signWebhook(SECRET, NOW, "{}")).not.toBe(signWebhook(SECRET, NOW + 1, "{}"));
  });

  it("changes when the secret changes", () => {
    expect(signWebhook(SECRET, NOW, "{}")).not.toBe(signWebhook("other", NOW, "{}"));
  });

  it("is versioned, so the scheme can move without breaking receivers", () => {
    expect(signWebhook(SECRET, NOW, "{}").startsWith("v1=")).toBe(true);
  });
});

describe("verifyWebhook", () => {
  const body = JSON.stringify({ event: "shipment.delivered", data: { lrNumber: "CL1" } });

  it("accepts a signature we just produced", () => {
    expect(
      verifyWebhook({
        secret: SECRET,
        body,
        signature: signWebhook(SECRET, NOW, body),
        timestamp: NOW,
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a body altered in flight", () => {
    expect(
      verifyWebhook({
        secret: SECRET,
        body: body.replace("CL1", "CL2"),
        signature: signWebhook(SECRET, NOW, body),
        timestamp: NOW,
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a captured request replayed later", () => {
    const signature = signWebhook(SECRET, NOW, body);
    expect(
      verifyWebhook({
        secret: SECRET,
        body,
        signature,
        timestamp: NOW,
        nowSeconds: NOW + DEFAULT_TOLERANCE_SECONDS + 1,
      }),
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("accepts one still inside the tolerance window", () => {
    const signature = signWebhook(SECRET, NOW, body);
    expect(
      verifyWebhook({
        secret: SECRET,
        body,
        signature,
        timestamp: NOW,
        nowSeconds: NOW + DEFAULT_TOLERANCE_SECONDS - 1,
      }).ok,
    ).toBe(true);
  });

  it("rejects a clock far ahead as well as far behind", () => {
    const signature = signWebhook(SECRET, NOW, body);
    expect(
      verifyWebhook({
        secret: SECRET,
        body,
        signature,
        timestamp: NOW,
        nowSeconds: NOW - DEFAULT_TOLERANCE_SECONDS - 1,
      }),
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects a missing or unreadable header", () => {
    expect(
      verifyWebhook({ secret: SECRET, body, signature: null, timestamp: NOW }),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      verifyWebhook({ secret: SECRET, body, signature: "v1=abc", timestamp: "later" }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      verifyWebhook({
        secret: SECRET,
        body,
        signature: signWebhook("whsec_someone_else", NOW, body),
        timestamp: NOW,
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("matchesEvent", () => {
  it("matches an exact name", () => {
    expect(matchesEvent(["shipment.delivered"], "shipment.delivered")).toBe(true);
    expect(matchesEvent(["shipment.delivered"], "shipment.booked")).toBe(false);
  });

  it("matches everything on a bare star", () => {
    expect(matchesEvent(["*"], "anything.at.all")).toBe(true);
  });

  it("matches a family prefix", () => {
    expect(matchesEvent(["shipment.*"], "shipment.delivered")).toBe(true);
    expect(matchesEvent(["shipment.*"], "pickup.completed")).toBe(false);
  });

  it("does not let shipment.* swallow shipmentx.something", () => {
    expect(matchesEvent(["shipment.*"], "shipmentx.delivered")).toBe(false);
  });

  it("matches if any pattern in the list matches", () => {
    expect(matchesEvent(["pickup.*", "shipment.delivered"], "shipment.delivered")).toBe(
      true,
    );
  });

  it("subscribes to nothing on an empty list", () => {
    expect(matchesEvent([], "shipment.delivered")).toBe(false);
    expect(matchesEvent(["", "  "], "shipment.delivered")).toBe(false);
  });
});

describe("backoffSeconds", () => {
  it("starts short and grows", () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBeGreaterThan(backoffSeconds(1));
    expect(backoffSeconds(5)).toBeGreaterThan(backoffSeconds(4));
  });

  it("caps rather than growing without limit", () => {
    expect(backoffSeconds(50)).toBe(backoffSeconds(8));
    expect(backoffSeconds(50)).toBeLessThanOrEqual(21_600);
  });

  it("is defined for a nonsense attempt number", () => {
    expect(backoffSeconds(0)).toBe(30);
    expect(backoffSeconds(-3)).toBe(30);
  });
});

/**
 * The window arithmetic itself now lives in `lib/rate-limit/store.ts` and
 * is tested there. What belongs here is the shape of the two budgets the
 * partner API runs on, because those numbers are a policy.
 */
describe("rate limiting", () => {
  it("keeps the per-key quota generous enough for a real integration", () => {
    expect(DEFAULT_RATE_LIMIT).toBeGreaterThanOrEqual(60);
  });

  it("sets the failure budget far below what guessing a key needs", () => {
    // A partner with a stale key retries a handful of times and stops. A
    // caller searching the key space cannot work inside twenty attempts in
    // five minutes — and until this existed, every failure returned before
    // any limit was counted, so there was no budget at all.
    expect(AUTH_FAILURE_RULE.limit).toBeLessThanOrEqual(25);
    expect(AUTH_FAILURE_RULE.windowMs).toBeGreaterThanOrEqual(60_000);
  });
});

// ────────────────────────────────────────────────────────────
// What may leave the building
// ────────────────────────────────────────────────────────────

const SHIPMENT = {
  lrNumber: "CL2608250001",
  mode: "PTL",
  currentStatus: "IN_TRANSIT",
  statusUpdatedAt: new Date("2026-08-26T09:15:00Z"),
  bookedAt: new Date("2026-08-25T11:00:00Z"),
  expectedDeliveryAt: new Date("2026-08-28T11:00:00Z"),
  deliveredAt: null,
  packageCount: 3,
  isOnHold: false,
  attemptCount: 0,
  chargeableWeight: { toString: () => "48.500" },
  paymentType: "PAID",
  codAmount: null,
  customerReference: "SO-2026-00184",
  consignorName: "Ramesh Traders",
  consignorPhone: "9876543210",
  consigneeName: "Sharma Distributors",
  consigneePhone: "9812345670",
  consigneePincode: "302001",
  serviceType: { code: "PTL-STD" },
  originBranch: { city: { name: "Delhi" } },
  destinationBranch: { city: { name: "Jaipur" } },
};

const EVENTS = [
  {
    eventType: "BOOKING_CREATED",
    occurredAt: new Date("2026-08-25T11:00:00Z"),
    remarks: null,
    resultingStatus: "BOOKED",
    branch: { city: { name: "Delhi" } },
  },
  {
    eventType: "GATE_OUT",
    occurredAt: new Date("2026-08-26T09:15:00Z"),
    remarks: "Loaded",
    resultingStatus: "IN_TRANSIT",
    branch: { city: { name: "Delhi" } },
  },
];

describe("maskPhone", () => {
  it("keeps enough to confirm the number and not enough to dial it", () => {
    expect(maskPhone("9812345670")).toBe("98xxxxx670");
    expect(maskPhone("9812345670")).not.toContain("2345");
  });

  it("degrades safely on nonsense input", () => {
    expect(maskPhone("")).toBe("xxxxxx");
    expect(maskPhone("12")).toBe("xxxxxx");
  });
});

describe("the public tracking payload", () => {
  const payload = toPublicTracking(SHIPMENT, EVENTS);

  it("names cities, never branches", () => {
    expect(payload.origin).toBe("Delhi");
    expect(payload.destination).toBe("Jaipur");
    expect(payload.events[0].location).toBe("Delhi");
  });

  it("carries the status history a customer asked for", () => {
    expect(payload.status).toBe("IN_TRANSIT");
    expect(payload.events.map((event) => event.status)).toEqual([
      "BOOKED",
      "IN_TRANSIT",
    ]);
  });

  it("leaks no branch, vehicle, driver, staff or cost data", () => {
    expect(findForbiddenKey(payload)).toBeNull();
  });

  it("carries no money at all", () => {
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain("codAmount");
    expect(serialised).not.toContain("freight");
    expect(serialised).not.toContain("grandTotal");
  });

  it("does not carry the parties' contact details", () => {
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain("9812345670");
    expect(serialised).not.toContain("Sharma Distributors");
  });
});

describe("the partner shipment payload", () => {
  const payload = toPartnerShipment(SHIPMENT, EVENTS);

  it("returns what the partner themselves supplied", () => {
    expect(payload.customerReference).toBe("SO-2026-00184");
    expect(payload.consignee.name).toBe("Sharma Distributors");
    expect(payload.serviceCode).toBe("PTL-STD");
  });

  it("masks the phone numbers even for the partner", () => {
    expect(payload.consignee.phone).toBe("98xxxxx670");
    expect(JSON.stringify(payload)).not.toContain("9812345670");
  });

  it("leaks no branch, vehicle, driver, staff or cost data", () => {
    expect(findForbiddenKey(payload)).toBeNull();
  });

  it("carries no freight, charges or tax", () => {
    const serialised = JSON.stringify(payload);
    for (const field of ["freightAmount", "chargesTotal", "taxAmount", "grandTotal"]) {
      expect(serialised).not.toContain(field);
    }
  });
});

describe("the webhook body", () => {
  it("is rebuilt from an allowlist, not forwarded from the outbox", () => {
    const body = toWebhookBody({
      eventType: "shipment.delivered",
      aggregate: "Shipment",
      aggregateId: "shp_1",
      payload: {
        lrNumber: "CL2608250001",
        currentStatus: "DELIVERED",
        previousStatus: "OUT_FOR_DELIVERY",
        eventType: "DELIVERED",
        occurredAt: "2026-08-27T10:00:00.000Z",
        // Everything below is in the outbox payload and must not go out.
        eventId: "evt_1",
        branchId: "br_jai",
        reasonCodeId: "rc_1",
      },
    });

    expect(body.event).toBe("shipment.delivered");
    expect(body.data).toEqual({
      lrNumber: "CL2608250001",
      status: "DELIVERED",
      previousStatus: "OUT_FOR_DELIVERY",
      eventType: "DELIVERED",
      occurredAt: "2026-08-27T10:00:00.000Z",
    });
    expect(findForbiddenKey(body)).toBeNull();
    expect(JSON.stringify(body)).not.toContain("evt_1");
  });

  it("emits an empty data object for an aggregate it has no projection for", () => {
    const body = toWebhookBody({
      eventType: "settlement.approved",
      aggregate: "Settlement",
      aggregateId: "stl_1",
      payload: { amount: "94000", vendorId: "ven_1" },
    });

    expect(body.data).toEqual({});
    expect(JSON.stringify(body)).not.toContain("94000");
  });

  it("survives a payload that is not an object", () => {
    expect(
      toWebhookBody({
        eventType: "x.y",
        aggregate: "Shipment",
        aggregateId: "shp_1",
        payload: null,
      }).data,
    ).toEqual({});
  });
});

describe("findForbiddenKey", () => {
  it("finds an internal key nested anywhere", () => {
    expect(findForbiddenKey({ a: { b: [{ driverId: "drv_1" }] } })).toContain("driverId");
  });

  it("passes a clean payload", () => {
    expect(findForbiddenKey({ a: { b: [{ status: "DELIVERED" }] } })).toBeNull();
  });
});
