import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import type { PaymentMode } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
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

/** Ageing across every customer, for the receivables screen. */
export async function receivablesOverview(
  options: { asOf?: Date; branchId?: string | null; search?: string },
  user: SessionUser,
): Promise<
  Array<{
    customerId: string;
    code: string;
    name: string;
    creditLimit: Decimal | null;
    summary: AgeingSummary;
  }>
> {
  const asOf = options.asOf ?? new Date();

  const invoices = await prisma.invoice.findMany({
    where: {
      status: { in: ["ISSUED", "PARTIALLY_PAID", "CREDITED"] },
      amountDue: { gt: 0 },
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

  return [...grouped.values()]
    .map((entry) => ({
      customerId: entry.customerId,
      code: entry.code,
      name: entry.name,
      creditLimit: entry.creditLimit,
      summary: ageLedger(entry.items, asOf),
    }))
    .sort((a, b) => b.summary.total.comparedTo(a.summary.total));
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

  const open = await prisma.invoice.findMany({
    where: {
      customerId: input.customerId,
      status: { in: ["ISSUED", "PARTIALLY_PAID", "CREDITED"] },
      amountDue: { gt: 0 },
    },
    orderBy: { dueDate: "asc" },
    select: { id: true, number: true, dueDate: true, amountDue: true },
  });

  const byId = new Map(open.map((invoice) => [invoice.id, invoice]));

  let planned: Array<{ invoiceId: string; number: string; amount: Decimal }>;

  if (input.allocations && input.allocations.length > 0) {
    planned = [];
    for (const allocation of input.allocations) {
      const invoice = byId.get(allocation.invoiceId);
      if (!invoice) {
        return { ok: false, error: "One of the invoices selected is no longer open." };
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
    const created = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(
        { document: "PAYMENT", at: input.receivedOn },
        tx as unknown as Parameters<typeof nextNumber>[1],
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
    select: { id: true, number: true, unallocated: true, customerId: true },
  });

  if (!payment) return { ok: false, error: "That payment no longer exists." };

  const requested = money(
    input.allocations.reduce((sum, a) => sum.plus(dec(a.amount)), new Decimal(0)),
  );
  const available = money(dec(payment.unallocated.toString()));

  if (requested.greaterThan(available)) {
    return {
      ok: false,
      error: `Only ₹${available.toFixed(2)} is left unallocated on ${payment.number}.`,
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      for (const allocation of input.allocations) {
        const amount = money(dec(allocation.amount));
        if (amount.lessThanOrEqualTo(0)) continue;

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
