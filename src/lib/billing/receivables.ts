import Decimal from "decimal.js";
import { prisma, tenantTransaction } from "@/lib/prisma";
import type { PaymentMode } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { branchScope, coversBranch } from "@/server/repositories/scope";
import { recordAudit } from "@/server/services/audit";
import { nextNumber } from "@/lib/numbering/number-series";
import {
  ageLedger,
  buildStatement,
  dec,
  money,
  type AgeingSummary,
  type MoneyIn,
  type StatementEntry,
} from "./ageing";
import { assessCredit, allocateOldestFirst, type CreditAssessment } from "./credit";
import { recomputeInvoiceBalance } from "./invoice";

/**
 * Receivables.
 *
 * The customer ledger, ageing, credit control, and the recording and
 * allocation of what comes in.
 */

export type LedgerRow = {
  id: string;
  number: string;
  invoiceDate: Date;
  dueDate: Date;
  status: string;
  total: Decimal;
  amountPaid: Decimal;
  amountDue: Decimal;
  isReverseCharge: boolean;
};

/** Open invoices for one customer, aged. */
export async function customerLedger(
  options: { customerId: string; asOf?: Date },
  user: SessionUser,
): Promise<{ summary: AgeingSummary; rows: LedgerRow[]; unallocated: Decimal }> {
  const asOf = options.asOf ?? new Date();

  const [invoices, payments] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        customerId: options.customerId,
        status: { notIn: ["CANCELLED", "DRAFT"] },
        ...branchScope(user, "branchId"),
      },
      orderBy: { dueDate: "asc" },
      select: {
        id: true,
        number: true,
        invoiceDate: true,
        dueDate: true,
        status: true,
        total: true,
        amountPaid: true,
        amountDue: true,
        isReverseCharge: true,
      },
    }),
    prisma.payment.findMany({
      where: {
        customerId: options.customerId,
        unallocated: { gt: 0 },
        ...branchScope(user, "branchId"),
      },
      select: { unallocated: true },
    }),
  ]);

  const rows: LedgerRow[] = invoices.map((invoice) => ({
    id: invoice.id,
    number: invoice.number,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    status: invoice.status,
    total: money(dec(invoice.total.toString())),
    amountPaid: money(dec(invoice.amountPaid.toString())),
    amountDue: money(dec(invoice.amountDue.toString())),
    isReverseCharge: invoice.isReverseCharge,
  }));

  const unallocated = money(
    payments.reduce((sum, p) => sum.plus(dec(p.unallocated.toString())), new Decimal(0)),
  );

  // Money on account is a credit on the ledger, so ageing nets it — the
  // customer is not "overdue" for something we are already holding cash
  // against.
  const summary = ageLedger(
    [
      ...rows.map((row) => ({
        id: row.id,
        number: row.number,
        dueDate: row.dueDate,
        invoiceDate: row.invoiceDate,
        amountDue: row.amountDue,
        status: row.status,
      })),
      ...(unallocated.greaterThan(0)
        ? [
            {
              id: "on-account",
              number: "On account",
              dueDate: asOf,
              amountDue: unallocated.negated(),
            },
          ]
        : []),
    ],
    asOf,
  );

  return { summary, rows, unallocated };
}

/**
 * The largest open book this will read in one pass.
 *
 * Every *open* invoice in the organisation, which is a set the business
 * keeps small by getting paid — but not one with any hard ceiling, and
 * this screen had no `take` at all. A carrier a year into monthly bill
 * runs across seven branches was loading the entire open ledger on every
 * page view, and on every keystroke in the search box.
 *
 * A plain cap is the wrong fix on its own: truncating the rows silently
 * under-states the total book and the ageing profile drawn from it, and a
 * receivables figure that is quietly too low is worse than a slow screen.
 * So the query asks for one more than the cap, and reports whether it hit
 * it — the screen says so rather than showing a smaller number in
 * confident type.
 */
