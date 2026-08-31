import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two things a booking decides about money.
 *
 * Both used to be decided by whoever posted the form. A charge line
 * suppressed the rate card outright — freight at ₹1 needed nothing beyond
 * the permission to book — and the credit check that `checkCustomerCredit`
 * documents itself as serving was never called from here at all, leaving a
 * dropdown filter as the only thing between a blocked account and a new
 * consignment.
 *
 * These tests go at the service rather than the counter form on purpose:
 * every way into this product — counter, portal, bulk import, partner API —
 * arrives at `createBooking`, so this is the only place a fix can be
 * proved to cover all four.
 */

const store = vi.hoisted(() => ({
  permissions: new Set<string>(["shipment.create"]),
  /** What `checkCustomerCredit` answers for the consignor. */
  creditAllowed: true,
  creditReason: null as string | null,
  shipmentsCreated: [] as Array<Record<string, unknown>>,
  pickupsRaised: [] as Array<Record<string, unknown>>,
  shipmentUpdates: [] as Array<Record<string, unknown>>,
  chargeBatches: [] as Array<Array<Record<string, unknown>>>,
  calculations: [] as Array<{ stage: string; total: string }>,
  audits: [] as Array<Record<string, unknown>>,
  creditChecks: [] as Array<Record<string, unknown>>,
  /** What the rate card is pretending to say. */
  ratedTotal: "820.00",
}));

vi.mock("@/lib/auth/session", () => ({
  can: (_actor: unknown, permission: string) => store.permissions.has(permission),
}));

vi.mock("@/lib/numbering/number-series", () => ({
  nextNumber: async () => "CL/2627/JAI/000001",
}));

vi.mock("@/lib/plan-limits", () => ({
  assertWithinLimit: async () => undefined,
  isPlanLimitError: () => false,
  noteShipmentBooked: () => undefined,
}));

vi.mock("@/server/services/audit", () => ({
  recordAudit: async (input: Record<string, unknown>) => {
    store.audits.push(input);
  },
}));

vi.mock("@/lib/billing/receivables", () => ({
  checkCustomerCredit: async (options: Record<string, unknown>) => {
    store.creditChecks.push(options);
    return {
      customerName: "Acme Traders",
      verdict: store.creditAllowed ? "OK" : "BLOCK",
      allowed: store.creditAllowed,
      reason: store.creditReason,
      limit: null,
      outstanding: new Decimal(0),
      exposure: new Decimal(0),
      headroom: null,
      utilisationPercent: null,
    };
  },
}));

vi.mock("./events", () => ({
  appendShipmentEvent: async () => ({
    ok: true,
    eventId: "evt-1",
    previousStatus: "BOOKED",
    currentStatus: "BOOKED",
    statusChanged: false,
    duplicate: false,
  }),
}));

vi.mock("@/lib/pricing/resolve", () => ({
  SHIPMENT_PRICING_SELECT: {},
  snapshotShipment: async () => ({}),
  priceShipment: async () => {
    const total = new Decimal(store.ratedTotal);
    return {
      lines: [
        {
          chargeTypeId: "ct-freight",
          basis: "WEIGHT",
          rate: new Decimal("20"),
          quantity: new Decimal("35"),
          amount: total.dividedBy(new Decimal("1.18")),
          taxRateId: "tax-18",
          taxPercent: new Decimal("18"),
        },
      ],
      freightAmount: total.dividedBy(new Decimal("1.18")),
      chargesTotal: total.dividedBy(new Decimal("1.18")),
      taxTotal: total.minus(total.dividedBy(new Decimal("1.18"))),
      total,
      selectedVersionId: "ver-1",
      trace: {},
    };
  },
  storeFreightCalculation: async (input: {
    result: { total: Decimal };
    stage: string;
  }) => {
    store.calculations.push({
      stage: input.stage,
      total: input.result.total.toFixed(2),
    });
    return "calc-1";
  },
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    serviceType: {
      findUnique: async () => ({
        id: "svc-1",
        code: "PTL-STD",
        mode: "PTL",
        isActive: true,
        volumetricDivisor: 5000,
        allowsCod: true,
        allowsToPay: true,
        defaultTransitHours: 48,
      }),
    },
    pincode: {
      findFirst: async () => ({ isServiceable: true, isOda: false }),
    },
    shipment: {
      create: async (args: { data: Record<string, unknown> }) => {
        store.shipmentsCreated.push(args.data);
        return { id: "shp-1", lrNumber: args.data.lrNumber, orgId: "org-1" };
      },
      update: async (args: { data: Record<string, unknown> }) => {
        store.shipmentUpdates.push(args.data);
        return {};
      },
      findUniqueOrThrow: async () => ({
        id: "shp-1",
        serviceType: { volumetricDivisor: 5000 },
      }),
    },
    shipmentPackage: { createMany: async () => ({ count: 1 }) },
    pickupRequest: {
      create: async (args: { data: Record<string, unknown> }) => {
        store.pickupsRaised.push(args.data);
        return { id: "pu-1", number: args.data.number };
      },
    },
    shipmentCharge: {
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        store.chargeBatches.push(args.data);
        return { count: args.data.length };
      },
    },
  };

  return {
    prisma: client,
    tenantTransaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> =>
      callback(client),
  };
});

