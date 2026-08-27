import Decimal from "decimal.js";
import { dec, money, type MoneyIn } from "./ageing";

/**
 * Credit control.
 *
 * Pure, so the same judgement can be rendered on the booking screen before
 * the clerk types anything and enforced again in the action — the two can
 * never drift, which is the usual way a credit block becomes advisory.
 */

export type CreditInput = {
  paymentTerm: "PREPAID" | "CREDIT" | "CASH";
  creditLimit?: MoneyIn;
  creditDays?: number | null;
  isBlocked?: boolean;
  blockReason?: string | null;
  /** Net receivable from the ledger, credits already netted off. */
  outstanding: MoneyIn;
  /** Age of the oldest unpaid invoice, in days past due. */
  oldestOverdueDays?: number;
  /** What this booking would add. Zero when only checking the account. */
  bookingAmount?: MoneyIn;
};

export type CreditVerdict = "OK" | "WARN" | "BLOCK";

export type CreditAssessment = {
  verdict: CreditVerdict;
  allowed: boolean;
  /** Plain English, shown to the clerk verbatim. */
  reason: string | null;
  limit: Decimal | null;
  outstanding: Decimal;
  /** Outstanding plus the booking being considered. */
  exposure: Decimal;
  headroom: Decimal | null;
  /** Null when no limit is set — not zero, which would read as "no room". */
  utilisationPercent: Decimal | null;
};

/** Warn once the account is this far into its limit. */
const WARN_AT_PERCENT = 85;

export function assessCredit(input: CreditInput): CreditAssessment {
  const outstanding = money(dec(input.outstanding));
  const booking = money(dec(input.bookingAmount));
  const exposure = money(outstanding.plus(booking));

  const hasLimit =
    input.creditLimit !== null &&
    input.creditLimit !== undefined &&
    input.creditLimit !== "";
  const limit = hasLimit ? money(dec(input.creditLimit)) : null;

  const headroom = limit ? money(limit.minus(exposure)) : null;
  const utilisationPercent =
    limit && limit.greaterThan(0)
      ? exposure.times(100).dividedBy(limit).toDecimalPlaces(1, Decimal.ROUND_HALF_UP)
      : null;

  const base = { limit, outstanding, exposure, headroom, utilisationPercent };

  if (input.isBlocked) {
    return {
      ...base,
      verdict: "BLOCK",
      allowed: false,
      reason: input.blockReason
        ? `Account is blocked: ${input.blockReason}`
        : "Account is blocked for new bookings.",
    };
  }

  // Cash and prepaid accounts consume no credit — nothing is extended, so
  // there is nothing to exceed.
  if (input.paymentTerm !== "CREDIT") {
    return {
      ...base,
      verdict: "OK",
      allowed: true,
      reason: null,
    };
  }

  const overdueDays = input.oldestOverdueDays ?? 0;
  if (input.creditDays !== null && input.creditDays !== undefined && overdueDays > input.creditDays) {
    return {
      ...base,
      verdict: "BLOCK",
      allowed: false,
      reason:
        `Oldest invoice is ${overdueDays} days past due against agreed terms of ` +
        `${input.creditDays} days. Clear it before booking on credit.`,
    };
  }

  if (!limit) {
    return {
      ...base,
      verdict: "WARN",
      allowed: true,
      reason:
        "No credit limit is set on this account, so nothing is being enforced. " +
        "Accounts should set one.",
    };
  }

  if (exposure.greaterThan(limit)) {
    return {
      ...base,
      verdict: "BLOCK",
      allowed: false,
      reason:
        `This booking takes the account to ₹${exposure.toFixed(2)} against a limit of ` +
        `₹${limit.toFixed(2)}. It needs a limit increase or a payment.`,
    };
  }

  if (utilisationPercent && utilisationPercent.greaterThanOrEqualTo(WARN_AT_PERCENT)) {
    return {
      ...base,
      verdict: "WARN",
      allowed: true,
      reason:
        `Account is at ${utilisationPercent.toFixed(1)}% of its ₹${limit.toFixed(2)} limit. ` +
        `₹${(headroom ?? new Decimal(0)).toFixed(2)} of headroom is left.`,
    };
  }

  return { ...base, verdict: "OK", allowed: true, reason: null };
}

/**
 * Splits a payment across invoices, oldest first.
 *
 * TDS is deducted by the customer before they pay, so it settles invoice
 * value without arriving as cash — allocate on the gross, not on what hit
 * the bank, or every account ends the year short by exactly the TDS.
 */
export type AllocationTarget = {
  invoiceId: string;
  number: string;
  dueDate: Date | string;
  amountDue: MoneyIn;
};

export type Allocation = {
  invoiceId: string;
  number: string;
  amount: Decimal;
};

export function allocateOldestFirst(
  targets: AllocationTarget[],
  received: MoneyIn,
  tdsAmount: MoneyIn = 0,
): { allocations: Allocation[]; unallocated: Decimal; settled: Decimal } {
  let remaining = money(dec(received).plus(dec(tdsAmount)));
  const allocations: Allocation[] = [];

  const ordered = [...targets].sort((a, b) => {
    const left = new Date(a.dueDate).getTime();
    const right = new Date(b.dueDate).getTime();
    return left - right;
  });

  for (const target of ordered) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const due = money(dec(target.amountDue));
    if (due.lessThanOrEqualTo(0)) continue;

    const amount = remaining.greaterThanOrEqualTo(due) ? due : remaining;
    allocations.push({ invoiceId: target.invoiceId, number: target.number, amount });
    remaining = money(remaining.minus(amount));
  }

  const settled = money(
    allocations.reduce((sum, a) => sum.plus(a.amount), new Decimal(0)),
  );

  return { allocations, unallocated: remaining, settled };
}