const OVERVIEW_INVOICE_CAP = 5000;

/** Ageing across every customer, for the receivables screen. */
export async function receivablesOverview(
  options: { asOf?: Date; branchId?: string | null; search?: string; take?: number },
  user: SessionUser,
): Promise<{
  accounts: Array<{
    customerId: string;
    code: string;
    name: string;
    creditLimit: Decimal | null;
    summary: AgeingSummary;
  }>;
  /** True when the open book is larger than one pass of this screen. */
  truncated: boolean;
  invoicesRead: number;
}> {
  const asOf = options.asOf ?? new Date();
  const cap = options.take ?? OVERVIEW_INVOICE_CAP;

  const found = await prisma.invoice.findMany({
    // One more than the cap, so hitting it is detectable rather than
    // indistinguishable from a book that is exactly `cap` invoices long.
    take: cap + 1,
    where: {
      status: { in: ["ISSUED", "PARTIALLY_PAID", "CREDITED"] },
      amountDue: { gt: 0 },
      // The caller's branch filter first, then the session's scope — and
      // the scope must win, so it is spread last. Both write `branchId`,
      // and the later key replaces the earlier one.
      ...(options.branchId ? { branchId: options.branchId } : {}),
      ...branchScope(user, "branchId"),
      ...(options.search
        ? {
            customer: {
              OR: [
                { name: { contains: options.search, mode: "insensitive" as const } },
                { code: { contains: options.search, mode: "insensitive" as const } },
              ],
            },
          }
        : {}),
    },
    orderBy: { dueDate: "asc" },
    select: {
      id: true,
      number: true,
      dueDate: true,
      invoiceDate: true,
      amountDue: true,
      status: true,
      customerId: true,
      customer: { select: { code: true, name: true, creditLimit: true } },
    },
  });

  const truncated = found.length > cap;
  const invoices = truncated ? found.slice(0, cap) : found;

  const grouped = new Map<
    string,
    {
      customerId: string;
      code: string;
      name: string;
      creditLimit: Decimal | null;
      items: Parameters<typeof ageLedger>[0];
    }
  >();

  for (const invoice of invoices) {
    const bucket = grouped.get(invoice.customerId) ?? {
      customerId: invoice.customerId,
      code: invoice.customer.code,
      name: invoice.customer.name,
      creditLimit: invoice.customer.creditLimit
        ? dec(invoice.customer.creditLimit.toString())
        : null,
      items: [],
    };

    bucket.items.push({
      id: invoice.id,
      number: invoice.number,
      dueDate: invoice.dueDate,
      invoiceDate: invoice.invoiceDate,
      amountDue: invoice.amountDue.toString(),
      status: invoice.status,
    });

    grouped.set(invoice.customerId, bucket);
  }

  return {
    accounts: [...grouped.values()]
      .map((entry) => ({
        customerId: entry.customerId,
        code: entry.code,
        name: entry.name,
        creditLimit: entry.creditLimit,
        summary: ageLedger(entry.items, asOf),
      }))
      .sort((a, b) => b.summary.total.comparedTo(a.summary.total)),
    truncated,
    invoicesRead: invoices.length,
  };
}

// ────────────────────────────────────────────────────────────
// Credit control
// ────────────────────────────────────────────────────────────

/**
 * Whether this customer may book on credit right now.
 *
 * Booking calls this before it writes anything; the receivables screen
 * calls it to show why an account is blocked. Same function, same answer.
 */
