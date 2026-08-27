import { dec, money, type MoneyIn } from "./ageing";

/**
 * Rupees in words.
 *
 * A tax invoice states the amount in words as well as figures, and the
 * words are what settles a dispute when a figure has been altered. Indian
 * grouping throughout — lakh and crore, not million — because "one hundred
 * thousand" on an Indian invoice reads as a foreign document.
 */

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];

const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

/** 0–99. */
function underHundred(value: number): string {
  if (value < 20) return ONES[value];
  const tens = TENS[Math.floor(value / 10)];
  const ones = ONES[value % 10];
  return ones ? `${tens} ${ones}` : tens;
}

/** 0–999. */
function underThousand(value: number): string {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds === 0) return underHundred(rest);
  const head = `${ONES[hundreds]} Hundred`;
  return rest === 0 ? head : `${head} ${underHundred(rest)}`;
}

/**
 * A whole number in Indian words.
 *
 * Splits at crore and lakh before falling back to the western grouping for
 * the last three digits, which is exactly how the numbering system works:
 * 1,23,45,678 is one crore twenty-three lakh forty-five thousand.
 */
export function numberToIndianWords(value: number): string {
  if (!Number.isFinite(value)) return "";
  const whole = Math.floor(Math.abs(value));
  if (whole === 0) return "Zero";

  const parts: string[] = [];

  const crore = Math.floor(whole / 10_000_000);
  const lakh = Math.floor((whole % 10_000_000) / 100_000);
  const thousand = Math.floor((whole % 100_000) / 1000);
  const rest = whole % 1000;

  if (crore > 0) parts.push(`${numberToIndianWords(crore)} Crore`);
  if (lakh > 0) parts.push(`${underThousand(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${underThousand(thousand)} Thousand`);
  if (rest > 0) parts.push(underThousand(rest));

  return parts.join(" ");
}

/**
 * The line an invoice prints under its total.
 *
 * Paise are named separately rather than being read as a decimal — "and
 * forty paise" is what a cashier checks against, "point four zero" is not.
 * The rounding matches `totalInvoice`, so the words and the figure can
 * never disagree.
 */
export function amountInWords(amount: MoneyIn, currency = "Rupees"): string {
  const value = money(dec(amount));
  const negative = value.isNegative();
  const absolute = value.abs();

  const rupees = absolute.floor().toNumber();
  const paise = absolute.minus(absolute.floor()).times(100).round().toNumber();

  // Rounding the paise can carry into the rupees — 99.999 is a hundred
  // rupees exactly, not ninety-nine and a hundred paise.
  const carried = paise === 100;
  const wholeRupees = carried ? rupees + 1 : rupees;
  const wholePaise = carried ? 0 : paise;

  const head = `${currency} ${numberToIndianWords(wholeRupees)}`;
  const tail =
    wholePaise > 0 ? ` and ${underHundred(wholePaise)} Paise` : "";

  return `${negative ? "Minus " : ""}${head}${tail} Only`;
}
