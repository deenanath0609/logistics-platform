import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  volumetricWeight,
  totalVolumetricWeight,
  roundUpToStep,
  chargeableWeight,
} from "./weight";

describe("volumetricWeight", () => {
  it("divides the cubic volume by the service divisor", () => {
    // 100 × 50 × 40 = 200,000 cm³ ÷ 5000 = 40 kg
    expect(
      volumetricWeight(
        { lengthCm: 100, breadthCm: 50, heightCm: 40 },
        5000,
      ).toNumber(),
    ).toBe(40);
  });

  it("gives a heavier figure on the tighter 4500 divisor", () => {
    const at5000 = volumetricWeight(
      { lengthCm: 100, breadthCm: 50, heightCm: 40 },
      5000,
    );
    const at4500 = volumetricWeight(
      { lengthCm: 100, breadthCm: 50, heightCm: 40 },
      4500,
    );
    expect(at4500.greaterThan(at5000)).toBe(true);
  });

  it("is zero when any dimension is missing", () => {
    expect(
      volumetricWeight({ lengthCm: 100, breadthCm: 50 }, 5000).toNumber(),
    ).toBe(0);
    expect(volumetricWeight({}, 5000).toNumber()).toBe(0);
  });

  it("refuses a non-positive divisor rather than dividing by zero", () => {
    expect(() =>
      volumetricWeight({ lengthCm: 1, breadthCm: 1, heightCm: 1 }, 0),
    ).toThrow(/divisor/i);
  });
});

describe("totalVolumetricWeight", () => {
  it("sums across every package", () => {
    expect(
      totalVolumetricWeight(
        [
          { lengthCm: 100, breadthCm: 50, heightCm: 40 }, // 40
          { lengthCm: 50, breadthCm: 50, heightCm: 20 }, // 10
        ],
        5000,
      ).toNumber(),
    ).toBe(50);
  });

  it("is zero for no packages", () => {
    expect(totalVolumetricWeight([], 5000).toNumber()).toBe(0);
  });
});

describe("roundUpToStep", () => {
  it("rounds up, never to nearest", () => {
    expect(roundUpToStep(new Decimal(10.1)).toNumber()).toBe(10.5);
    expect(roundUpToStep(new Decimal(10.6)).toNumber()).toBe(11);
  });

  it("leaves a figure already on the step alone", () => {
    expect(roundUpToStep(new Decimal(10.5)).toNumber()).toBe(10.5);
  });
});

describe("chargeableWeight", () => {
  it("bills on actual weight for dense goods", () => {
    const result = chargeableWeight({
      actualWeight: 120,
      packages: [{ lengthCm: 50, breadthCm: 40, heightCm: 30 }], // 12 kg volumetric
      volumetricDivisor: 5000,
    });

    expect(result.basis).toBe("ACTUAL");
    expect(result.chargeable.toNumber()).toBe(120);
  });

  it("bills on volumetric weight for light, bulky goods", () => {
    const result = chargeableWeight({
      actualWeight: 12,
      packages: [{ lengthCm: 100, breadthCm: 50, heightCm: 40 }], // 40 kg volumetric
      volumetricDivisor: 5000,
    });

    expect(result.basis).toBe("VOLUMETRIC");
    expect(result.chargeable.toNumber()).toBe(40);
    // The actual weight is still reported — the customer will ask.
    expect(result.actual.toNumber()).toBe(12);
  });

  it("applies the rate card minimum when both figures are tiny", () => {
    const result = chargeableWeight({
      actualWeight: 0.4,
      packages: [],
      volumetricDivisor: 5000,
      minimumChargeableKg: 5,
    });

    expect(result.basis).toBe("MINIMUM");
    expect(result.chargeable.toNumber()).toBe(5);
  });

  it("rounds the winning figure up to the billing step", () => {
    const result = chargeableWeight({
      actualWeight: 47.2,
      packages: [],
      volumetricDivisor: 5000,
    });

    expect(result.chargeable.toNumber()).toBe(47.5);
  });

  it("keeps three decimals, so a gram never disappears silently", () => {
    const result = chargeableWeight({
      actualWeight: 12.345,
      packages: [],
      volumetricDivisor: 5000,
      stepKg: 0,
    });

    expect(result.actual.toNumber()).toBe(12.345);
  });
});