export async function checkCustomerCredit(
  options: { customerId: string; bookingAmount?: MoneyIn },
): Promise<CreditAssessment & { customerName: string }> {
  const customer = await prisma.customer.findUnique({
    where: { id: options.customerId },
    select: {
      name: true,
      paymentTerm: true,
      creditLimit: true,
      creditDays: true,
      isBlocked: true,
      blockReason: true,
    },
  });

  if (!customer) {
    return {
      ...assessCredit({ paymentTerm: "CASH", outstanding: 0, isBlocked: true, blockReason: "account not found" }),
      customerName: "Unknown",
    };
  }

  // Deliberately unscoped by branch: a credit limit is an account-level
  // fact, and a Delhi clerk must not be able to book past it because the
  // outstanding invoices happen to sit at Jaipur.
  const open = await prisma.invoice.findMany({
    where: {
      customerId: options.customerId,
      status: { in: ["ISSUED", "PARTIALLY_PAID", "CREDITED"] },
      amountDue: { gt: 0 },
    },
    select: { id: true, number: true, dueDate: true, amountDue: true },
  });

  const summary = ageLedger(
    open.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      dueDate: invoice.dueDate,
      amountDue: invoice.amountDue.toString(),
    })),
  );

  return {
    ...assessCredit({
      paymentTerm: customer.paymentTerm,
      creditLimit: customer.creditLimit?.toString() ?? null,
      creditDays: customer.creditDays,
      isBlocked: customer.isBlocked,
      blockReason: customer.blockReason,
      outstanding: summary.total,
      oldestOverdueDays: summary.oldestDays,
      bookingAmount: options.bookingAmount,
    }),
    customerName: customer.name,
  };
}

// ────────────────────────────────────────────────────────────
// Payments
// ────────────────────────────────────────────────────────────

type OpenInvoice = {
  id: string;
  number: string;
  dueDate: Date;
  amountDue: { toString(): string };
  branchId: string;
};

type PlannedAllocation = { invoiceId: string; number: string; amount: Decimal };

/**
 * The invoices money may be applied to, for one customer.
 *
 * Deliberately not branch-scoped, for the reason `checkCustomerCredit`
 * gives: what a customer owes is an account-level fact. A receipt banked at
 * Delhi settles the account, and filtering this list by the clerk's
 * branches would silently leave Jaipur invoices open with the cash parked
 * on account. Which of these a clerk may *name* by hand is a narrower
 * question, and `planNamedAllocations` answers it.
 */
async function openInvoicesFor(customerId: string): Promise<OpenInvoice[]> {
  return prisma.invoice.findMany({
    where: {
      customerId,
      status: { in: ["ISSUED", "PARTIALLY_PAID", "CREDITED"] },
      amountDue: { gt: 0 },
    },
    orderBy: { dueDate: "asc" },
    select: {
      id: true,
      number: true,
      dueDate: true,
      amountDue: true,
      branchId: true,
    },
  });
}

/**
 * ── Every allocation typed by a human passes through here ────────────────
 *
 * `recordPayment` had these checks and `allocateOnAccount`, five hundred
 * lines away, had none of them: it took the invoice id off the form and
 * wrote an allocation row for it, so customer A's money settled customer
 * B's invoice, in any branch, for any amount up to whatever was left
 * unallocated on the receipt. Both paths now call this, which is the only
 * way the two stay honest — the duplicate that existed before is precisely
 * what drifted.
 *
 * Three things are checked, and each is a real defect that was possible:
 *
 * - the invoice is one of *this customer's* open invoices, because `open`
 *   was fetched for the payer;
 * - it sits in a branch the actor covers, matching the picker they were
 *   offered (`customerLedger` is branch-scoped, so anything else was typed
 *   or replayed);
 * - the amount does not exceed what is still due on it, which is what stops
 *   a receipt from over-settling one invoice and leaving the account in
 *   credit against an invoice that was never that large.
 *
 * The refusal never says whose invoice it was: the caller may not be
 * entitled to know the id they guessed exists.
 * ────────────────────────────────────────────────────────────────────────
 */
