import { describe, expect, it } from "vitest";
import {
  resolveSupplyPlace,
  splitTax,
  stateCodeFromGstin,
  taxSummary,
} from "./gst";

describe("stateCodeFromGstin", () => {
  it("reads the first two digits", () => {
    expect(stateCodeFromGstin("08AABCU9603R1ZM")).toBe("08");
    expect(stateCodeFromGstin(" 27AAACR5055K1Z7 ")).toBe("27");
  });

  it("refuses anything that is not two digits", () => {
    expect(stateCodeFromGstin(null)).toBeNull();
    expect(stateCodeFromGstin("")).toBeNull();
    expect(stateCodeFromGstin("XX07ABC")).toBeNull();
  });
});

describe("resolveSupplyPlace", () => {
  it("compares GST state codes before names", () => {
    const place = resolveSupplyPlace({
      sellerGstin: "08AABCU9603R1ZM",
      buyerGstin: "08AAACR5055K1Z7",
      placeOfSupply: "Rajasthan",
    });
    expect(place.isIntraState).toBe(true);
    expect(place.sellerStateCode).toBe("08");
    expect(place.isUndetermined).toBe(false);
  });

  it("calls a different code inter-state", () => {
    const place = resolveSupplyPlace({
      sellerGstin: "08AABCU9603R1ZM",
      buyerGstin: "07AAACR5055K1Z7",
    });
    expect(place.isIntraState).toBe(false);
  });

  it("falls back to state names when a GSTIN is missing", () => {
    const place = resolveSupplyPlace({
      sellerStateName: "Rajasthan",
      placeOfSupply: "  rajasthan ",
    });
    expect(place.isIntraState).toBe(true);
    expect(place.isUndetermined).toBe(false);
  });

  it("says so rather than guessing when neither side is known", () => {
    const place = resolveSupplyPlace({});
    expect(place.isUndetermined).toBe(true);
    // Inter-state states the whole tax as IGST rather than inventing a split.
    expect(place.isIntraState).toBe(false);
  });
});

describe("splitTax", () => {
  it("halves an intra-state supply into CGST and SGST", () => {
    const split = splitTax("795.60", true);
    expect(split.cgst.toFixed(2)).toBe("397.80");
    expect(split.sgst.toFixed(2)).toBe("397.80");
    expect(split.igst.toFixed(2)).toBe("0.00");
  });

  it("never loses a paise to rounding", () => {
    const split = splitTax("100.01", true);
    expect(split.cgst.plus(split.sgst).toFixed(2)).toBe("100.01");
    expect(split.cgst.toFixed(2)).toBe("50.01");
    expect(split.sgst.toFixed(2)).toBe("50.00");
  });

  it("puts the whole figure on IGST for an inter-state supply", () => {
    const split = splitTax("795.60", false);
    expect(split.igst.toFixed(2)).toBe("795.60");
    expect(split.cgst.toFixed(2)).toBe("0.00");
  });
});

describe("taxSummary", () => {
  const lines = [
    { amount: "4000.00", taxPercent: "18", taxAmount: "720.00", hsnSac: "996791" },
    { amount: "320.00", taxPercent: "18", taxAmount: "57.60", hsnSac: "996791" },
    { amount: "100.00", taxPercent: "5", taxAmount: "5.00", hsnSac: "996511" },
  ];

  it("groups by HSN and rate rather than by line", () => {
    const summary = taxSummary(lines, true);
    expect(summary.rows).toHaveLength(2);

    const gta = summary.rows.find((row) => row.hsnSac === "996791");
    expect(gta?.taxableValue.toFixed(2)).toBe("4320.00");
    expect(gta?.cgst.toFixed(2)).toBe("388.80");
    expect(gta?.sgst.toFixed(2)).toBe("388.80");
  });

  it("totals to the same figure whichever way the supply splits", () => {
    const intra = taxSummary(lines, true);
    const inter = taxSummary(lines, false);

    expect(intra.totals.taxableValue.toFixed(2)).toBe("4420.00");
    expect(intra.totals.total.toFixed(2)).toBe("782.60");
    expect(inter.totals.total.toFixed(2)).toBe("782.60");
    expect(inter.totals.igst.toFixed(2)).toBe("782.60");
    expect(intra.totals.igst.toFixed(2)).toBe("0.00");
  });

  it("keeps uncoded lines in their own group without printing 'null'", () => {
    const summary = taxSummary([{ amount: "50", taxPercent: "18", taxAmount: "9" }], false);
    expect(summary.rows[0].hsnSac).toBe("");
  });
});
