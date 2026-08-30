import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The revenue-leakage test.
 *
 * A hub that revises chargeable weight upward and does not reprice bills
 * the booking estimate, which is money the company has already measured
 * and then given away. These tests hold the whole chain: the engine
 * re-runs on the revised figure, a *second* `FreightCalculation` is
 * written at the INVOICE stage rather than the booking one being
 * overwritten, the delta is what a debit note would be raised from, and
 * the tolerance decides whether anybody is told.
 *
 * Prisma is replaced with a store that records what was written. The
 * assertions are about the rows, not about the return value alone —
 * a re-rate whose result object looks right but whose calculation never
 * reached the table is exactly the bug this file exists to catch.
 */

const store = vi.hoisted(() => ({
  shipment: {
    id: "shp-1",
    orgId: "org-1",
    lrNumber: "CL2608250001",
    mode: "PTL",
    serviceTypeId: "svc-express",
    paymentType: "PAID",
    consignorId: "cust-acme",
    consignorCityId: "city-del",
    consigneeCityId: "city-jai",
    consignorPincode: "110001",
    consigneePincode: "302001",
    packageCount: 4,
    // Booked on the customer's word: 100 kg at ₹10/kg.
    actualWeight: "100.000",
    volumetricWeight: "0.000",
    chargeableWeight: "100.000",
    declaredValue: null,
    codAmount: null,
    isFragile: false,
    isReverseCharge: false,
    serviceType: { volumetricDivisor: 5000 },
    freightAmount: "1000.00",
    chargesTotal: "1000.00",
    taxAmount: "180.00",
    grandTotal: "1180.00",
  } as Record<string, unknown>,

  /** Every `FreightCalculation` written, in order. */
  calculations: [] as Array<Record<string, unknown>>,
  /** Every `shipment.update` data payload, in order. */
  updates: [] as Array<Record<string, unknown>>,
  chargeDeletes: [] as Array<Record<string, unknown>>,
  chargeInserts: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  /** `billing.reweighTolerancePercent`, or null for "not configured". */
  tolerance: null as string | null,
}));

vi.mock("@/server/services/audit", () => ({
  recordAudit: async (input: Record<string, unknown>) => {
    store.audits.push(input);
  },
}));

vi.mock("@/lib/prisma", () => {
  let sequence = 0;

  const freightCalculation = {
    create: async (args: { data: Record<string, unknown> }) => {
      const row = { id: `calc-${++sequence}`, ...args.data };
      store.calculations.push(row);
      return { id: row.id };
    },
  };

  const shipment = {
    findUnique: async () => ({ ...store.shipment }),
    update: async (args: { data: Record<string, unknown> }) => {
      store.updates.push(args.data);
      Object.assign(store.shipment, args.data);
      return { id: store.shipment.id };
    },
  };

  const shipmentCharge = {
    deleteMany: async (args: { where: Record<string, unknown> }) => {
      store.chargeDeletes.push(args.where);
      return { count: 0 };
    },
    createMany: async (args: { data: Array<Record<string, unknown>> }) => {
      store.chargeInserts.push(...args.data);
      return { count: args.data.length };
    },
  };

  const client = {
    shipment,
    freightCalculation,
    shipmentCharge,

    systemConfig: {
      findFirst: async () =>
        store.tolerance === null ? null : { value: store.tolerance },
    },

    // ── Pricing masters ──────────────────────────────────
    chargeType: {
      findMany: async () => [
        {
          id: "ct-freight",
          code: "FRT",
          name: "Base freight",
          nature: "FREIGHT",
          isTaxable: true,
          isCustomerVisible: true,
          taxRateId: "tax-gst18",
          taxRate: {
            id: "tax-gst18",
            code: "GST18",
            ratePercent: "18.000",
            isReverseCharge: false,
          },
        },
      ],
    },
    fuelSurchargeRule: { findMany: async () => [] },
    pincode: { findFirst: async () => ({ isOda: false, zones: [] }) },

    rateCard: {
      findMany: async () => [
        {
          id: "rc-acme",
          code: "ACME-2026",
          name: "Acme 2026",
          customerId: "cust-acme",
          versions: [
            {
              id: "v-acme-1",
              version: 1,
              effectiveFrom: new Date("2026-04-01"),
              effectiveTo: null,
              isApproved: true,
              slabs: [
                {
                  id: "slab-flat",
                  serviceTypeId: null,
                  mode: null,
                  originZoneId: null,
                  destinationZoneId: null,
                  originCityId: null,
                  destinationCityId: null,
                  vehicleTypeId: null,
                  weightFromKg: null,
                  weightToKg: null,
                  basis: "PER_KG",
                  rate: "10.0000",
                  minimumCharge: null,
                  minimumChargeableKg: null,
                  priority: 0,
                },
              ],
              rules: [],
            },
          ],
        },
      ],
    },
  };

  return {
    prisma: client,
    // The real one resolves the tenant and sets it on the session before
    // running the callback; here the callback is all there is to run.
    tenantTransaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> =>
      callback(client),
  };
});

// `storeFreightCalculation` stamps the row's `orgId` from the ambient
// tenant. Mocked rather than established with `runWithTenant` so this stays
// a unit test: the real module reaches the database to resolve a host.
vi.mock("@/lib/tenant", () => ({
  requireTenantOrgId: async () => "org-1",
}));

const { rerateShipment, reweighTolerancePercent, DEFAULT_REWEIGH_TOLERANCE_PERCENT } =
  await import("./rerate");

const ACTOR = {
  id: "user-1",
  orgId: "org-1",
  name: "Hub clerk",
} as unknown as Parameters<typeof rerateShipment>[1];