const { createBooking } = await import("./booking");

const actor = {
  id: "usr-clerk",
  orgId: "org-1",
  name: "Booking clerk",
  mobile: "9000000001",
  email: null,
  isFieldUser: false,
  mustChangePassword: false,
  primaryBranch: { id: "br-jai", code: "JAI", name: "Jaipur" },
  roles: [],
  permissions: new Set<string>(),
  scope: "BRANCH" as const,
  branchIds: ["br-jai"],
};

function bookingInput(overrides: Record<string, unknown> = {}) {
  return {
    mode: "PTL" as const,
    serviceTypeId: "svc-1",
    bookingBranchId: "br-jai",
    originBranchId: "br-jai",
    destinationBranchId: "br-del",

    consignorName: "Acme Traders",
    consignorPhone: "9000000002",
    consignorAddress: "12 Industrial Area",
    consignorCityId: "city-jai",
    consignorPincode: "302001",

    consigneeName: "Beta Stores",
    consigneePhone: "9000000003",
    consigneeAddress: "44 Karol Bagh",
    consigneeCityId: "city-del",
    consigneePincode: "110005",

    packageCount: 1,
    actualWeight: 35,
    goodsDescription: "Machine parts",

    paymentType: "PAID" as const,
    ...overrides,
  };
}

/** One charge head at a derisory price — the whole of the attack. */
const CHEAP_FREIGHT = [
  {
    chargeTypeId: "ct-freight",
    basis: "FLAT" as const,
    rate: 1,
    quantity: 1,
    amount: 1,
    taxRateId: null,
    taxPercent: null,
    isManual: true,
  },
];

beforeEach(() => {
  store.permissions = new Set<string>(["shipment.create"]);
  store.creditAllowed = true;
  store.creditReason = null;
  store.shipmentsCreated = [];
  store.pickupsRaised = [];
  store.shipmentUpdates = [];
  store.chargeBatches = [];
  store.calculations = [];
  store.audits = [];
  store.creditChecks = [];
  store.ratedTotal = "820.00";
});

