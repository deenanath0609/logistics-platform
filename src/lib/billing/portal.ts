import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import {
  ageLedger,
  bucketFor,
  buildStatement,
  daysOverdue,
  dec,
  money,
  type AgeingBucket,
  type AgeingSummary,
  type StatementEntry,
} from "./ageing";
import { isDebitNoteNumber } from "./default-series";

/**
 * What the customer portal may read about its own account.
 *
 * §A.12 ends "Outstanding is visible to the customer in the portal", and
 * this is the only door to it. Every function here takes the customer id
 * as its first, mandatory argument and filters on it — there is no
 * "optional scope" and no staff `SessionUser` overload, because an
 * argument that can be omitted is an argument that eventually is.
 *
 * Deliberately read-only. Nothing here writes, so a portal session cannot
 * become a way to move money, and the portal never touches `prisma.invoice`
 * itself — the same rule `src/lib/portal/queries.ts` follows for shipments.
 *
 * The UI lives in `src/app/(portal)` and is somebody else's; these are the
 * functions it calls.
 */

/** What a customer is allowed to see. A draft has not been issued to them. */
const VISIBLE_STATUSES = [
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "CREDITED",
  "CANCELLED",
] as const;

/** Still owed. Cancelled and fully paid documents are history. */
const OPEN_STATUSES = ["ISSUED", "PARTIALLY_PAID", "CREDITED"] as const;

export type PortalInvoiceRow = {
  id: string;
  number: string;
  /** True when this is a supplementary invoice rather than an original. */
  isDebitNote: boolean;
  status: string;
  invoiceDate: Date;
  dueDate: Date;
  periodFrom: Date | null;
  periodTo: Date | null;
  branchCode: string;
  /** Strings, not `Decimal` — these cross the RSC boundary. */
  subtotal: string;
  taxAmount: string;
  total: string;
  amountPaid: string;
  amountDue: string;
  isReverseCharge: boolean;
  /** Days past due. Negative means it has not fallen due yet. */
  daysOverdue: number;
  bucket: AgeingBucket;
  lineCount: number;
  /** Where the portal links to for the printable document. */
  downloadPath: string;
};

/** The printable document for one invoice, from the portal's side. */
export function portalInvoiceDownloadPath(invoiceId: string): string {
  return `/portal/invoices/${invoiceId}/print`;
}

function toRow(
  invoice: {
    id: string;
    number: string;
    status: string;
    invoiceDate: Date;
    dueDate: Date;
    periodFrom: Date | null;
    periodTo: Date | null;
    subtotal: { toString(): string };
    taxAmount: { toString(): string };
    total: { toString(): string };
    amountPaid: { toString(): string };
    amountDue: { toString(): string };
    isReverseCharge: boolean;
    branch: { code: string };
    _count: { lines: number };
  },
  asOf: Date,
): PortalInvoiceRow {
  // Aged directly rather than through `ageLedger`, which drops
  // zero-balance items — a settled invoice still has to appear in the
  // customer's list, showing when it fell due.
  const amountDue = money(dec(invoice.amountDue.toString()));
  const days = daysOverdue(invoice.dueDate, asOf);

  return {
    id: invoice.id,
    number: invoice.number,
    isDebitNote: isDebitNoteNumber(invoice.number),
    status: invoice.status,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    periodFrom: invoice.periodFrom,
    periodTo: invoice.periodTo,
    branchCode: invoice.branch.code,
    subtotal: money(dec(invoice.subtotal.toString())).toFixed(2),
    taxAmount: money(dec(invoice.taxAmount.toString())).toFixed(2),
    total: money(dec(invoice.total.toString())).toFixed(2),
    amountPaid: money(dec(invoice.amountPaid.toString())).toFixed(2),
    amountDue: amountDue.toFixed(2),
    isReverseCharge: invoice.isReverseCharge,
    daysOverdue: days,
    // Nothing left to pay is not overdue, however long ago it fell due.
    bucket: amountDue.lessThanOrEqualTo(0)
      ? "CURRENT"
      : bucketFor(invoice.dueDate, asOf),
    lineCount: invoice._count.lines,
    downloadPath: portalInvoiceDownloadPath(invoice.id),
  };
}

