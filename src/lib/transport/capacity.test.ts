import { describe, expect, it } from "vitest";
import { utilisation, utilisationBand } from "./capacity";

/**
 * Vehicle capacity utilisation.
 *
 * This is the one number on the dispatch screen a supervisor acts on: it
 * is what stops a half-empty truck leaving and what stops an overloaded
 * one leaving, and both of those are decisions made in a glance at a
 * coloured bar. So the boundaries between the bands are the whole test —
 * a truck at exactly 85% being called FULL rather than HEALTHY is not a
 * cosmetic difference, it is the difference between holding the vehicle
 * for more freight and letting it go.
 *
 * The module had no test at all despite four screens calling it.
 */
describe("utilisationBand", () => {
  it("calls an empty vehicle empty", () => {
    expect(utilisationBand(0)).toBe("EMPTY");
  });

  it("treats anything at all on board as loaded", () => {
    expect(utilisationBand(0.1)).toBe("LIGHT");
  });

  it("holds LIGHT right up to the healthy mark", () => {
    expect(utilisationBand(59.9)).toBe("LIGHT");
    expect(utilisationBand(60)).toBe("HEALTHY");
  });

  it("holds HEALTHY right up to the full mark", () => {
    expect(utilisationBand(84.9)).toBe("HEALTHY");
    expect(utilisationBand(85)).toBe("FULL");
  });

  // The line that matters legally: a truck exactly on its rated payload is
  // loaded, not overloaded.
  it("does not call a vehicle on its rated payload overloaded", () => {
    expect(utilisationBand(100)).toBe("FULL");
    expect(utilisationBand(100.1)).toBe("OVERLOADED");
  });

  it("a negative reading is not a load", () => {
    expect(utilisationBand(-5)).toBe("EMPTY");
  });
});

describe("utilisation", () => {
  it("reports the percentage, the headroom and the band together", () => {
    const result = utilisation(2400, 3000);

    expect(result.percent).toBe(80);
    expect(result.headroomKg).toBe(600);
    expect(result.band).toBe("HEALTHY");
    expect(result.tone).toBe("ok");
    expect(result.capacityKg).toBe(3000);
  });

  it("rounds the percentage to one decimal place", () => {
    // 1000/3000 is 33.333…; a dispatcher does not need the rest of it.
    expect(utilisation(1000, 3000).percent).toBe(33.3);
    expect(utilisation(2000, 3000).percent).toBe(66.7);
  });

  it("reports negative headroom on an overloaded vehicle", () => {
    const result = utilisation(3600, 3000);

    expect(result.percent).toBe(120);
    expect(result.headroomKg).toBe(-600);
    expect(result.band).toBe("OVERLOADED");
    expect(result.tone).toBe("bad");
    expect(result.label).toContain("rated payload");
  });

  it("colours a light load as a warning, because that is the point", () => {
    const result = utilisation(900, 3000);

    expect(result.band).toBe("LIGHT");
    expect(result.tone).toBe("warn");
    expect(result.label).toContain("Running light");
  });

  it("says nothing rather than guessing when the capacity is unknown", () => {
    for (const capacity of [null, undefined, 0]) {
      const result = utilisation(1200, capacity);

      expect(result.percent).toBeNull();
      expect(result.capacityKg).toBeNull();
      expect(result.headroomKg).toBeNull();
      expect(result.tone).toBe("muted");
      expect(result.label).toBe("No capacity on file for this vehicle type");
    }
  });

  // A vehicle type with no capacity on file still has freight on it, and
  // the band says so even though the tone stays muted — the bar has
  // nothing to fill, but the dispatcher should not read "empty".
  it("still distinguishes loaded from empty with no capacity on file", () => {
    expect(utilisation(1200, null).band).toBe("LIGHT");
    expect(utilisation(0, null).band).toBe("EMPTY");
  });

  it("refuses a negative weight rather than inverting the bar", () => {
    const result = utilisation(-500, 3000);

    expect(result.weightKg).toBe(0);
    expect(result.percent).toBe(0);
    expect(result.band).toBe("EMPTY");
  });

  // A summed Decimal column that went wrong upstream must not paint the
  // bar at NaN%, which renders as a blank bar and reads as "empty".
  it("treats a non-finite weight as nothing loaded", () => {
    for (const weight of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = utilisation(weight, 3000);

      expect(result.weightKg).toBe(0);
      expect(result.percent).toBe(0);
      expect(result.band).toBe("EMPTY");
    }
  });

  it("rounds headroom to grams, not to floating-point noise", () => {
    // 3000 − 1234.567 is 1765.4329999999998 in binary floating point.
    expect(utilisation(1234.567, 3000).headroomKg).toBe(1765.433);
  });

  it("an exactly full vehicle has no headroom left", () => {
    const result = utilisation(3000, 3000);

    expect(result.percent).toBe(100);
    expect(result.headroomKg).toBe(0);
    expect(result.band).toBe("FULL");
    expect(result.tone).toBe("ok");
  });
});