function planNamedAllocations(
  open: OpenInvoice[],
  allocations: Array<{ invoiceId: string; amount: MoneyIn }>,
  actor: SessionUser,
): { ok: true; planned: PlannedAllocation[] } | { ok: false; error: string } {
  const byId = new Map(open.map((invoice) => [invoice.id, invoice]));
  const planned: PlannedAllocation[] = [];

  for (const allocation of allocations) {
    const invoice = byId.get(allocation.invoiceId);
    if (!invoice) {
      return {
        ok: false,
        error: "One of the invoices selected is not open on this account.",
      };
    }
    if (!coversBranch(actor, invoice.branchId)) {
      return { ok: false, error: `${invoice.number} is outside your branch scope.` };
    }

    const value = money(dec(allocation.amount));
    if (value.lessThanOrEqualTo(0)) continue;

    if (value.greaterThan(dec(invoice.amountDue.toString()))) {
      return {
        ok: false,
        error: `₹${value.toFixed(2)} is more than the ₹${invoice.amountDue.toString()} still open on ${invoice.number}.`,
      };
    }

    planned.push({ invoiceId: invoice.id, number: invoice.number, amount: value });
  }

  return { ok: true, planned };
}

export type RecordPaymentInput = {
  customerId: string;
  branchId?: string | null;
  amount: MoneyIn;
  /** Deducted by the customer at source; settles invoice value, not cash. */
  tdsAmount?: MoneyIn;
  mode: PaymentMode;
  reference?: string | null;
  receivedOn: Date;
  notes?: string | null;
  /**
   * Explicit allocations. Omit to settle oldest-first, which is what a
   * customer paying a round figure against a statement means.
   */
  allocations?: Array<{ invoiceId: string; amount: MoneyIn }>;
};

export type PaymentResult =
  | { ok: true; paymentId: string; number: string; unallocated: Decimal }
  | { ok: false; error: string };

/**
 * Records a receipt and allocates it.
 *
 * Allocation happens in the same transaction as the receipt: a payment
 * that lands without being applied leaves every invoice it paid still
 * showing as overdue, and the customer gets chased for money they sent.
 */
export async function recordPayment(
  input: RecordPaymentInput,
  actor: SessionUser,
): Promise<PaymentResult> {
  if (!can(actor, "payment.record")) {
    return { ok: false, error: "You do not have permission to record payments." };
  }

  const amount = money(dec(input.amount));
  const tdsAmount = money(dec(input.tdsAmount));

  if (amount.lessThanOrEqualTo(0)) {
    return { ok: false, error: "Enter the amount received." };
  }
  if (tdsAmount.lessThan(0)) {
    return { ok: false, error: "TDS cannot be negative." };
  }

  const open = await openInvoicesFor(input.customerId);

  let planned: PlannedAllocation[];

  if (input.allocations && input.allocations.length > 0) {
    const plan = planNamedAllocations(open, input.allocations, actor);
    if (!plan.ok) return plan;
    planned = plan.planned;

    const allocated = planned.reduce((sum, a) => sum.plus(a.amount), new Decimal(0));
    if (allocated.greaterThan(amount.plus(tdsAmount))) {
      return {
        ok: false,
        error: "The allocations come to more than the payment plus its TDS.",
      };
    }
  } else {
    planned = allocateOldestFirst(
      open.map((invoice) => ({
        invoiceId: invoice.id,
        number: invoice.number,
        dueDate: invoice.dueDate,
        amountDue: invoice.amountDue.toString(),
      })),
      amount,
      tdsAmount,
    ).allocations;
  }

  const allocated = money(
    planned.reduce((sum, a) => sum.plus(a.amount), new Decimal(0)),
  );
  const unallocated = money(amount.plus(tdsAmount).minus(allocated));

  try {
    const created = await tenantTransaction(async (tx) => {
      const number = await nextNumber(
        { document: "PAYMENT", at: input.receivedOn },
        tx,
      );

      const payment = await tx.payment.create({
        data: {
          orgId: actor.orgId,
          number,
          customerId: input.customerId,
          branchId: input.branchId ?? actor.primaryBranch?.id ?? null,
          amount: amount.toFixed(2),
          tdsAmount: tdsAmount.toFixed(2),
          mode: input.mode,
          reference: input.reference ?? undefined,
          receivedOn: input.receivedOn,
          unallocated: unallocated.toFixed(2),
          notes: input.notes ?? undefined,
          createdById: actor.id,
        },
        select: { id: true, number: true },
      });

      for (const allocation of planned) {
        await tx.paymentAllocation.create({
          data: {
            orgId: actor.orgId,
            paymentId: payment.id,
            invoiceId: allocation.invoiceId,
            amount: allocation.amount.toFixed(2),
          },
        });
        await recomputeInvoiceBalance(allocation.invoiceId, tx);
      }

      return payment;
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Payment",
      entityId: created.id,
      entityRef: created.number,
      branchId: input.branchId ?? undefined,
      after: {
        amount: amount.toFixed(2),
        tdsAmount: tdsAmount.toFixed(2),
        mode: input.mode,
        reference: input.reference,
        allocations: planned.map((a) => `${a.number}:${a.amount.toFixed(2)}`),
        unallocated: unallocated.toFixed(2),
      },
    });

    return { ok: true, paymentId: created.id, number: created.number, unallocated };
  } catch (error) {
    if (error instanceof Error && error.message.includes("No active number series")) {
      return {
        ok: false,
        error:
          "No receipt number series is configured. Set one up under Masters → Number series.",
      };
    }
    console.error("[receivables] recordPayment", error);
    return { ok: false, error: "Could not record that payment. Nothing was saved." };
  }
}