const INVOICE_SELECT = {
  id: true,
  number: true,
  status: true,
  invoiceDate: true,
  dueDate: true,
  periodFrom: true,
  periodTo: true,
  subtotal: true,
  taxAmount: true,
  total: true,
  amountPaid: true,
  amountDue: true,
  isReverseCharge: true,
  branch: { select: { code: true } },
  _count: { select: { lines: true } },
} as const;

export type PortalOutstanding = {
  /** Everything owed, credits and money on account already netted off. */
  total: string;
  /** The part past its due date. */
  overdue: string;
  /** Money we hold against the account, as a positive figure. */
  credits: string;
  /** True when the customer is in funds — we owe them, not the reverse. */
  isCreditBalance: boolean;
  openInvoices: number;
  oldestOverdueDays: number;
  buckets: Record<AgeingBucket, string>;
  /** Set when the account is blocked for new bookings, with the reason. */
  blockReason: string | null;
  creditLimit: string | null;
  /** Null when no limit is set — not zero, which reads as "no room". */
  headroom: string | null;
};

/**
 * The outstanding tile on the portal dashboard.
 *
 * Money sitting unallocated on the account is netted off, because a
 * customer who has paid and not been applied is not overdue — telling
 * them otherwise is how a support ticket starts.
 */
export async function customerOutstanding(
  customerId: string,
  options: { asOf?: Date } = {},
): Promise<PortalOutstanding> {
  const asOf = options.asOf ?? new Date();

  const [customer, invoices, payments] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: customerId },
      select: { creditLimit: true, isBlocked: true, blockReason: true },
    }),
    prisma.invoice.findMany({
      where: {
        customerId,
        status: { in: [...OPEN_STATUSES] },
      },
      orderBy: { dueDate: "asc" },
      select: { id: true, number: true, dueDate: true, amountDue: true, status: true },
    }),
    prisma.payment.findMany({
      where: { customerId, unallocated: { gt: 0 } },
      select: { unallocated: true },
    }),
  ]);

  const unallocated = money(
    payments.reduce((sum, p) => sum.plus(dec(p.unallocated.toString())), new Decimal(0)),
  );

  const summary: AgeingSummary = ageLedger(
    [
      ...invoices.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        dueDate: invoice.dueDate,
        amountDue: invoice.amountDue.toString(),
        status: invoice.status,
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

  const creditLimit = customer?.creditLimit
    ? money(dec(customer.creditLimit.toString()))
    : null;

  return {
    total: summary.total.toFixed(2),
    overdue: summary.overdue.toFixed(2),
    credits: summary.credits.toFixed(2),
    isCreditBalance: summary.isCreditBalance,
    openInvoices: invoices.filter((invoice) =>
      dec(invoice.amountDue.toString()).greaterThan(0),
    ).length,
    oldestOverdueDays: summary.oldestDays,
    buckets: {
      CURRENT: summary.buckets.CURRENT.toFixed(2),
      D0_30: summary.buckets.D0_30.toFixed(2),
      D31_60: summary.buckets.D31_60.toFixed(2),
      D61_90: summary.buckets.D61_90.toFixed(2),
      D90_PLUS: summary.buckets.D90_PLUS.toFixed(2),
    },
    blockReason: customer?.isBlocked
      ? (customer.blockReason ?? "Account is on hold for new bookings.")
      : null,
    creditLimit: creditLimit ? creditLimit.toFixed(2) : null,
    headroom: creditLimit
      ? money(creditLimit.minus(summary.total)).toFixed(2)
      : null,
  };
}

export type PortalAgeing = {
  asOf: string;
  buckets: Record<AgeingBucket, string>;
  total: string;
  overdue: string;
  rows: PortalInvoiceRow[];
};

/** The ageing table the portal shows under the outstanding tile. */
export async function customerAgeing(
  customerId: string,
  options: { asOf?: Date } = {},
): Promise<PortalAgeing> {
  const asOf = options.asOf ?? new Date();

  const invoices = await prisma.invoice.findMany({
    where: {
      customerId,
      status: { in: [...OPEN_STATUSES] },
      amountDue: { gt: 0 },
    },
    orderBy: { dueDate: "asc" },
    select: INVOICE_SELECT,
  });

  const summary = ageLedger(
    invoices.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      dueDate: invoice.dueDate,
      amountDue: invoice.amountDue.toString(),
      status: invoice.status,
    })),
    asOf,
  );

  return {
    asOf: asOf.toISOString(),
    buckets: {
      CURRENT: summary.buckets.CURRENT.toFixed(2),
      D0_30: summary.buckets.D0_30.toFixed(2),
      D31_60: summary.buckets.D31_60.toFixed(2),
      D61_90: summary.buckets.D61_90.toFixed(2),
      D90_PLUS: summary.buckets.D90_PLUS.toFixed(2),
    },
    total: summary.total.toFixed(2),
    overdue: summary.overdue.toFixed(2),
    rows: invoices.map((invoice) => toRow(invoice, asOf)),
  };
}

