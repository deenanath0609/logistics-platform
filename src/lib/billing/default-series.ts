import type { SeriesDocument, SeriesReset } from "@/generated/prisma/client";

/**
 * The finance number series, as data.
 *
 * `PAYMENT`, `VENDOR_PAYMENT`, `SETTLEMENT` and `DEBIT_NOTE` were numbered
 * by counting rows within a financial year until the enum grew members for
 * them. Counting is not collision-safe — two clerks recording receipts in
 * the same second both read the same count and both print RCT/2627/000041 —
 * so they now go through `nextNumber`, which holds a Postgres advisory lock
 * inside the creating transaction like every other document.
 *
 * Deliberately plain data and no seeding: the seed pass in
 * `prisma/seed/masters.ts` owns writing these, and a module that reached
 * into the database on import would make this file unusable from a test.
 */

export type DefaultSeries = {
  document: SeriesDocument;
  /** Tokens: `{PREFIX} {BRANCH} {YYYY} {YY} {MM} {DD} {FY} {SEQ}` */
  pattern: string;
  prefix: string;
  padding: number;
  resetPolicy: SeriesReset;
  /** Why the shape is what it is, for whoever edits it in Masters. */
  description: string;
};

/**
 * Six digits and a financial-year reset on all four.
 *
 * These are documents somebody keeps — a customer's receipt, a driver's
 * settlement slip — so the number has to carry the year it belongs to
 * without anyone having to look it up. The padding matches what the
 * counting stopgap printed, so numbers issued before and after the switch
 * still sort together.
 */
export const FINANCE_NUMBER_SERIES: readonly DefaultSeries[] = [
  {
    document: "PAYMENT",
    pattern: "RCT/{FY}/{SEQ}",
    prefix: "RCT",
    padding: 6,
    resetPolicy: "FINANCIAL_YEAR",
    description:
      "Customer receipt. Printed and handed over, so it resets with the financial year.",
  },
  {
    document: "VENDOR_PAYMENT",
    pattern: "VPY/{FY}/{SEQ}",
    prefix: "VPY",
    padding: 6,
    resetPolicy: "FINANCIAL_YEAR",
    description: "Payment out to a transporter, broker or attached-vehicle owner.",
  },
  {
    document: "SETTLEMENT",
    pattern: "STL/{FY}/{SEQ}",
    prefix: "STL",
    padding: 6,
    resetPolicy: "FINANCIAL_YEAR",
    description: "Driver settlement slip against a trip.",
  },
  {
    document: "DEBIT_NOTE",
    pattern: "DN/{FY}/{SEQ}",
    prefix: "DN",
    padding: 6,
    resetPolicy: "FINANCIAL_YEAR",
    description:
      "Supplementary tax invoice for an upward weight revision — the counterpart to a credit note.",
  },
] as const;

/**
 * The credit-note series, for completeness.
 *
 * `createCreditNote` has always called `nextNumber({ document: "CREDIT_NOTE" })`
 * and the seed never configured one, so raising a credit note fails with
 * "No active number series configured for CREDIT_NOTE" on a fresh database.
 * Kept separate from the four above so the seed can adopt it deliberately.
 */
export const CREDIT_NOTE_SERIES: DefaultSeries = {
  document: "CREDIT_NOTE",
  pattern: "CN/{FY}/{SEQ}",
  prefix: "CN",
  padding: 6,
  resetPolicy: "FINANCIAL_YEAR",
  description: "Credit note against an issued invoice.",
};

/** Everything this module would have seeded, in one list. */
export const BILLING_NUMBER_SERIES: readonly DefaultSeries[] = [
  ...FINANCE_NUMBER_SERIES,
  CREDIT_NOTE_SERIES,
] as const;

/**
 * How a debit note is recognised.
 *
 * There is no `DebitNote` table: a debit note is a supplementary invoice,
 * which is what GST §34(3) makes it anyway, and it is the `Invoice` row
 * carrying a number from the `DEBIT_NOTE` series. Matching on the prefix is
 * how the screens tell the two apart, so the pattern above and this
 * constant have to move together.
 */
export const DEBIT_NOTE_PREFIX = "DN/";

export function isDebitNoteNumber(number: string): boolean {
  return number.startsWith(DEBIT_NOTE_PREFIX);
}
