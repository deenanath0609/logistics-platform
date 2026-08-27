import Decimal from "decimal.js";

/**
 * Weight arithmetic.
 *
 * Pure and separately testable, because this is the number the customer
 * is billed on and every disagreement about an invoice starts here.
 */

export type Dimensions = {
  lengthCm?: number | null;
  breadthCm?: number | null;
  heightCm?: number | null;
};

/**
 * Volumetric weight in kg: (L × B × H in cm) ÷ divisor.
 *
 * The divisor comes from the service type — road freight in India
 * commonly uses 4500 or 5000, and the difference is real money on a
 * light, bulky consignment.
 */
export function volumetricWeight(
  dimensions: Dimensions,
  divisor: number,
): Decimal {
  const { lengthCm, breadthCm, heightCm } = dimensions;
  if (!lengthCm || !breadthCm || !heightCm) return new Decimal(0);
  if (divisor <= 0) throw new Error("Volumetric divisor must be positive");

  return new Decimal(lengthCm)
    .times(breadthCm)
    .times(heightCm)
    .dividedBy(divisor);
}

/** Volumetric weight of a whole consignment. */
export function totalVolumetricWeight(
  packages: Dimensions[],
  divisor: number,
): Decimal {
  return packages.reduce(
    (sum, pkg) => sum.plus(volumetricWeight(pkg, divisor)),
    new Decimal(0),
  );
}

/**
 * Rounds up to the next billing step.
 *
 * Rounding up is the industry convention and is what the rate card
 * expects; rounding to nearest would quietly under-bill half the time.
 */
export function roundUpToStep(weight: Decimal, stepKg = 0.5): Decimal {
  if (stepKg <= 0) return weight;
  return weight.dividedBy(stepKg).ceil().times(stepKg);
}

export type ChargeableWeightInput = {
  actualWeight: number | Decimal;
  packages: Dimensions[];
  volumetricDivisor: number;
  /** Rate cards may set a floor per shipment (Phase 6). */
  minimumChargeableKg?: number;
  stepKg?: number;
};

export type ChargeableWeightResult = {
  actual: Decimal;
  volumetric: Decimal;
  /** max(actual, volumetric), rounded up, then floored at the minimum. */
  chargeable: Decimal;
  /** Which figure won — useful to show the clerk why the number moved. */
  basis: "ACTUAL" | "VOLUMETRIC" | "MINIMUM";
};

export function chargeableWeight(
  input: ChargeableWeightInput,
): ChargeableWeightResult {
  const actual = new Decimal(input.actualWeight);
  const volumetric = totalVolumetricWeight(
    input.packages,
    input.volumetricDivisor,
  );

  const greater = volumetric.greaterThan(actual) ? volumetric : actual;
  let basis: ChargeableWeightResult["basis"] = volumetric.greaterThan(actual)
    ? "VOLUMETRIC"
    : "ACTUAL";

  let chargeable = roundUpToStep(greater, input.stepKg ?? 0.5);

  const minimum = new Decimal(input.minimumChargeableKg ?? 0);
  if (minimum.greaterThan(chargeable)) {
    chargeable = minimum;
    basis = "MINIMUM";
  }

  return {
    actual: actual.toDecimalPlaces(3),
    volumetric: volumetric.toDecimalPlaces(3),
    chargeable: chargeable.toDecimalPlaces(3),
    basis,
  };
}