/** Applies money already on account to open invoices. */
export async function allocateOnAccount(
  input: { paymentId: string; allocations: Array<{ invoiceId: string; amount: MoneyIn }> },
  actor: SessionUser,
): Promise<{ ok: true; unallocated: Decimal } | { ok: false; error: string }> {
  if (!can(actor, "payment.record")) {
    return { ok: false, error: "You do not have permission to allocate payments." };
  }

  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    select: {
      id: true,
      number: true,
      unallocated: true,
      customerId: true,
      branchId: true,
    },
  });

  if (!payment) return { ok: false, error: "That payment no longer exists." };
  if (payment.branchId && !coversBranch(actor, payment.branchId)) {
    return { ok: false, error: "That receipt is outside your branch scope." };
  }

  // `payment.customerId` — not anything the form sent — decides whose
  // invoices are on offer. The old code went straight from "is there enough
  // left on this receipt" to writing an allocation row for whatever invoice
  // id was posted, so money received from one customer settled another's
  // invoice, and nothing capped the write at what that invoice actually
  // owed.
  const open = await openInvoicesFor(payment.customerId);
  const plan = planNamedAllocations(open, input.allocations, actor);
  if (!plan.ok) return plan;

  const requested = money(
    plan.planned.reduce((sum, a) => sum.plus(a.amount), new Decimal(0)),
  );
  const available = money(dec(payment.unallocated.toString()));

  if (requested.greaterThan(available)) {
    return {
      ok: false,
      error: `Only ₹${available.toFixed(2)} is left unallocated on ${payment.number}.`,
    };
  }

  try {
    await tenantTransaction(async (tx) => {
      for (const allocation of plan.planned) {
        // Already validated and rounded — zero and negative lines were
        // dropped when the plan was built.
        const amount = allocation.amount;

        const existing = await tx.paymentAllocation.findUnique({
          where: {
            paymentId_invoiceId: {
              paymentId: payment.id,
              invoiceId: allocation.invoiceId,
            },
          },
          select: { id: true, amount: true },
        });

        if (existing) {
          await tx.paymentAllocation.update({
            where: { id: existing.id },
            data: {
              amount: money(dec(existing.amount.toString()).plus(amount)).toFixed(2),
            },
          });
        } else {
          await tx.paymentAllocation.create({
            data: {
              orgId: actor.orgId,
              paymentId: payment.id,
              invoiceId: allocation.invoiceId,
              amount: amount.toFixed(2),
            },
          });
        }

        await recomputeInvoiceBalance(allocation.invoiceId, tx);
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: { unallocated: money(available.minus(requested)).toFixed(2) },
      });
    });

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "Payment",
      entityId: payment.id,
      entityRef: payment.number,
      before: { unallocated: available.toFixed(2) },
      after: { unallocated: money(available.minus(requested)).toFixed(2) },
    });

    return { ok: true, unallocated: money(available.minus(requested)) };
  } catch (error) {
    console.error("[receivables] allocateOnAccount", error);
    return { ok: false, error: "Could not apply that. Nothing was saved." };
  }
}