function reset() {
  Object.assign(store.shipment, {
    actualWeight: "100.000",
    volumetricWeight: "0.000",
    chargeableWeight: "100.000",
    freightAmount: "1000.00",
    chargesTotal: "1000.00",
    taxAmount: "180.00",
    grandTotal: "1180.00",
  });
  store.calculations.length = 0;
  store.updates.length = 0;
  store.chargeDeletes.length = 0;
  store.chargeInserts.length = 0;
  store.audits.length = 0;
  store.tolerance = null;
}

beforeEach(reset);

describe("rerateShipment", () => {
  it("reprices on the revised weight rather than billing the estimate", async () => {
    // The scale says 140 kg, not the 100 the customer declared.
    const result = await rerateShipment(
      { shipmentId: "shp-1", revisedChargeableWeight: 140 },
      ACTOR,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 140 kg × ₹10 = ₹1,400 + 18% = ₹1,652.
    expect(result.result.chargeableWeight.toFixed(3)).toBe("140.000");
    expect(result.newTotal.toFixed(2)).toBe("1652.00");
    expect(result.previousTotal.toFixed(2)).toBe("1180.00");
  });

  it("records the delta the debit note is raised from", async () => {
    const result = await rerateShipment(
      { shipmentId: "shp-1", revisedChargeableWeight: 140 },
      ACTOR,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.delta.toFixed(2)).toBe("472.00");
    expect(result.deltaPercent.toFixed(2)).toBe("40.00");

    // The delta reaches the audit trail, which is where a disputed
    // reweigh is actually settled.
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0].entity).toBe("FreightCalculation");
    expect((store.audits[0].after as Record<string, unknown>).delta).toBe("472.00");
  });

  it("writes a second calculation at the INVOICE stage, leaving the booking one alone", async () => {
    await rerateShipment({ shipmentId: "shp-1", revisedChargeableWeight: 140 }, ACTOR);

    expect(store.calculations).toHaveLength(1);
    const stored = store.calculations[0];

    // Created, never updated: the booking row is the only evidence of what
    // was quoted at the counter.
    expect(stored.stage).toBe("INVOICE");
    expect(stored.shipmentId).toBe("shp-1");
    expect(stored.chargeableWeight).toBe("140.000");
    expect(stored.grandTotal).toBe("1652.00");
  });

  it("applies the new figures to the shipment and replaces only engine charges", async () => {
    await rerateShipment({ shipmentId: "shp-1", revisedChargeableWeight: 140 }, ACTOR);

    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]).toMatchObject({
      chargeableWeight: "140.000",
      chargesTotal: "1400.00",
      taxAmount: "252.00",
      grandTotal: "1652.00",
    });

    // A charge a clerk added by hand survives — the engine did not put it
    // there and has no business taking it away.
    expect(store.chargeDeletes[0]).toMatchObject({
      shipmentId: "shp-1",
      isManual: false,
    });
  });

  it("leaves the shipment untouched when asked only to price", async () => {
    const result = await rerateShipment(
      { shipmentId: "shp-1", revisedChargeableWeight: 140, applyToShipment: false },
      ACTOR,
    );

    expect(result.ok).toBe(true);
    expect(store.updates).toHaveLength(0);
    // The calculation is still stored: a quote the clerk was shown and
    // then abandoned is worth being able to point at.
    expect(store.calculations).toHaveLength(1);
  });

  it("flags an increase past the default 10% tolerance", async () => {
    const result = await rerateShipment(
      { shipmentId: "shp-1", revisedChargeableWeight: 140 },
      ACTOR,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.tolerancePercent.toFixed(0)).toBe(
      String(DEFAULT_REWEIGH_TOLERANCE_PERCENT),
    );
    expect(result.exceedsTolerance).toBe(true);
  });

  it("stays quiet about a small increase", async () => {
    // 105 kg is a 5% move — inside tolerance, so nobody is told.
    const result = await rerateShipment(
      { shipmentId: "shp-1", revisedChargeableWeight: 105 },
      ACTOR,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.delta.greaterThan(0)).toBe(true);
    expect(result.exceedsTolerance).toBe(false);
  });

  it("never flags a reweigh that went the other way", async () => {
    // Down from 100 kg to 60. A lower figure has to arrive as the actual
    // weight — `revisedChargeableWeight` only ever raises the floor, so
    // that alone would leave the declared 100 kg standing. The price falls;
    // a fall is not something the customer needs warning about, however far
    // past the tolerance it is.
    const result = await rerateShipment(
      { shipmentId: "shp-1", revisedActualWeight: 60, revisedChargeableWeight: 60 },
      ACTOR,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.delta.isNegative()).toBe(true);
    expect(result.exceedsTolerance).toBe(false);
  });

  it("honours a configured tolerance over the default", async () => {
    store.tolerance = "50";

    const result = await rerateShipment(
      { shipmentId: "shp-1", revisedChargeableWeight: 140 },
      ACTOR,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 40% is now inside tolerance.
    expect(result.tolerancePercent.toFixed(0)).toBe("50");
    expect(result.exceedsTolerance).toBe(false);
  });
});

describe("reweighTolerancePercent", () => {
  it("falls back to the default when nothing is configured", async () => {
    store.tolerance = null;
    const value = await reweighTolerancePercent("org-1");
    expect(value.toNumber()).toBe(DEFAULT_REWEIGH_TOLERANCE_PERCENT);
  });

  it("falls back rather than throwing on a value that is not a number", async () => {
    store.tolerance = "ten percent";
    const value = await reweighTolerancePercent("org-1");
    expect(value.toNumber()).toBe(DEFAULT_REWEIGH_TOLERANCE_PERCENT);
  });
});
