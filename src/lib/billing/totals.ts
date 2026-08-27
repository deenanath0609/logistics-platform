import Decimal from "decimal.js";
import { dec, money, type MoneyIn } from "./ageing";

/**
 * Invoice arithmetic.
 *
 * Pure, and kept out of `invoice.ts` so it can be tested without a
 * database — the reverse-charge rule below is the one an auditor will ask
 * about, and "we believe it works" is not an answer.
 */

export type InvoiceTotals = {
  subtotal: Decimal;
  /**
   * Tax as computed. Under reverse charge it is stated on the document
   * because the recipient has to pay it, but it is not ours to collect.
   */
  statedTax: Decimal;
  /** Tax actually added to the total. Zero under reverse charge. */
  taxAmount: Decimal;
  roundOff: Decimal;
  total: Decimal;
};

/**
 * Adds an invoice up.
 *
 * Rounded to the rupee, with the difference kept as `roundOff` rather than
 * absorbed — a ledger that is out by 43 paise across a month is exactly
 * the sort of thing an auditor asks about and nobody can explain.
 */
export function totalInvoice(
  lines: Array<{ amount: MoneyIn; taxAmount?: MoneyIn }>,
  isReverseCharge: boolean,
): InvoiceTotals {
  const subtotal = money(
    lines.reduce((sum, line) => sum.plus(dec(line.amount)), new Decimal(0)),
  );
  const statedTax = money(
    lines.reduce((sum, line) => sum.plus(dec(line.taxAmount)), new Decimal(0)),
  );

  const taxAmount = isReverseCharge ? new Decimal(0) : statedTax;
  const raw = subtotal.plus(taxAmount);
  const total = raw.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

  return {
    subtotal,
    statedTax,
    taxAmount,
    roundOff: money(total.minus(raw)),
    total: money(total),
  };
}

/**
 * What a vendor bill comes to.
 *
 * TDS, deductions and any advance already paid all come off what we
 * transfer, not off what was earned — which is why they are separate
 * columns rather than netted into the subtotal.
 */
export function totalVendorBill(input: {
  lines: Array<{ amount: MoneyIn; taxPercent?: MoneyIn }>;
  tdsPercent?: MoneyIn;
  tdsAmount?: MoneyIn;
  deductions?: MoneyIn;
  advanceAdjusted?: MoneyIn;
}): {
  subtotal: Decimal;
  taxAmount: Decimal;
  tdsAmount: Decimal;
  deductions: Decimal;
  advanceAdjusted: Decimal;
  total: Decimal;
} {
  const subtotal = money(
    input.lines.reduce((sum, line) => sum.plus(dec(line.amount)), new Decimal(0)),
  );
  const taxAmount = money(
    input.lines.reduce(
      (sum, line) => sum.plus(dec(line.amount).times(dec(line.taxPercent)).dividedBy(100)),
      new Decimal(0),
    ),
  );

  const tdsAmount = money(
    input.tdsAmount !== undefined && input.tdsAmount !== null
      ? dec(input.tdsAmount)
      : subtotal.times(dec(input.tdsPercent)).dividedBy(100),
  );

  const deductions = money(dec(input.deductions));
  const advanceAdjusted = money(dec(input.advanceAdjusted));

  return {
    subtotal,
    taxAmount,
    tdsAmount,
    deductions,
    advanceAdjusted,
    total: money(
      subtotal.plus(taxAmount).minus(tdsAmount).minus(deductions).minus(advanceAdjusted),
    ),
  };
}