export const PORTAL_INVOICE_PAGE_SIZE = 20;

export type PortalInvoiceQuery = {
  /** "open" is what a customer usually wants; "all" includes settled ones. */
  scope?: "open" | "all";
  from?: Date;
  to?: Date;
  search?: string;
  take?: number;
  skip?: number;
  asOf?: Date;
};

/**
 * The customer's invoice list, each row carrying its download path.
 *
 * Drafts are excluded: a document that has not been approved for issue has
 * not been issued to anybody, and showing it invites a query about a
 * figure that may still change.
 */
export async function customerInvoices(
  customerId: string,
  query: PortalInvoiceQuery = {},
): Promise<{ rows: PortalInvoiceRow[]; total: number }> {
  const asOf = query.asOf ?? new Date();
  const take = Math.min(query.take ?? PORTAL_INVOICE_PAGE_SIZE, 100);

  const where = {
    customerId,
    status: {
      in: query.scope === "all" ? [...VISIBLE_STATUSES] : [...OPEN_STATUSES],
    },
    ...(query.from || query.to
      ? {
          invoiceDate: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
    ...(query.search
      ? { number: { contains: query.search, mode: "insensitive" as const } }
      : {}),
  };

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { invoiceDate: "desc" },
      take,
      skip: query.skip ?? 0,
      select: INVOICE_SELECT,
    }),
    prisma.invoice.count({ where }),
  ]);

  return { rows: invoices.map((invoice) => toRow(invoice, asOf)), total };
}

/**
 * Whether this invoice belongs to this customer.
 *
 * The guard the portal's print route calls before it renders anything —
 * the id in a URL is a guess until this has answered.
 */
export async function customerOwnsInvoice(
  customerId: string,
  invoiceId: string,
): Promise<boolean> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, customerId, status: { in: [...VISIBLE_STATUSES] } },
    select: { id: true },
  });
  return Boolean(invoice);
}

export type PortalInvoiceLine = {
  id: string;
  description: string;
  hsnSac: string | null;
  quantity: string;
  rate: string;
  amount: string;
  taxPercent: string | null;
  taxAmount: string;
  lrNumber: string | null;
  bookedAt: Date | null;
  chargeableWeight: string | null;
};

export type PortalInvoiceDocument = PortalInvoiceRow & {
  placeOfSupply: string | null;
  customerGstin: string | null;
  notes: string | null;
  roundOff: string;
  /** Stated tax, which under reverse charge is not in the total. */
  statedTax: string;
  lines: PortalInvoiceLine[];
  creditNotes: Array<{
    number: string;
    issuedAt: Date;
    reason: string;
    total: string;
  }>;
};

/**
 * One invoice in full, for the portal to render or print.
 *
 * Returns null rather than throwing when the invoice is not this
 * customer's — an id that does not belong to you should look exactly like
 * an id that does not exist.
 */
