import { describe, expect, it } from "vitest";
import {
  calculateFreight,
  matchSlab,
  conditionFailure,
  fuelRuleOn,
  isEffectiveOn,
  specificityRank,
  dec,
  type PricingChargeType,
  type PricingContext,
  type PricingRateCardVersion,
  type PricingShipment,
  type PricingSlab,
  type TraceEntry,
} from "./engine";

/**
 * The freight engine is where every billing argument ends up, so these
 * tests read like the arguments themselves: a band edge, a minimum that
 * should have applied after the slab and not before, a customer rate that
 * should have beaten the published tariff.
 */

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

const FREIGHT: PricingChargeType = {
  id: "ct-freight",
  code: "FRT",
  name: "Base freight",
  nature: "FREIGHT",
  isTaxable: true,
  taxRateId: "tax-gst18",
  taxPercent: 18,
};

const FUEL: PricingChargeType = {
  id: "ct-fuel",
  code: "FSC",
  name: "Fuel surcharge",
  nature: "SURCHARGE",
  isTaxable: true,
  taxRateId: "tax-gst18",
  taxPercent: 18,
};

const ODA: PricingChargeType = {
  id: "ct-oda",
  code: "ODA",
  name: "Out of delivery area",
  nature: "SURCHARGE",
  isTaxable: true,
  taxRateId: "tax-gst18",
  taxPercent: 18,
};

const INSURANCE: PricingChargeType = {
  id: "ct-ins",
  code: "INS",
  name: "Risk cover",
  nature: "SURCHARGE",
  isTaxable: true,
  taxRateId: "tax-gst18",
  taxPercent: 18,
};

const COD_FEE: PricingChargeType = {
  id: "ct-cod",
  code: "CODF",
  name: "COD collection fee",
  nature: "SURCHARGE",
  isTaxable: true,
  taxRateId: "tax-gst18",
  taxPercent: 18,
};

const DOCKET: PricingChargeType = {
  id: "ct-doc",
  code: "DKT",
  name: "Docket charge",
  nature: "HANDLING",
  isTaxable: true,
  taxRateId: "tax-gst18",
  taxPercent: 18,
};

const HEADS: Record<string, PricingChargeType> = {
  [FREIGHT.id]: FREIGHT,
  [FUEL.id]: FUEL,
  [ODA.id]: ODA,
  [INSURANCE.id]: INSURANCE,
  [COD_FEE.id]: COD_FEE,
  [DOCKET.id]: DOCKET,
};

const PRICED_ON = new Date("2026-08-25T06:00:00.000Z");

function context(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    at: PRICED_ON,
    volumetricDivisor: 5000,
    stepKg: 0.5,
    chargeTypes: HEADS,
    defaultTaxPercent: 18,
    defaultTaxRateId: "tax-gst18",
    defaultTaxCode: "GST18",
    ...overrides,
  };
}

function shipment(overrides: Partial<PricingShipment> = {}): PricingShipment {
  return {
    lrNumber: "CL2608250001",
    mode: "PTL",
    serviceTypeId: "svc-express",
    paymentType: "PAID",
    customerId: "cust-acme",
    originCityId: "city-del",
    destinationCityId: "city-jai",
    originZoneIds: ["zone-north"],
    destinationZoneIds: ["zone-north"],
    packageCount: 4,
    actualWeight: 100,
    packages: [],
    ...overrides,
  };
}

function slab(overrides: Partial<PricingSlab> & { id: string }): PricingSlab {
  return {
    basis: "PER_KG",
    rate: 10,
    ...overrides,
  };
}

function card(
  overrides: Partial<PricingRateCardVersion> & { versionId: string; scope: PricingRateCardVersion["scope"] },
): PricingRateCardVersion {
  return {
    rateCardId: `rc-${overrides.versionId}`,
    rateCardCode: overrides.scope === "CUSTOMER" ? "ACME-2026" : "TARIFF-2026",
    version: 1,
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    isApproved: true,
    slabs: [],
    rules: [],
    ...overrides,
  };
}

function outcomeOf(entries: TraceEntry[], ruleId: string): TraceEntry | undefined {
  return entries.find((e) => e.ruleId === ruleId);
}

// ────────────────────────────────────────────────────────────
// Weight slab boundaries
// ────────────────────────────────────────────────────────────

