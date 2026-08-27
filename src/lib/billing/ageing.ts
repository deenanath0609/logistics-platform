import Decimal from "decimal.js";

/**
 * Receivables ageing.
 *
 * Pure and separately testable, because the bucket an invoice lands in
 * decides who gets chased this week — and because the boundaries (30/31,
 * 60/61, 90/91) are exactly where an off-by-one hides for months.
 */

export type MoneyIn = Decimal | number | string | null | undefined;

export function dec(value: MoneyIn): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  return value instanceof Decimal ? value : new Decimal(value);
}

export function money(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export type AgeingBucket = "CURRENT" | "D0_30" | "D31_60" | "D61_90" | "D90_PLUS";

/** Display order, oldest last — the way a statement reads left to right. */
export const AGEING_BUCKETS: readonly AgeingBucket[] = [
  "CURRENT",
  "D0_30",
  "D31_60",
  "D61_90",
  "D90_PLUS",
] as const;

export const BUCKET_LABEL: Record<AgeingBucket, string> = {
  CURRENT: "Not yet due",
  D0_30: "0–30 days",
  D31_60: "31–60 days",
  D61_90: "61–90 days",
  D90_PLUS: "90+ days",
};

/** Semantic tone for the bucket. Tokens only — never a raw hex. */
export const BUCKET_TONE: Record<AgeingBucket, string> = {
  CURRENT: "bg-muted text-muted-foreground",
  D0_30: "bg-ok-muted text-ok",
  D31_60: "bg-info-muted text-info",
  D61_90: "bg-warn-muted text-warn",
  D90_PLUS: "bg-bad-muted text-bad",
};

const DAY_MS = 86_400_000;

function atMidnight(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
}

/**
 * Whole days past the due date.
 *
 * Compared at UTC midnight, not by millisecond: an invoice due today is
 * zero days overdue whether it is nine in the morning or eleven at night.
 * Negative means it has not fallen due yet.
 */
export function daysOverdue(dueDate: Date | string, asOf: Date | string): number {
  return Math.floor((atMidnight(asOf) - atMidnight(dueDate)) / DAY_MS);
}

/**
 * The bucket an invoice belongs to.
 *
 * Boundaries are inclusive at the top of each band: 30 days is still
 * 0–30, 31 tips into 31–60. Anything not yet due is CURRENT rather than
 * being folded into 0–30, because "not late" and "a month late" are
 * different conversations.
 */
export function bucketFor(
  dueDate: Date | string,
  asOf: Date | string,
): AgeingBucket {
  const days = daysOverdue(dueDate, asOf);
  if (days < 0) return "CURRENT";
  if (days <= 30) return "D0_30";
  if (days <= 60) return "D31_60";
  if (days <= 90) return "D61_90";
  return "D90_PLUS";
}

export type AgeingItem = {
  id: string;
  number: string;
  dueDate: Date | string;
  invoiceDate?: Date | string | null;
  /**
   * What is still owed. A negative figure is a credit — an unallocated
   * payment or a credit note — and is never bucketed as overdue.
   */
  amountDue: MoneyIn;
  customerId?: string;
  customerName?: string;
  status?: string;
};

export type AgedItem = AgeingItem & {
  bucket: AgeingBucket;
  days: number;
  amount: Decimal;
  isCredit: boolean;
};

export type AgeingSummary = {
  buckets: Record<AgeingBucket, Decimal>;
  /** Everything owed, credits already netted off. */
  total: Decimal;
  /** The part that is past its due date. */
  overdue: Decimal;
  /** Credits sitting on the account, as a positive figure. */
  credits: Decimal;
  /** True when the customer is in funds — we owe them, not the reverse. */
  isCreditBalance: boolean;
  /** Age of the oldest unpaid item, in days. Zero when nothing is overdue. */
  oldestDays: number;
  count: number;
  rows: AgedItem[];
};

function emptyBuckets(): Record<AgeingBucket, Decimal> {
  return {
    CURRENT: new Decimal(0),
    D0_30: new Decimal(0),
    D31_60: new Decimal(0),
    D61_90: new Decimal(0),
    D90_PLUS: new Decimal(0),
  };
}

/** One invoice, aged. */
export function ageItem(item: AgeingItem, asOf: Date | string): AgedItem {
  const amount = money(dec(item.amountDue));
  const isCredit = amount.lessThan(0);

  return {
    ...item,
    amount,
    isCredit,
    days: daysOverdue(item.dueDate, asOf),
    // A credit is money we hold, not money that is late. Bucketing it by
    // age would make the 90+ column net down and hide a genuinely old
    // debt behind an unrelated advance.
    bucket: isCredit ? "CURRENT" : bucketFor(item.dueDate, asOf),
  };
}

/**
 * Totals a customer ledger.
 *
 * Zero-balance items are dropped: a fully paid invoice is history, not
 * receivable, and leaving it in inflates the row count on every screen
 * that shows "N open invoices".
 */
export function ageLedger(
  items: AgeingItem[],
  asOf: Date | string = new Date(),
): AgeingSummary {
  const buckets = emptyBuckets();
  const rows: AgedItem[] = [];

  let total = new Decimal(0);
  let overdue = new Decimal(0);
  let credits = new Decimal(0);
  let oldestDays = 0;

  for (const item of items) {
    const aged = ageItem(item, asOf);
    if (aged.amount.isZero()) continue;

    rows.push(aged);
    total = total.plus(aged.amount);
    buckets[aged.bucket] = buckets[aged.bucket].plus(aged.amount);

    if (aged.isCredit) {
      credits = credits.plus(aged.amount.negated());
      continue;
    }
    if (aged.days >= 0) {
      overdue = overdue.plus(aged.amount);
      if (aged.days > oldestDays) oldestDays = aged.days;
    }
  }

  total = money(total);

  return {
    buckets: {
      CURRENT: money(buckets.CURRENT),
      D0_30: money(buckets.D0_30),
      D31_60: money(buckets.D31_60),
      D61_90: money(buckets.D61_90),
      D90_PLUS: money(buckets.D90_PLUS),
    },
    total,
    overdue: money(overdue),
    credits: money(credits),
    isCreditBalance: total.lessThan(0),
    oldestDays,
    count: rows.length,
    rows: rows.sort((a, b) => b.days - a.days),
  };
}

// ────────────────────────────────────────────────────────────
// Statement of account
// ────────────────────────────────────────────────────────────

export type StatementEntry = {
  date: Date | string;
  kind: "INVOICE" | "PAYMENT" | "CREDIT_NOTE" | "TDS";
  reference: string;
  description?: string;
  /** Increases what the customer owes. */
  debit?: MoneyIn;
  /** Reduces it. */
  credit?: MoneyIn;
};

export type StatementLine = StatementEntry & {
  debitAmount: Decimal;
  creditAmount: Decimal;
  balance: Decimal;
};

/**
 * A running-balance statement.
 *
 * Sorted oldest first, because a statement that does not run forward is
 * unreadable — and every dispute is settled by reading down the balance
 * column to the row where the two sides stopped agreeing.
 */
export function buildStatement(
  entries: StatementEntry[],
  opening: MoneyIn = 0,
): { lines: StatementLine[]; opening: Decimal; closing: Decimal } {
  const openingBalance = money(dec(opening));
  let balance = openingBalance;

  const sorted = [...entries].sort(
    (a, b) => atMidnight(a.date) - atMidnight(b.date),
  );

  const lines = sorted.map((entry) => {
    const debitAmount = money(dec(entry.debit));
    const creditAmount = money(dec(entry.credit));
    balance = money(balance.plus(debitAmount).minus(creditAmount));
    return { ...entry, debitAmount, creditAmount, balance };
  });

  return { lines, opening: openingBalance, closing: balance };
}