describe("the rate card cannot be bypassed by posting a charge line", () => {
  it("refuses a hand-typed charge from a clerk without shipment.override_rate", async () => {
    const result = await createBooking(
      bookingInput({ charges: CHEAP_FREIGHT }),
      actor,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("charges");
    // Refused before anything is written: no LR number is burned on it.
    expect(store.shipmentsCreated).toHaveLength(0);
  });

  it("prices from the rate card when no charge is posted", async () => {
    const result = await createBooking(bookingInput(), actor);

    expect(result.ok).toBe(true);
    expect(store.calculations).toEqual([{ stage: "BOOKING", total: "820.00" }]);
    expect(store.shipmentUpdates.at(0)).toMatchObject({ grandTotal: "820.00" });
    // The engine's lines, flagged as the engine's.
    expect(store.chargeBatches.at(0)?.at(0)).toMatchObject({ isManual: false });
  });
});

describe("an overridden price is distinguishable from a computed one", () => {
  beforeEach(() => {
    store.permissions.add("shipment.override_rate");
  });

  it("lets the permitted override stand, and still records what the tariff said", async () => {
    const result = await createBooking(
      bookingInput({ charges: CHEAP_FREIGHT }),
      actor,
    );

    expect(result.ok).toBe(true);

    // The typed price is what the consignment carries...
    expect(store.shipmentsCreated.at(0)).toMatchObject({ grandTotal: "1.00" });
    expect(store.chargeBatches.at(0)?.at(0)).toMatchObject({
      amount: 1,
      isManual: true,
    });

    // ...and the rate card's answer is on the record beside it, marked as
    // the thing that was overruled rather than the thing that was charged.
    expect(store.calculations).toEqual([
      { stage: "BOOKING_OVERRIDE", total: "820.00" },
    ]);

    const audit = store.audits.at(0);
    expect(audit).toMatchObject({
      action: "OVERRIDE",
      entity: "Shipment",
      before: { grandTotal: "820.00", source: "rate card" },
      after: { grandTotal: "1.00", source: "entered by hand" },
    });
  });

  it("writes no override audit when the rate card did the pricing", async () => {
    await createBooking(bookingInput(), actor);
    expect(store.audits).toHaveLength(0);
  });
});

describe("a credit block is enforced by the service, not by the picker", () => {
  it("refuses a booking against a blocked consignor posted directly", async () => {
    store.creditAllowed = false;
    store.creditReason = "Account is blocked: cheque returned twice";

    const result = await createBooking(
      bookingInput({ consignorId: "cust-acme" }),
      actor,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("cheque returned twice");
      expect(result.field).toBe("consignorId");
    }
    expect(store.shipmentsCreated).toHaveLength(0);
  });

  it("checks the account named on the booking, at the amount being billed", async () => {
    await createBooking(
      bookingInput({ consignorId: "cust-acme", charges: CHEAP_FREIGHT }),
      { ...actor, permissions: new Set(["shipment.create"]) },
    );

    // Refused for the override, so no credit call yet — the point of this
    // case is the next one.
    store.permissions.add("shipment.override_rate");
    store.creditChecks = [];

    await createBooking(
      bookingInput({ consignorId: "cust-acme", charges: CHEAP_FREIGHT }),
      actor,
    );

    expect(store.creditChecks).toHaveLength(1);
    expect(store.creditChecks[0].customerId).toBe("cust-acme");
  });

  it("leaves a walk-in booking alone — there is no account to charge", async () => {
    const result = await createBooking(bookingInput(), actor);

    expect(result.ok).toBe(true);
    expect(store.creditChecks).toHaveLength(0);
  });
});

describe("a booking that asks for a collection gets one", () => {
  /*
    `pickupRequired` was written on the shipment and read by nothing, so a
    consignment booked "with pickup" produced no pickup at all. The flag was
    an opinion nobody acted on, and the branch found out when the consignor
    rang to ask where the van was.
  */

  it("raises the pickup in the same transaction as the booking", async () => {
    const result = await createBooking(bookingInput(), actor);

    expect(result.ok).toBe(true);
    expect(store.pickupsRaised).toHaveLength(1);

    const pickup = store.pickupsRaised[0];
    expect(pickup.shipmentId).toBe("shp-1");
    // The van is going to the consignor, so the address is theirs and not
    // the booking branch's.
    expect(pickup.contactName).toBe(bookingInput().consignorName);
    expect(pickup.pincode).toBe(bookingInput().consignorPincode);
    expect(pickup.expectedPackages).toBe(bookingInput().packageCount);
  });

  it("leaves it unassigned, because who goes is the branch's call", async () => {
    await createBooking(bookingInput(), actor);

    // Nothing here names an executive. `/pickups` suggests one against the
    // day's load; inventing an assignee at booking would put work on
    // somebody's phone their supervisor never gave them.
    expect(store.pickupsRaised[0]).not.toHaveProperty("assignedToId");
  });

  it("raises nothing when the consignor is bringing it to the counter", async () => {
    const result = await createBooking(
      bookingInput({ pickupRequired: false }),
      actor,
    );

    expect(result.ok).toBe(true);
    expect(store.pickupsRaised).toHaveLength(0);
  });
});