describe("weight slab boundaries", () => {
  const bands: PricingSlab[] = [
    slab({ id: "s-0-50", weightFromKg: 0, weightToKg: 50, rate: 14 }),
    slab({ id: "s-50-200", weightFromKg: 50, weightToKg: 200, rate: 11 }),
    slab({ id: "s-200-up", weightFromKg: 200, weightToKg: null, rate: 8 }),
  ];

  const version = card({ versionId: "v-cust", scope: "CUSTOMER", slabs: bands });

  it("puts a shipment exactly on the band edge in the band that starts there", () => {
    // 50.000 kg is the ceiling of 0–50 and the floor of 50–200. Inclusive
    // of from, exclusive of to: it belongs to 50–200.
    const result = calculateFreight(
      shipment({ actualWeight: 50 }),
      version,
      context(),
    );

    expect(result.selectedSlabId).toBe("s-50-200");
    expect(result.freightAmount.toFixed(2)).toBe("550.00");
  });

  it("keeps the gram below the edge in the lower band", () => {
    const result = calculateFreight(
      shipment({ actualWeight: 49.5 }),
      version,
      context(),
    );

    expect(result.selectedSlabId).toBe("s-0-50");
    expect(result.freightAmount.toFixed(2)).toBe("693.00");
  });

  it("uses the open-ended top band above its floor", () => {
    const result = calculateFreight(
      shipment({ actualWeight: 200 }),
      version,
      context(),
    );

    expect(result.selectedSlabId).toBe("s-200-up");
    expect(result.freightAmount.toFixed(2)).toBe("1600.00");
  });

  it("names each band it rejected, and why", () => {
    const result = calculateFreight(
      shipment({ actualWeight: 50 }),
      version,
      context(),
    );

    const low = outcomeOf(result.trace.entries, "s-0-50");
    const high = outcomeOf(result.trace.entries, "s-200-up");

    expect(low?.outcome).toBe("SKIPPED");
    expect(low?.reason).toContain("band ceiling");
    expect(high?.outcome).toBe("SKIPPED");
    expect(high?.reason).toContain("below");
  });

  it("bills the rounded-up chargeable weight, not the raw one", () => {
    // 49.2 kg rounds up to 49.5 on a 0.5 kg step.
    const result = calculateFreight(
      shipment({ actualWeight: 49.2 }),
      version,
      context(),
    );

    expect(result.chargeableWeight.toFixed(3)).toBe("49.500");
    expect(result.freightAmount.toFixed(2)).toBe("693.00");
  });

  it("prices on volumetric weight when it beats actual", () => {
    // 120 × 100 × 80 = 960,000 cm³ ÷ 5000 = 192 kg against 40 kg actual.
    const result = calculateFreight(
      shipment({
        actualWeight: 40,
        packages: [{ lengthCm: 120, breadthCm: 100, heightCm: 80 }],
      }),
      version,
      context(),
    );

    expect(result.weightBasis).toBe("VOLUMETRIC");
    expect(result.chargeableWeight.toFixed(3)).toBe("192.000");
    expect(result.selectedSlabId).toBe("s-50-200");
  });
});

// ────────────────────────────────────────────────────────────
// Minimum charge and minimum chargeable weight
// ────────────────────────────────────────────────────────────

describe("minimums", () => {
  it("applies the minimum charge after the slab calculation, not before", () => {
    const version = card({
      versionId: "v-min",
      scope: "CUSTOMER",
      slabs: [slab({ id: "s-min", rate: 10, minimumCharge: 500 })],
    });

    const result = calculateFreight(
      shipment({ actualWeight: 20 }),
      version,
      context(),
    );

    // 20 kg × ₹10 = ₹200, lifted to the ₹500 floor.
    expect(result.freightAmount.toFixed(2)).toBe("500.00");

    const applied = result.trace.entries.find(
      (e) => e.kind === "MINIMUM" && e.label === "Minimum charge",
    );
    expect(applied?.outcome).toBe("APPLIED");
    expect(applied?.reason).toContain("200.00");
    expect(applied?.reason).toContain("500.00");
  });

  it("leaves the slab result alone when it already clears the minimum", () => {
    const version = card({
      versionId: "v-min2",
      scope: "CUSTOMER",
      slabs: [slab({ id: "s-min2", rate: 10, minimumCharge: 500 })],
    });

    const result = calculateFreight(
      shipment({ actualWeight: 100 }),
      version,
      context(),
    );

    expect(result.freightAmount.toFixed(2)).toBe("1000.00");
    expect(
      result.trace.entries.some((e) => e.label === "Minimum charge"),
    ).toBe(false);
  });

  it("raises the billed weight to the card's floor, and says so", () => {
    const version = card({
      versionId: "v-floor",
      scope: "CUSTOMER",
      slabs: [slab({ id: "s-floor", rate: 20, minimumChargeableKg: 10 })],
    });

    const result = calculateFreight(
      shipment({ actualWeight: 3 }),
      version,
      context(),
    );

    expect(result.chargeableWeight.toFixed(3)).toBe("10.000");
    expect(result.weightBasis).toBe("MINIMUM");
    expect(result.freightAmount.toFixed(2)).toBe("200.00");
  });

  it("matches the band on the real weight, so a floor cannot reprice into a heavier band", () => {
    // The 10 kg floor must not drag a 3 kg parcel into the 10–50 band.
    const version = card({
      versionId: "v-floor2",
      scope: "CUSTOMER",
      slabs: [
        slab({ id: "s-light", weightFromKg: 0, weightToKg: 10, rate: 30, minimumChargeableKg: 10 }),
        slab({ id: "s-heavy", weightFromKg: 10, weightToKg: 50, rate: 12 }),
      ],
    });

    const result = calculateFreight(
      shipment({ actualWeight: 3 }),
      version,
      context(),
    );

    expect(result.selectedSlabId).toBe("s-light");
    expect(result.chargeableWeight.toFixed(3)).toBe("10.000");
    expect(result.freightAmount.toFixed(2)).toBe("300.00");
  });
});