export async function customerInvoiceDocument(
  customerId: string,
  invoiceId: string,
  options: { asOf?: Date } = {},
): Promise<PortalInvoiceDocument | null> {
  const asOf = options.asOf ?? new Date();

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, customerId, status: { in: [...VISIBLE_STATUSES] } },
    select: {
      ...INVOICE_SELECT,
      roundOff: true,
      placeOfSupply: true,
      customerGstin: true,
      notes: true,
      lines: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          description: true,
          hsnSac: true,
          quantity: true,
          rate: true,
          amount: true,
          taxPercent: true,
          taxAmount: true,
          shipment: {
            select: { lrNumber: true, bookedAt: true, chargeableWeight: true },
          },
        },
      },
      creditNotes: {
        orderBy: { issuedAt: "asc" },
        select: { number: true, issuedAt: true, reason: true, total: true },
      },
    },
  });

  if (!invoice) return null;

  const statedTax = invoice.lines.reduce(
    (sum, line) => sum.plus(dec(line.taxAmount.toString())),
    new Decimal(0),
  );

  return {
    ...toRow(invoice, asOf),
    roundOff: money(dec(invoice.roundOff.toString())).toFixed(2),
    placeOfSupply: invoice.placeOfSupply,
    customerGstin: invoice.customerGstin,
    notes: invoice.notes,
    statedTax: money(statedTax).toFixed(2),
    lines: invoice.lines.map((line) => ({
      id: line.id,
      description: line.description,
      hsnSac: line.hsnSac,
      quantity: dec(line.quantity.toString()).toFixed(3),
      rate: dec(line.rate.toString()).toFixed(4),
      amount: money(dec(line.amount.toString())).toFixed(2),
      taxPercent: line.taxPercent ? dec(line.taxPercent.toString()).toFixed(3) : null,
      taxAmount: money(dec(line.taxAmount.toString())).toFixed(2),
      lrNumber: line.shipment?.lrNumber ?? null,
      bookedAt: line.shipment?.bookedAt ?? null,
      chargeableWeight: line.shipment
        ? dec(line.shipment.chargeableWeight.toString()).toFixed(3)
        : null,
    })),
    creditNotes: invoice.creditNotes.map((note) => ({
      number: note.number,
      issuedAt: note.issuedAt,
      reason: note.reason,
      total: money(dec(note.total.toString())).toFixed(2),
    })),
  };
}

export type PortalStatementLine = {
  date: Date | string;
  kind: StatementEntry["kind"];
  reference: string;
  description: string | null;
  debit: string;
  credit: string;
  balance: string;
};

/**
 * The customer's statement of account for a window.
 *
 * Same running-balance shape the finance screens use, with the opening
 * balance carried in from everything before the window — a statement that
 * starts at zero on the first of the month is a statement that disagrees
 * with the ledger by whatever was outstanding on the last day of the one
 * before it.
 */
export async function customerStatement(
  customerId: string,
  options: { from: Date; to: Date },
): Promise<{
  opening: string;
  closing: string;
  lines: PortalStatementLine[];
}> {
  const [invoices, payments, creditNotes, priorInvoices, priorPayments, priorCredits] =
    await Promise.all([
      prisma.invoice.findMany({
        where: {
          customerId,
          status: { in: [...VISIBLE_STATUSES], not: "CANCELLED" },
          invoiceDate: { gte: options.from, lte: options.to },
        },
        orderBy: { invoiceDate: "asc" },
        select: {
          number: true,
          invoiceDate: true,
          total: true,
          periodFrom: true,
          periodTo: true,
        },
      }),
      prisma.payment.findMany({
        where: { customerId, receivedOn: { gte: options.from, lte: options.to } },
        orderBy: { receivedOn: "asc" },
        select: {
          number: true,
          receivedOn: true,
          amount: true,
          tdsAmount: true,
          mode: true,
        },
      }),
      prisma.creditNote.findMany({
        where: { customerId, issuedAt: { gte: options.from, lte: options.to } },
        orderBy: { issuedAt: "asc" },
        select: { number: true, issuedAt: true, total: true, reason: true },
      }),
      prisma.invoice.aggregate({
        where: {
          customerId,
          status: { in: [...VISIBLE_STATUSES], not: "CANCELLED" },
          invoiceDate: { lt: options.from },
        },
        _sum: { total: true },
      }),
      prisma.payment.aggregate({
        where: { customerId, receivedOn: { lt: options.from } },
        _sum: { amount: true, tdsAmount: true },
      }),
      prisma.creditNote.aggregate({
        where: { customerId, issuedAt: { lt: options.from } },
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
      description: isDebitNoteNumber(invoice.number)
        ? "Debit note"
        : invoice.periodFrom && invoice.periodTo
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

  const statement = buildStatement(entries, opening);

  return {
    opening: statement.opening.toFixed(2),
    closing: statement.closing.toFixed(2),
    lines: statement.lines.map((line) => ({
      date: line.date,
      kind: line.kind,
      reference: line.reference,
      description: line.description ?? null,
      debit: line.debitAmount.toFixed(2),
      credit: line.creditAmount.toFixed(2),
      balance: line.balance.toFixed(2),
    })),
  };
}
