import { describe, expect, it } from "vitest";
import {
  daysOverdue,
  bucketFor,
  ageItem,
  ageLedger,
  buildStatement,
  type AgeingItem,
} from "./ageing";
import { assessCredit, allocateOldestFirst } from "./credit";

const AS_OF = "2026-08-27";

function invoice(overrides: Partial<AgeingItem> & { id: string }): AgeingItem {
  return {
    number: `INV-${overrides.id}`,
    dueDate: "2026-08-01",
    amountDue: 1000,
    ...overrides,
  };
}

/** The date that is exactly `days` past due as at AS_OF. */
function dueSoThatOverdueIs(days: number): string {
  const asOf = new Date(`${AS_OF}T00:00:00.000Z`);
  return new Date(asOf.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

describe("daysOverdue", () => {
  it("is zero on the due date itself", () => {
    expect(daysOverdue("2026-08-27", AS_OF)).toBe(0);
  });

  it("ignores the time of day", () => {
    expect(
      daysOverdue(new Date("2026-08-27T23:30:00Z"), new Date("2026-08-27T00:30:00Z")),
    ).toBe(0);
  });

  it("is negative before the due date", () => {
    expect(daysOverdue("2026-09-10", AS_OF)).toBe(-14);
  });
});

describe("bucketFor — the boundaries", () => {
  it("keeps day 30 in 0–30", () => {
    expect(bucketFor(dueSoThatOverdueIs(30), AS_OF)).toBe("D0_30");
  });

  it("tips day 31 into 31–60", () => {
    expect(bucketFor(dueSoThatOverdueIs(31), AS_OF)).toBe("D31_60");
  });

  it("keeps day 60 in 31–60", () => {
    expect(bucketFor(dueSoThatOverdueIs(60), AS_OF)).toBe("D31_60");
  });

  it("tips day 61 into 61–90", () => {
    expect(bucketFor(dueSoThatOverdueIs(61), AS_OF)).toBe("D61_90");
  });

  it("keeps day 90 in 61–90", () => {
    expect(bucketFor(dueSoThatOverdueIs(90), AS_OF)).toBe("D61_90");
  });

  it("tips day 91 into 90+", () => {
    expect(bucketFor(dueSoThatOverdueIs(91), AS_OF)).toBe("D90_PLUS");
  });

  it("puts day 0 in 0–30, not in not-yet-due", () => {
    expect(bucketFor(dueSoThatOverdueIs(0), AS_OF)).toBe("D0_30");
  });

  it("holds an invoice that has not fallen due in CURRENT", () => {
    expect(bucketFor("2026-09-30", AS_OF)).toBe("CURRENT");
  });
});

describe("ageItem", () => {
  it("carries the day count alongside the bucket", () => {
    const aged = ageItem(invoice({ id: "1", dueDate: dueSoThatOverdueIs(45) }), AS_OF);
    expect(aged.days).toBe(45);
    expect(aged.bucket).toBe("D31_60");
    expect(aged.isCredit).toBe(false);
  });

  it("never buckets a credit as overdue", () => {
    const aged = ageItem(
      invoice({ id: "2", dueDate: dueSoThatOverdueIs(200), amountDue: -5000 }),
      AS_OF,
    );
    expect(aged.isCredit).toBe(true);
    expect(aged.bucket).toBe("CURRENT");
  });
});

describe("ageLedger", () => {
  it("totals each bucket and the ledger", () => {
    const summary = ageLedger(
      [
        invoice({ id: "a", dueDate: dueSoThatOverdueIs(10), amountDue: 1000 }),
        invoice({ id: "b", dueDate: dueSoThatOverdueIs(30), amountDue: 2000 }),
        invoice({ id: "c", dueDate: dueSoThatOverdueIs(31), amountDue: 400 }),
        invoice({ id: "d", dueDate: dueSoThatOverdueIs(95), amountDue: 750.5 }),
        invoice({ id: "e", dueDate: "2026-09-20", amountDue: 300 }),
      ],
      AS_OF,
    );

    expect(summary.buckets.D0_30.toFixed(2)).toBe("3000.00");
    expect(summary.buckets.D31_60.toFixed(2)).toBe("400.00");
    expect(summary.buckets.D61_90.toFixed(2)).toBe("0.00");
    expect(summary.buckets.D90_PLUS.toFixed(2)).toBe("750.50");
    expect(summary.buckets.CURRENT.toFixed(2)).toBe("300.00");
    expect(summary.total.toFixed(2)).toBe("4450.50");
    expect(summary.overdue.toFixed(2)).toBe("4150.50");
    expect(summary.oldestDays).toBe(95);
    expect(summary.count).toBe(5);
  });

  it("drops fully settled invoices instead of counting them as open", () => {
    const summary = ageLedger(
      [
        invoice({ id: "a", amountDue: 0 }),
        invoice({ id: "b", amountDue: 500 }),
      ],
      AS_OF,
    );
    expect(summary.count).toBe(1);
    expect(summary.total.toFixed(2)).toBe("500.00");
  });

  it("reports a credit balance when the customer is in funds", () => {
    const summary = ageLedger(
      [
        invoice({ id: "a", dueDate: dueSoThatOverdueIs(20), amountDue: 1500 }),
        invoice({ id: "credit", amountDue: -4000 }),
      ],
      AS_OF,
    );

    expect(summary.total.toFixed(2)).toBe("-2500.00");
    expect(summary.isCreditBalance).toBe(true);
    expect(summary.credits.toFixed(2)).toBe("4000.00");
    // The genuinely overdue ₹1,500 is still visible — the credit does not
    // net it away and hide the chase.
    expect(summary.overdue.toFixed(2)).toBe("1500.00");
    expect(summary.buckets.D0_30.toFixed(2)).toBe("1500.00");
  });

  it("returns zeroed buckets for an empty ledger", () => {
    const summary = ageLedger([], AS_OF);
    expect(summary.total.toFixed(2)).toBe("0.00");
    expect(summary.isCreditBalance).toBe(false);
    expect(summary.oldestDays).toBe(0);
    expect(summary.rows).toHaveLength(0);
  });

  it("sorts the rows oldest first", () => {
    const summary = ageLedger(
      [
        invoice({ id: "new", dueDate: dueSoThatOverdueIs(2) }),
        invoice({ id: "old", dueDate: dueSoThatOverdueIs(120) }),
      ],
      AS_OF,
    );
    expect(summary.rows[0].id).toBe("old");
  });

  it("adds paise without drifting", () => {
    const summary = ageLedger(
      Array.from({ length: 3 }, (_, i) =>
        invoice({ id: String(i), amountDue: "0.10" }),
      ),
      AS_OF,
    );
    expect(summary.total.toFixed(2)).toBe("0.30");
  });
});

describe("buildStatement", () => {
  it("runs a balance forward from the opening figure", () => {
    const statement = buildStatement(
      [
        { date: "2026-07-05", kind: "INVOICE", reference: "INV-1", debit: 10000 },
        { date: "2026-07-20", kind: "PAYMENT", reference: "RCT-1", credit: 6000 },
        { date: "2026-07-20", kind: "TDS", reference: "RCT-1", credit: 200 },
        { date: "2026-08-02", kind: "CREDIT_NOTE", reference: "CN-1", credit: 1000 },
      ],
      2500,
    );

    expect(statement.opening.toFixed(2)).toBe("2500.00");
    expect(statement.lines.map((l) => l.balance.toFixed(2))).toEqual([
      "12500.00",
      "6500.00",
      "6300.00",
      "5300.00",
    ]);
    expect(statement.closing.toFixed(2)).toBe("5300.00");
  });

  it("sorts entries oldest first whatever order they arrive in", () => {
    const statement = buildStatement([
      { date: "2026-08-02", kind: "PAYMENT", reference: "RCT-2", credit: 500 },
      { date: "2026-07-02", kind: "INVOICE", reference: "INV-2", debit: 900 },
    ]);
    expect(statement.lines[0].reference).toBe("INV-2");
    expect(statement.closing.toFixed(2)).toBe("400.00");
  });
});

describe("assessCredit", () => {
  it("lets a cash account book regardless of what it owes", () => {
    const verdict = assessCredit({
      paymentTerm: "CASH",
      outstanding: 500000,
      creditLimit: 1000,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.verdict).toBe("OK");
  });

  it("blocks a booking that would breach the limit", () => {
    const verdict = assessCredit({
      paymentTerm: "CREDIT",
      creditLimit: 100000,
      outstanding: 95000,
      bookingAmount: 8000,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("103000.00");
    expect(verdict.headroom?.toFixed(2)).toBe("-3000.00");
  });

  it("allows a booking that lands exactly on the limit", () => {
    const verdict = assessCredit({
      paymentTerm: "CREDIT",
      creditLimit: 100000,
      outstanding: 95000,
      bookingAmount: 5000,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.utilisationPercent?.toFixed(1)).toBe("100.0");
  });

  it("warns before it blocks", () => {
    const verdict = assessCredit({
      paymentTerm: "CREDIT",
      creditLimit: 100000,
      outstanding: 86000,
    });
    expect(verdict.verdict).toBe("WARN");
    expect(verdict.allowed).toBe(true);
  });

  it("blocks when an invoice is past the agreed terms", () => {
    const verdict = assessCredit({
      paymentTerm: "CREDIT",
      creditLimit: 1000000,
      creditDays: 30,
      outstanding: 5000,
      oldestOverdueDays: 44,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("44 days past due");
  });

  it("blocks a blocked account first, whatever the numbers say", () => {
    const verdict = assessCredit({
      paymentTerm: "CASH",
      isBlocked: true,
      blockReason: "cheque bounced twice",
      outstanding: 0,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("cheque bounced twice");
  });

  it("says so when no limit has been set at all", () => {
    const verdict = assessCredit({ paymentTerm: "CREDIT", outstanding: 250000 });
    expect(verdict.verdict).toBe("WARN");
    expect(verdict.allowed).toBe(true);
    expect(verdict.utilisationPercent).toBeNull();
  });
});

describe("allocateOldestFirst", () => {
  const targets = [
    { invoiceId: "i2", number: "INV-2", dueDate: "2026-07-15", amountDue: 4000 },
    { invoiceId: "i1", number: "INV-1", dueDate: "2026-06-15", amountDue: 3000 },
    { invoiceId: "i3", number: "INV-3", dueDate: "2026-08-15", amountDue: 2000 },
  ];

  it("settles the oldest invoice first and part-pays the next", () => {
    const result = allocateOldestFirst(targets, 5000);
    expect(result.allocations).toEqual([
      { invoiceId: "i1", number: "INV-1", amount: expect.anything() },
      { invoiceId: "i2", number: "INV-2", amount: expect.anything() },
    ]);
    expect(result.allocations[0].amount.toFixed(2)).toBe("3000.00");
    expect(result.allocations[1].amount.toFixed(2)).toBe("2000.00");
    expect(result.unallocated.toFixed(2)).toBe("0.00");
  });

  it("counts TDS as settling invoice value even though no cash arrived", () => {
    // ₹2,970 banked plus ₹30 deducted at source settles a ₹3,000 invoice.
    const result = allocateOldestFirst(targets, 2970, 30);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].amount.toFixed(2)).toBe("3000.00");
    expect(result.unallocated.toFixed(2)).toBe("0.00");
  });

  it("leaves the surplus unallocated rather than over-paying", () => {
    const result = allocateOldestFirst(targets, 12000);
    expect(result.settled.toFixed(2)).toBe("9000.00");
    expect(result.unallocated.toFixed(2)).toBe("3000.00");
  });

  it("skips invoices that are already settled", () => {
    const result = allocateOldestFirst(
      [{ invoiceId: "i0", number: "INV-0", dueDate: "2026-01-01", amountDue: 0 }, ...targets],
      1000,
    );
    expect(result.allocations[0].invoiceId).toBe("i1");
  });
});