// ────────────────────────────────────────────────────────────
// Fuel surcharge
// ────────────────────────────────────────────────────────────

describe("fuel surcharge", () => {
  const version = card({
    versionId: "v-fuel",
    scope: "CUSTOMER",
    slabs: [slab({ id: "s-fuel", rate: 10 })],
  });

  it("takes a percent of base freight from the rule in force on the pricing date", () => {
    const result = calculateFreight(
      shipment({ actualWeight: 100 }),
      version,
      context({
        fuelChargeTypeId: FUEL.id,
        fuelRules: [
          { id: "fsc-old", percent: 6, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" },
          { id: "fsc-now", percent: 9.5, effectiveFrom: "2026-07-01", effectiveTo: null },
        ],
      }),
    );

    // 100 kg × ₹10 = ₹1,000 base; 9.5% = ₹95.
    const fuelLine = result.lines.find((l) => l.chargeCode === "FSC");
    expect(fuelLine?.amount.toFixed(2)).toBe("95.00");
    expect(result.chargesTotal.toFixed(2)).toBe("1095.00");

    const entry = outcomeOf(result.trace.entries, "fsc-now");
    expect(entry?.outcome).toBe("APPLIED");
    expect(entry?.reason).toContain("9.500%");
  });

  it("uses the superseded rule for a shipment priced while it was live", () => {
    const result = calculateFreight(
      shipment({ actualWeight: 100 }),
      version,
      context({
        at: new Date("2026-05-10T00:00:00.000Z"),
        fuelChargeTypeId: FUEL.id,
        fuelRules: [
          { id: "fsc-old", percent: 6, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" },
          { id: "fsc-now", percent: 9.5, effectiveFrom: "2026-07-01", effectiveTo: null },
        ],
      }),
    );

    expect(result.lines.find((l) => l.chargeCode === "FSC")?.amount.toFixed(2)).toBe("60.00");
  });

  it("stands aside when the rate card prices fuel itself, and records that it did", () => {
    const withOwnFuel = card({
      versionId: "v-fuel2",
      scope: "CUSTOMER",
      slabs: [slab({ id: "s-fuel2", rate: 10 })],
      rules: [
        {
          id: "r-fuel",
          chargeTypeId: FUEL.id,
          basis: "PERCENT_OF_FREIGHT",
          rate: 4,
        },
      ],
    });

    const result = calculateFreight(
      shipment({ actualWeight: 100 }),
      withOwnFuel,
      context({
        fuelChargeTypeId: FUEL.id,
        fuelRules: [{ id: "fsc-now", percent: 9.5, effectiveFrom: "2026-07-01" }],
      }),
    );

    expect(result.lines.filter((l) => l.chargeCode === "FSC")).toHaveLength(1);
    expect(result.lines.find((l) => l.chargeCode === "FSC")?.amount.toFixed(2)).toBe("40.00");

    const skipped = outcomeOf(result.trace.entries, "fsc-now");
    expect(skipped?.outcome).toBe("SKIPPED");
    expect(skipped?.reason).toContain("rate card prices fuel itself");
  });

  it("says so on the trace when no rule was in force", () => {
    const result = calculateFreight(
      shipment({ actualWeight: 100 }),
      version,
      context({ fuelChargeTypeId: FUEL.id, fuelRules: [] }),
    );

    const entry = result.trace.entries.find((e) => e.kind === "FUEL");
    expect(entry?.outcome).toBe("UNAVAILABLE");
    expect(entry?.reason).toContain("no fuel surcharge rule");
  });

  it("picks the latest effective rule when two overlap", () => {
    const rule = fuelRuleOn(
      [
        { id: "a", percent: 5, effectiveFrom: "2026-01-01" },
        { id: "b", percent: 7, effectiveFrom: "2026-08-01" },
      ],
      PRICED_ON,
    );
    expect(rule?.id).toBe("b");
  });
});

// ────────────────────────────────────────────────────────────
// ODA, insurance, COD
// ────────────────────────────────────────────────────────────

describe("charge rules", () => {
  const base = slab({ id: "s-base", rate: 10 });

  it("triggers ODA on an out-of-area destination and skips it otherwise", () => {
    const version = card({
      versionId: "v-oda",
      scope: "CUSTOMER",
      slabs: [base],
      rules: [
        {
          id: "r-oda",
          chargeTypeId: ODA.id,
          basis: "PER_KG",
          rate: 3,
          minimumAmount: 400,
          appliesWhen: { odaOnly: true },
          sortOrder: 10,
        },
      ],
    });

    const inArea = calculateFreight(shipment({ actualWeight: 100 }), version, context());
    expect(inArea.lines.some((l) => l.chargeCode === "ODA")).toBe(false);
    expect(outcomeOf(inArea.trace.entries, "r-oda")?.reason).toBe(
      "destination is not out of delivery area",
    );

    const outOfArea = calculateFreight(
      shipment({ actualWeight: 100, isOda: true }),
      version,
      context(),
    );
    // 100 kg × ₹3 = ₹300, lifted to the ₹400 minimum.
    expect(outOfArea.lines.find((l) => l.chargeCode === "ODA")?.amount.toFixed(2)).toBe("400.00");
    expect(outcomeOf(outOfArea.trace.entries, "r-oda")?.detail?.minimumApplied).toBe("400.00");
  });

  it("charges insurance as a percent of declared value", () => {
    const version = card({
      versionId: "v-ins",
      scope: "CUSTOMER",
      slabs: [base],
      rules: [
        {
          id: "r-ins",
          chargeTypeId: INSURANCE.id,
          basis: "PERCENT_OF_DECLARED_VALUE",
          rate: 0.15,
          minimumAmount: 50,
          appliesWhen: { requiresDeclaredValue: true },
        },
      ],
    });

    const result = calculateFreight(
      shipment({ actualWeight: 100, declaredValue: 250000 }),
      version,
      context(),
    );

    // 0.15% of ₹2,50,000 = ₹375.
    expect(result.lines.find((l) => l.chargeCode === "INS")?.amount.toFixed(2)).toBe("375.00");
  });

  it("skips insurance when nothing was declared, naming the reason", () => {
    const version = card({
      versionId: "v-ins2",
      scope: "CUSTOMER",
      slabs: [base],
      rules: [
        {
          id: "r-ins",
          chargeTypeId: INSURANCE.id,
          basis: "PERCENT_OF_DECLARED_VALUE",
          rate: 0.15,
          appliesWhen: { requiresDeclaredValue: true },
        },
      ],
    });

    const result = calculateFreight(shipment({ actualWeight: 100 }), version, context());
    expect(result.lines.some((l) => l.chargeCode === "INS")).toBe(false);
    expect(outcomeOf(result.trace.entries, "r-ins")?.reason).toBe(
      "no declared value on the consignment",
    );
  });

  it("charges a COD fee as a percent of the COD value with a floor and a ceiling", () => {
    const version = card({
      versionId: "v-cod",
      scope: "CUSTOMER",
      slabs: [base],
      rules: [
        {
          id: "r-cod",
          chargeTypeId: COD_FEE.id,
          basis: "PERCENT_OF_COD",
          rate: 2,
          minimumAmount: 100,
          maximumAmount: 1500,
        },
      ],
    });

    const small = calculateFreight(
      shipment({ actualWeight: 10, paymentType: "COD", codAmount: 2000 }),
      version,
      context(),
    );
    // 2% of ₹2,000 = ₹40, lifted to the ₹100 floor.
    expect(small.lines.find((l) => l.chargeCode === "CODF")?.amount.toFixed(2)).toBe("100.00");

    const large = calculateFreight(
      shipment({ actualWeight: 10, paymentType: "COD", codAmount: 500000 }),
      version,
      context(),
    );
    // 2% of ₹5,00,000 = ₹10,000, capped at ₹1,500.
    expect(large.lines.find((l) => l.chargeCode === "CODF")?.amount.toFixed(2)).toBe("1500.00");
    expect(outcomeOf(large.trace.entries, "r-cod")?.detail?.maximumApplied).toBe("1500.00");
  });

  it("skips a manual rule and says a clerk owns it", () => {
    const version = card({
      versionId: "v-manual",
      scope: "CUSTOMER",
      slabs: [base],
      rules: [
        {
          id: "r-manual",
          chargeTypeId: DOCKET.id,
          basis: "FLAT",
          rate: 75,
          isAutomatic: false,
        },
      ],
    });

    const result = calculateFreight(shipment({ actualWeight: 100 }), version, context());
    expect(outcomeOf(result.trace.entries, "r-manual")?.reason).toContain("manual");
  });

  it("skips a rule whose charge head is not loaded rather than pricing it at zero", () => {
    const version = card({
      versionId: "v-orphan",
      scope: "CUSTOMER",
      slabs: [base],
      rules: [{ id: "r-orphan", chargeTypeId: "ct-retired", basis: "FLAT", rate: 90 }],
    });

    const result = calculateFreight(shipment({ actualWeight: 100 }), version, context());
    expect(outcomeOf(result.trace.entries, "r-orphan")?.reason).toContain("charge head");
  });

  it("charges detention only beyond the free time", () => {
    const version = card({
      versionId: "v-det",
      scope: "CUSTOMER",
      slabs: [slab({ id: "s-ftl", basis: "PER_TRIP", rate: 18000 })],
      rules: [{ id: "r-det", chargeTypeId: DOCKET.id, basis: "PER_HOUR", rate: 250 }],
    });

    const within = calculateFreight(
      shipment({ mode: "FTL", actualWeight: 9000 }),
      version,
      context({ detentionHours: 4, freeDetentionHours: 6 }),
    );
    expect(outcomeOf(within.trace.entries, "r-det")?.reason).toContain("free time");

    const beyond = calculateFreight(
      shipment({ mode: "FTL", actualWeight: 9000 }),
      version,
      context({ detentionHours: 10, freeDetentionHours: 6 }),
    );
    expect(beyond.lines.find((l) => l.ruleId === "r-det")?.amount.toFixed(2)).toBe("1000.00");
  });
});

// ────────────────────────────────────────────────────────────
// Specificity ordering
// ────────────────────────────────────────────────────────────

describe("resolution order", () => {
  const customerCityPair = slab({
    id: "s-cust-city",
    originCityId: "city-del",
    destinationCityId: "city-jai",
    rate: 9,
  });
  const customerZonePair = slab({
    id: "s-cust-zone",
    originZoneId: "zone-north",
    destinationZoneId: "zone-north",
    rate: 11,
  });
  const customerDefault = slab({ id: "s-cust-any", rate: 13 });

  const publishedCityPair = slab({
    id: "s-pub-city",
    originCityId: "city-del",
    destinationCityId: "city-jai",
    rate: 15,
  });
  const publishedDefault = slab({ id: "s-pub-any", rate: 20 });

  const customerCard = card({
    versionId: "v-cust",
    scope: "CUSTOMER",
    slabs: [customerDefault, customerZonePair, customerCityPair],
  });
  const publishedCard = card({
    versionId: "v-pub",
    scope: "PUBLISHED",
    slabs: [publishedDefault, publishedCityPair],
  });

  it("lets a customer city pair beat everything else", () => {
    const result = calculateFreight(
      shipment({ actualWeight: 100 }),
      [customerCard, publishedCard],
      context(),
    );

    expect(result.selectedSlabId).toBe("s-cust-city");
    expect(result.freightAmount.toFixed(2)).toBe("900.00");
  });

  it("falls to the customer zone pair when the city pair does not cover the lane", () => {
    const result = calculateFreight(
      shipment({ actualWeight: 100, destinationCityId: "city-udr" }),
      [customerCard, publishedCard],
      context(),
    );

    expect(result.selectedSlabId).toBe("s-cust-zone");
    expect(result.freightAmount.toFixed(2)).toBe("1100.00");
  });

  it("falls to the customer default when neither lane rule matches", () => {
    const result = calculateFreight(
      shipment({
        actualWeight: 100,
        destinationCityId: "city-ccu",
        destinationZoneIds: ["zone-east"],
      }),
      [customerCard, publishedCard],
      context(),
    );

    expect(result.selectedSlabId).toBe("s-cust-any");
  });

  it("uses the published lane rate when the customer has no card at all", () => {
    const result = calculateFreight(
      shipment({ actualWeight: 100 }),
      [publishedCard],
      context(),
    );

    expect(result.selectedSlabId).toBe("s-pub-city");
    expect(result.freightAmount.toFixed(2)).toBe("1500.00");
  });

  it("never lets a published city pair outrank a customer default", () => {
    const thinCustomerCard = card({
      versionId: "v-cust-thin",
      scope: "CUSTOMER",
      slabs: [customerDefault],
    });

    const result = calculateFreight(
      shipment({ actualWeight: 100 }),
      [thinCustomerCard, publishedCard],
      context(),
    );

    expect(result.selectedSlabId).toBe("s-cust-any");
    expect(specificityRank("CUSTOMER", "ANY")).toBeLessThan(
      specificityRank("PUBLISHED", "CITY_PAIR"),
    );
  });

  it("names on the trace exactly what each losing rule lost to", () => {
    const result = calculateFreight(
      shipment({ actualWeight: 100 }),
      [customerCard, publishedCard],
      context(),
    );

    const winner = outcomeOf(result.trace.entries, "s-cust-city");
    expect(winner?.outcome).toBe("MATCHED");
    expect(winner?.specificity).toBe("customer city pair");

    const zone = outcomeOf(result.trace.entries, "s-cust-zone");
    expect(zone?.outcome).toBe("SKIPPED");
    expect(zone?.reason).toContain("customer city pair beat customer zone pair");

    const published = outcomeOf(result.trace.entries, "s-pub-city");
    expect(published?.outcome).toBe("SKIPPED");
    expect(published?.reason).toContain("published city pair");
  });

  it("breaks a tie inside one tier on the slab's priority", () => {
    const tied = card({
      versionId: "v-tie",
      scope: "CUSTOMER",
      slabs: [
        slab({ id: "s-a", rate: 10, priority: 1 }),
        slab({ id: "s-b", rate: 7, priority: 5 }),
      ],
    });

    const result = calculateFreight(shipment({ actualWeight: 100 }), tied, context());
    expect(result.selectedSlabId).toBe("s-b");
  });

  it("ignores a draft version, and says why", () => {
    const draft = card({
      versionId: "v-draft",
      scope: "CUSTOMER",
      isApproved: false,
      slabs: [slab({ id: "s-draft", rate: 1 })],
    });

    const result = calculateFreight(
      shipment({ actualWeight: 100 }),
      [draft, publishedCard],
      context(),
    );

    expect(result.selectedSlabId).toBe("s-pub-city");
    expect(outcomeOf(result.trace.entries, "v-draft")?.reason).toContain("draft");
  });

  it("ignores a version that had expired on the pricing date", () => {
    const expired = card({
      versionId: "v-old",
      scope: "CUSTOMER",
      effectiveFrom: "2025-04-01",
      effectiveTo: "2026-03-31",
      slabs: [slab({ id: "s-old", rate: 4 })],
    });

    const result = calculateFreight(
      shipment({ actualWeight: 100 }),
      [expired, publishedCard],
      context(),
    );

    expect(result.selectedVersionId).toBe("v-pub");
    expect(outcomeOf(result.trace.entries, "v-old")?.reason).toContain("in force");
  });
});

// ────────────────────────────────────────────────────────────
// Unrated lanes
// ────────────────────────────────────────────────────────────

describe("unrated lanes", () => {
  it("flags rather than pricing at zero when no card resolves", () => {
    const result = calculateFreight(shipment({ actualWeight: 100 }), [], context());

    expect(result.unrated).toBe(true);
    expect(result.unratedReason).toContain("No rate card resolved");
    expect(result.total.toFixed(2)).toBe("0.00");
    expect(result.lines).toHaveLength(0);
  });

  it("flags when a card exists but no slab covers the lane", () => {
    const version = card({
      versionId: "v-gap",
      scope: "CUSTOMER",
      slabs: [
        slab({
          id: "s-gap",
          originCityId: "city-bom",
          destinationCityId: "city-pnq",
          rate: 12,
        }),
      ],
    });

    const result = calculateFreight(shipment({ actualWeight: 100 }), version, context());

    expect(result.unrated).toBe(true);
    expect(result.unratedReason).toContain("No slab");
    expect(result.freightAmount.toFixed(2)).toBe("0.00");
    expect(outcomeOf(result.trace.entries, "s-gap")?.reason).toContain("origin city");
  });

  it("still writes a readable trace so the gap can be closed", () => {
    const result = calculateFreight(shipment({ actualWeight: 100 }), [], context());

    expect(result.trace.selectedSlabId).toBeNull();
    expect(result.trace.narrative.join(" ")).toContain("coverage-gap");
    expect(result.trace.entries.some((e) => e.outcome === "UNAVAILABLE")).toBe(true);
  });

  it("does not apply percent-of-freight rules to a zero base", () => {
    const version = card({
      versionId: "v-gap2",
      scope: "CUSTOMER",
      slabs: [slab({ id: "s-gap2", originCityId: "city-bom", rate: 12 })],
      rules: [{ id: "r-fsc", chargeTypeId: FUEL.id, basis: "PERCENT_OF_FREIGHT", rate: 9 }],
    });

    const result = calculateFreight(shipment({ actualWeight: 100 }), version, context());
    expect(result.lines).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────
// Tax and reverse charge
// ────────────────────────────────────────────────────────────

describe("tax", () => {
  const version = card({
    versionId: "v-tax",
    scope: "CUSTOMER",
    slabs: [slab({ id: "s-tax", rate: 10 })],
    rules: [{ id: "r-doc", chargeTypeId: DOCKET.id, basis: "FLAT", rate: 100 }],
  });

  it("adds GST on the whole taxable value under forward charge", () => {
    const result = calculateFreight(shipment({ actualWeight: 100 }), version, context());

    expect(result.chargesTotal.toFixed(2)).toBe("1100.00");
    expect(result.taxTotal.toFixed(2)).toBe("198.00");
    expect(result.total.toFixed(2)).toBe("1298.00");
    expect(result.taxes).toHaveLength(1);
    expect(result.taxes[0].isReverseCharge).toBe(false);
  });

  it("states the tax but keeps it out of the total under reverse charge", () => {
    const result = calculateFreight(
      shipment({ actualWeight: 100, isReverseCharge: true }),
      version,
      context(),
    );

    expect(result.chargesTotal.toFixed(2)).toBe("1100.00");
    expect(result.taxTotal.toFixed(2)).toBe("0.00");
    expect(result.total.toFixed(2)).toBe("1100.00");
    // The figure is still computed and stated — the recipient has to pay it.
    expect(result.taxes[0].amount.toFixed(2)).toBe("198.00");
    expect(result.taxes[0].isReverseCharge).toBe(true);

    const entry = result.trace.entries.find((e) => e.label === "Reverse charge");
    expect(entry?.reason).toContain("payable by the recipient");
  });

  it("groups one tax line per rate", () => {
    const mixed = card({
      versionId: "v-mixed",
      scope: "CUSTOMER",
      slabs: [slab({ id: "s-mixed", rate: 10 })],
      rules: [
        { id: "r-a", chargeTypeId: DOCKET.id, basis: "FLAT", rate: 100 },
        { id: "r-b", chargeTypeId: ODA.id, basis: "FLAT", rate: 200 },
      ],
    });

    const result = calculateFreight(shipment({ actualWeight: 100 }), mixed, context());
    expect(result.taxes).toHaveLength(1);
    expect(result.taxes[0].taxableValue.toFixed(2)).toBe("1300.00");
  });
});

// ────────────────────────────────────────────────────────────
// The trace as a whole
// ────────────────────────────────────────────────────────────

describe("trace", () => {
  it("answers 'why is this ₹4,280?' without re-running anything", () => {
    const version = card({
      versionId: "v-story",
      scope: "CUSTOMER",
      slabs: [
        slab({
          id: "s-story",
          originCityId: "city-del",
          destinationCityId: "city-jai",
          weightFromKg: 200,
          weightToKg: 500,
          rate: 16,
          minimumCharge: 1500,
        }),
      ],
      rules: [
        { id: "r-doc", chargeTypeId: DOCKET.id, basis: "FLAT", rate: 100, sortOrder: 1 },
      ],
    });

    const result = calculateFreight(
      shipment({ actualWeight: 250 }),
      version,
      context({
        fuelChargeTypeId: FUEL.id,
        fuelRules: [{ id: "fsc", percent: 8, effectiveFrom: "2026-04-01" }],
      }),
    );

    // 250 × 16 = 4,000; docket 100; fuel 8% of 4,000 = 320. Charges 4,420.
    expect(result.freightAmount.toFixed(2)).toBe("4000.00");
    expect(result.chargesTotal.toFixed(2)).toBe("4420.00");

    const story = result.trace.narrative.join("\n");
    expect(story).toContain("250.000 kg × ₹16.0000 per kg");
    expect(story).toContain("Fuel surcharge: 8.000% of ₹4000.00 = ₹320.00");
    expect(story).toContain("Charges ₹4420.00");
  });

  it("records the shipment snapshot it priced, so the inputs are not lost", () => {
    const version = card({
      versionId: "v-snap",
      scope: "CUSTOMER",
      slabs: [slab({ id: "s-snap", rate: 10 })],
    });

    const result = calculateFreight(
      shipment({ actualWeight: 100, declaredValue: 5000, isOda: true }),
      version,
      context(),
    );

    expect(result.trace.shipment.chargeableWeight).toBe("100.000");
    expect(result.trace.shipment.declaredValue).toBe("5000.00");
    expect(result.trace.shipment.isOda).toBe("true");
    expect(result.trace.candidates[0].rateCardCode).toBe("ACME-2026");
  });

  it("serialises to JSON, because it is stored as JSON", () => {
    const version = card({
      versionId: "v-json",
      scope: "CUSTOMER",
      slabs: [slab({ id: "s-json", rate: 10 })],
    });

    const result = calculateFreight(shipment({ actualWeight: 100 }), version, context());
    const round = JSON.parse(JSON.stringify(result.trace));
    expect(round.selectedSlabId).toBe("s-json");
    expect(Array.isArray(round.entries)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// Building blocks
// ────────────────────────────────────────────────────────────

describe("matchSlab", () => {
  it("refuses a slab pinned to another mode", () => {
    const result = matchSlab(
      slab({ id: "s", mode: "FTL" }),
      shipment(),
      dec(100),
    );
    expect(result).toEqual({ ok: false, reason: "slab is for FTL, this is PTL" });
  });

  it("matches a zone slab when the PIN belongs to that zone among others", () => {
    const result = matchSlab(
      slab({ id: "s", destinationZoneId: "zone-north" }),
      shipment({ destinationZoneIds: ["zone-metro", "zone-north"] }),
      dec(100),
    );
    expect(result.ok).toBe(true);
  });
});

describe("conditionFailure", () => {
  it("passes a rule with no condition at all", () => {
    expect(conditionFailure(null, shipment(), dec(10))).toBeNull();
  });

  it("names the weight bound it failed", () => {
    expect(
      conditionFailure({ minChargeableKg: 50 }, shipment(), dec(20)),
    ).toContain("under 50.000 kg");
  });
});

describe("isEffectiveOn", () => {
  it("is inclusive at both ends", () => {
    expect(isEffectiveOn(new Date("2026-04-01"), "2026-04-01", "2027-03-31")).toBe(true);
    expect(isEffectiveOn(new Date("2027-03-31"), "2026-04-01", "2027-03-31")).toBe(true);
    expect(isEffectiveOn(new Date("2027-04-01"), "2026-04-01", "2027-03-31")).toBe(false);
  });

  it("treats a null end date as open", () => {
    expect(isEffectiveOn(new Date("2030-01-01"), "2026-04-01", null)).toBe(true);
  });

  /**
   * The pricing date is the carrier's day, not the server's.
   *
   * `effectiveFrom` comes out of a `@db.Date` column as UTC midnight, but
   * `context.at` is an instant — and a booking taken at 01:00 IST on
   * 1 April is 19:30 UTC on 31 March. Truncated in UTC it priced against
   * the tariff that expired the night before, and the trace said the new
   * version "was not in force on the pricing date" while the contract said
   * it was. Asserted on fixed instants so the answer does not depend on
   * where this test runs.
   */
  it("prices a booking taken after midnight IST on the day it was taken", () => {
    const oneInTheMorningOnTheFirst = new Date("2026-03-31T19:30:00.000Z");

    expect(isEffectiveOn(oneInTheMorningOnTheFirst, "2026-04-01", null)).toBe(true);
    // And the version that closed the night before is correctly finished.
    expect(
      isEffectiveOn(oneInTheMorningOnTheFirst, "2025-04-01", "2026-03-31"),
    ).toBe(false);
  });

  it("still ends a version at the last moment of its final Indian day", () => {
    // 23:00 IST on 31 March: the old card is still the one in force.
    const lateOnTheLastDay = new Date("2026-03-31T17:30:00.000Z");

    expect(isEffectiveOn(lateOnTheLastDay, "2025-04-01", "2026-03-31")).toBe(true);
    expect(isEffectiveOn(lateOnTheLastDay, "2026-04-01", null)).toBe(false);
  });
});
