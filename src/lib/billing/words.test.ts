import { describe, expect, it } from "vitest";
import { amountInWords, numberToIndianWords } from "./words";

describe("numberToIndianWords", () => {
  it("names the small numbers", () => {
    expect(numberToIndianWords(0)).toBe("Zero");
    expect(numberToIndianWords(7)).toBe("Seven");
    expect(numberToIndianWords(15)).toBe("Fifteen");
    expect(numberToIndianWords(40)).toBe("Forty");
    expect(numberToIndianWords(99)).toBe("Ninety Nine");
    expect(numberToIndianWords(100)).toBe("One Hundred");
    expect(numberToIndianWords(101)).toBe("One Hundred One");
  });

  it("groups in lakh and crore, not millions", () => {
    expect(numberToIndianWords(1000)).toBe("One Thousand");
    expect(numberToIndianWords(100_000)).toBe("One Lakh");
    expect(numberToIndianWords(1_00_00_000)).toBe("One Crore");
    expect(numberToIndianWords(12_34_567)).toBe(
      "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven",
    );
    expect(numberToIndianWords(1_23_45_678)).toBe(
      "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight",
    );
  });
});

describe("amountInWords", () => {
  it("names the paise separately", () => {
    expect(amountInWords("4280.00")).toBe("Rupees Four Thousand Two Hundred Eighty Only");
    expect(amountInWords("4280.40")).toBe(
      "Rupees Four Thousand Two Hundred Eighty and Forty Paise Only",
    );
  });

  it("carries a rounded paise into the rupees", () => {
    // 99.999 is a hundred rupees, not ninety-nine and a hundred paise.
    expect(amountInWords("99.999")).toBe("Rupees One Hundred Only");
  });

  it("handles zero and a credit balance", () => {
    expect(amountInWords(0)).toBe("Rupees Zero Only");
    expect(amountInWords("-1250.50")).toBe(
      "Minus Rupees One Thousand Two Hundred Fifty and Fifty Paise Only",
    );
  });
});
