import { describe, expect, it } from "vitest";
import { totalInvoice, totalVendorBill } from "./totals";

describe("totalInvoice", () => {
  const lines = [
    { amount: "4000.00", taxAmount: "720.00" },
    { amount: "320.00", taxAmount: "57.60" },
    { amount: "100.00", taxAmount: "18.00" },
  ];

  it("adds tax to the total under forward charge", () => {
    const totals = totalInvoice(lines, false);
    expect(totals.subtotal.toFixed(2)).toBe("4420.00");
    expect(totals.taxAmount.toFixed(2)).toBe("795.60");
    expect(totals.total.toFixed(2)).toBe("5216.00");
    // 4420 + 795.60 = 5215.60, rounded up to 5216 — the 40 paise is kept.
    expect(totals.roundOff.toFixed(2)).toBe("0.40");
  });

  it("states the tax but keeps it out of the total under reverse charge", () => {
    const totals = totalInvoice(lines, true);
    expect(totals.subtotal.toFixed(2)).toBe("4420.00");
    expect(totals.statedTax.toFixed(2)).toBe("795.60");
    expect(totals.taxAmount.toFixed(2)).toBe("0.00");
    expect(totals.total.toFixed(2)).toBe("4420.00");
    expect(totals.roundOff.toFixed(2)).toBe("0.00");
  });

  it("rounds down when the paise are below half a rupee", () => {
    const totals = totalInvoice([{ amount: "100.20" }], false);
    expect(totals.total.toFixed(2)).toBe("100.00");
    expect(totals.roundOff.toFixed(2)).toBe("-0.20");
  });

  it("keeps the round-off reconciling: subtotal + tax + roundOff = total", () => {
    const totals = totalInvoice(lines, false);
    expect(
      totals.subtotal.plus(totals.taxAmount).plus(totals.roundOff).toFixed(2),
    ).toBe(totals.total.toFixed(2));
  });

  it("handles an empty invoice without producing NaN", () => {
    const totals = totalInvoice([], false);
    expect(totals.subtotal.toFixed(2)).toBe("0.00");
    expect(totals.total.toFixed(2)).toBe("0.00");
  });

  it("adds a hundred paise-level lines without drift", () => {
    const many = Array.from({ length: 100 }, () => ({ amount: "0.07" }));
    expect(totalInvoice(many, false).subtotal.toFixed(2)).toBe("7.00");
  });
});

describe("totalVendorBill", () => {
  it("takes TDS, deductions and the advance off what we transfer", () => {
    const totals = totalVendorBill({
      lines: [{ amount: "50000.00", taxPercent: "5" }],
      tdsPercent: "2",
      deductions: "1500",
      advanceAdjusted: "20000",
    });

    expect(totals.subtotal.toFixed(2)).toBe("50000.00");
    expect(totals.taxAmount.toFixed(2)).toBe("2500.00");
    expect(totals.tdsAmount.toFixed(2)).toBe("1000.00");
    // 50,000 + 2,500 − 1,000 − 1,500 − 20,000 = 30,000
    expect(totals.total.toFixed(2)).toBe("30000.00");
  });

  it("prefers an explicit TDS figure over the vendor's default rate", () => {
    const totals = totalVendorBill({
      lines: [{ amount: "10000" }],
      tdsPercent: "2",
      tdsAmount: "0",
    });
    expect(totals.tdsAmount.toFixed(2)).toBe("0.00");
    expect(totals.total.toFixed(2)).toBe("10000.00");
  });

  it("leaves the earned amount alone — deductions do not touch the subtotal", () => {
    const totals = totalVendorBill({
      lines: [{ amount: "8000" }],
      deductions: "3000",
    });
    expect(totals.subtotal.toFixed(2)).toBe("8000.00");
    expect(totals.total.toFixed(2)).toBe("5000.00");
  });
});