// ────────────────────────────────────────────────────────────
// Statement of account
// ────────────────────────────────────────────────────────────

export async function statementOfAccount(
  options: { customerId: string; from: Date; to: Date },
  user: SessionUser,
) {
  const [invoices, payments, creditNotes, priorInvoices, priorPayments, priorCredits] =
    await Promise.all([
      prisma.invoice.findMany({
        where: {
          customerId: options.customerId,
          status: { not: "CANCELLED" },
          invoiceDate: { gte: options.from, lte: options.to },
          ...branchScope(user, "branchId"),
        },
        select: { number: true, invoiceDate: true, total: true, periodFrom: true, periodTo: true },
      }),
      prisma.payment.findMany({
        where: {
          customerId: options.customerId,
          receivedOn: { gte: options.from, lte: options.to },
        },
        select: { number: true, receivedOn: true, amount: true, tdsAmount: true, mode: true },
      }),
      prisma.creditNote.findMany({
        where: {
          customerId: options.customerId,
          issuedAt: { gte: options.from, lte: options.to },
        },
        select: { number: true, issuedAt: true, total: true, reason: true },
      }),
      prisma.invoice.aggregate({
        where: {
          customerId: options.customerId,
          status: { not: "CANCELLED" },
          invoiceDate: { lt: options.from },
        },
        _sum: { total: true },
      }),
      prisma.payment.aggregate({
        where: { customerId: options.customerId, receivedOn: { lt: options.from } },
        _sum: { amount: true, tdsAmount: true },
      }),
      prisma.creditNote.aggregate({
        where: { customerId: options.customerId, issuedAt: { lt: options.from } },
        _sum: { total: true },
      }),
    ]);

  const opening = money(
    dec(priorInvoices._sum.total?.toString())
      .minus(dec(priorPayments._sum.amount?.toString()))
      .minus(dec(priorPayments._sum.tdsAmount?.toString()))
      .minus(dec(priorCredits._sum.total?.toString())),
  );

  const entries: StatementEntry[] = [
    ...invoices.map((invoice) => ({
      date: invoice.invoiceDate,
      kind: "INVOICE" as const,
      reference: invoice.number,
      description:
        invoice.periodFrom && invoice.periodTo
          ? `Consolidated ${invoice.periodFrom.toISOString().slice(0, 10)} – ${invoice.periodTo.toISOString().slice(0, 10)}`
          : "Freight invoice",
      debit: invoice.total.toString(),
    })),
    ...payments.flatMap((payment) => [
      {
        date: payment.receivedOn,
        kind: "PAYMENT" as const,
        reference: payment.number,
        description: payment.mode,
        credit: payment.amount.toString(),
      },
      ...(dec(payment.tdsAmount.toString()).greaterThan(0)
        ? [
            {
              date: payment.receivedOn,
              kind: "TDS" as const,
              reference: payment.number,
              description: "Tax deducted at source",
              credit: payment.tdsAmount.toString(),
            },
          ]
        : []),
    ]),
    ...creditNotes.map((note) => ({
      date: note.issuedAt,
      kind: "CREDIT_NOTE" as const,
      reference: note.number,
      description: note.reason,
      credit: note.total.toString(),
    })),
  ];

  return buildStatement(entries, opening);
}
