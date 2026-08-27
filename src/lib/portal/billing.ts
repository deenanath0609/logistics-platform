import { prisma } from "@/lib/prisma";
import type { InvoiceStatus } from "@/generated/prisma/client";
import type { CustomerSession } from "@/lib/auth/customer-session";
import {
  ageLedger,
  AGEING_BUCKETS,
  BUCKET_LABEL,
  type AgeingBucket,
} from "@/lib/billing/ageing";
import { customerOwnedFilter } from "./visibility";

/**
 * Invoices and outstanding, from the customer's side.
 *
 * The arithmetic is not done here. Bucketing, netting credits off and
 * deciding what counts as overdue all come from `@/lib/billing/ageing`,
 * which is pure and already tested — a portal that computed its own
 * ageing would eventually disagree with the receivables screen, and the
 * customer would be the one who noticed.
 *
 * ── The contract ──────────────────────────────────────────
 *
 * `CustomerBillingReader` below is the whole of what the portal needs from
 * billing: two customer-scoped reads, no writes. `readCustomerBilling` is
 * the current implementation, and it is deliberately the *only* place in
 * the portal that touches an invoice table. When `src/lib/billing/**`
 * publishes its own customer-scoped readers, that one function is the
 * swap — nothing above it changes.
 *
 * ── Honesty over zero ─────────────────────────────────────
 *
 * If the read fails — the module is mid-deploy, the table is not there
 * yet, a query throws — the result is `{ available: false }` and the
 * screen says so. It never falls back to a zero balance. "You owe nothing"
 * is a statement about someone's money, and a customer who reads it from a
 * module that is not finished will believe it right up until the reminder
 * letter arrives.
 */

// ────────────────────────────────────────────────────────────
// The contract
// ────────────────────────────────────────────────────────────

export type PortalInvoiceRow = {
  id: string;
  number: string;
  status: InvoiceStatus;
  statusLabel: string;
  tone: "open" | "overdue" | "settled" | "void";
  invoiceDate: Date;
  dueDate: Date;
  periodFrom: Date | null;
  periodTo: Date | null;
  /** Money crosses as a fixed-2 string. A Decimal is not serialisable. */
  total: string;
  amountPaid: string;
  amountDue: string;
  /** Positive once the due date has passed and something is still owed. */
  daysOverdue: number;
  /** True once the branded PDF has been rendered. */
  hasDocument: boolean;
  shipmentCount: number;
};

export type PortalAgeingBucket = {
  bucket: AgeingBucket;
  label: string;
  amount: string;
};

export type PortalOutstanding = {
  /** Everything owed, credits already netted off. */
  total: string;
  /** The part past its due date. */
  overdue: string;
  /** Credits sitting on the account, as a positive figure. */
  credits: string;
  /** True when we owe them rather than the reverse. */
  isCreditBalance: boolean;
  oldestDays: number;
  openCount: number;
  buckets: PortalAgeingBucket[];
};

export type PortalBilling =
  | { available: true; outstanding: PortalOutstanding; invoices: PortalInvoiceRow[] }
  | { available: false; reason: string };

/**
 * What the portal needs from billing. Two reads, both account-scoped.
 *
 * Written as a type rather than assumed, so the day
 * `src/lib/billing/**` exposes its own customer-scoped readers there is
 * something concrete to check them against.
 */
export type CustomerBillingReader = {
  /** Invoices this account may see, newest first. Drafts excluded. */
  invoices(
    session: CustomerSession,
    options?: { take?: number },
  ): Promise<PortalInvoiceRow[]>;
  /** The account's outstanding position, aged. */
  outstanding(session: CustomerSession): Promise<PortalOutstanding>;
};

// ────────────────────────────────────────────────────────────
// Presentation
// ────────────────────────────────────────────────────────────

/**
 * A draft is not an invoice.
 *
 * It is a working figure an accounts clerk is still arguing with, and a
 * customer seeing one would reasonably start paying it. Cancelled and
 * credited invoices *are* shown: a customer who has a copy of a document
 * we have since withdrawn needs to be able to see that we withdrew it.
 */
const VISIBLE_STATUSES: InvoiceStatus[] = [
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "CANCELLED",
  "CREDITED",
];

/** Statuses that carry a live balance. Cancelled ones do not. */
const OPEN_STATUSES: InvoiceStatus[] = ["ISSUED", "PARTIALLY_PAID", "CREDITED"];

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  DRAFT: "Draft",
  ISSUED: "Due",
  PARTIALLY_PAID: "Part paid",
  PAID: "Paid",
  CANCELLED: "Cancelled",
  CREDITED: "Credited",
};

function toneFor(
  status: InvoiceStatus,
  daysOverdue: number,
): PortalInvoiceRow["tone"] {
  if (status === "CANCELLED") return "void";
  if (status === "PAID") return "settled";
  return daysOverdue > 0 ? "overdue" : "open";
}

/** Whole days past the due date; zero while it is still in the future. */
function overdueDays(dueDate: Date, asOf: Date): number {
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const now = new Date(asOf);
  now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((now.getTime() - due.getTime()) / 86_400_000));
}

// ────────────────────────────────────────────────────────────
// The read
// ────────────────────────────────────────────────────────────

/**
 * Everything the invoices screen needs, in one pass.
 *
 * One query rather than two: the ageing is computed from exactly the rows
 * the list shows, so the total at the top of the page and the rows under
 * it can never disagree — which is the complaint every customer billing
 * screen eventually receives.
 */
export async function readCustomerBilling(
  session: CustomerSession,
  options: { take?: number; asOf?: Date } = {},
): Promise<PortalBilling> {
  const asOf = options.asOf ?? new Date();

  try {
    const rows = await prisma.invoice.findMany({
      // Spread first; nothing below writes `customerId`.
      where: {
        ...customerOwnedFilter(session),
        status: { in: VISIBLE_STATUSES },
      },
      orderBy: [{ invoiceDate: "desc" }, { number: "desc" }],
      take: options.take ?? 100,
      select: {
        id: true,
        number: true,
        status: true,
        invoiceDate: true,
        dueDate: true,
        periodFrom: true,
        periodTo: true,
        total: true,
        amountPaid: true,
        amountDue: true,
        documentAssetId: true,
        _count: { select: { lines: true } },
      },
    });

    const invoices: PortalInvoiceRow[] = rows.map((row) => {
      const days =
        row.status === "PAID" || row.status === "CANCELLED"
          ? 0
          : overdueDays(row.dueDate, asOf);

      return {
        id: row.id,
        number: row.number,
        status: row.status,
        statusLabel: STATUS_LABEL[row.status],
        tone: toneFor(row.status, days),
        invoiceDate: row.invoiceDate,
        dueDate: row.dueDate,
        periodFrom: row.periodFrom,
        periodTo: row.periodTo,
        total: row.total.toFixed(2),
        amountPaid: row.amountPaid.toFixed(2),
        amountDue: row.amountDue.toFixed(2),
        daysOverdue: days,
        hasDocument: Boolean(row.documentAssetId),
        shipmentCount: row._count.lines,
      };
    });

    // Ageing is the shared, tested function's answer — not a second
    // opinion computed here.
    const summary = ageLedger(
      rows
        .filter((row) => OPEN_STATUSES.includes(row.status))
        .map((row) => ({
          id: row.id,
          number: row.number,
          dueDate: row.dueDate,
          invoiceDate: row.invoiceDate,
          amountDue: row.amountDue,
        })),
      asOf,
    );

    return {
      available: true,
      invoices,
      outstanding: {
        total: summary.total.toFixed(2),
        overdue: summary.overdue.toFixed(2),
        credits: summary.credits.toFixed(2),
        isCreditBalance: summary.isCreditBalance,
        oldestDays: summary.oldestDays,
        openCount: summary.count,
        buckets: AGEING_BUCKETS.map((bucket) => ({
          bucket,
          label: BUCKET_LABEL[bucket],
          amount: summary.buckets[bucket].toFixed(2),
        })),
      },
    };
  } catch (error) {
    // Deliberately not a zero balance. See the note at the top of the file.
    console.error("[portal billing]", error);
    return {
      available: false,
      reason:
        "Billing is still being switched on for your account. Your branch can send you a statement in the meantime.",
    };
  }
}

/** The adapter, in the shape the rest of the portal consumes. */
export const portalBilling: CustomerBillingReader = {
  async invoices(session, options) {
    const result = await readCustomerBilling(session, options);
    return result.available ? result.invoices : [];
  },
  async outstanding(session) {
    const result = await readCustomerBilling(session);
    if (!result.available) {
      throw new Error(result.reason);
    }
    return result.outstanding;
  },
};

/**
 * One invoice, if and only if it belongs to this account.
 *
 * Used to hand back a download: the asset id is only ever resolved through
 * a query that already carries the account, so a guessed invoice id
 * resolves to nothing rather than to somebody else's PDF.
 */
export async function getPortalInvoiceAsset(
  session: CustomerSession,
  invoiceId: string,
): Promise<{ number: string; documentAssetId: string } | null> {
  const invoice = await prisma.invoice.findFirst({
    where: {
      ...customerOwnedFilter(session),
      id: invoiceId,
      status: { in: VISIBLE_STATUSES },
    },
    select: { number: true, documentAssetId: true },
  });

  if (!invoice?.documentAssetId) return null;
  return { number: invoice.number, documentAssetId: invoice.documentAssetId };
}

/**
 * The outstanding figure for the overview card.
 *
 * Returns null rather than zero when billing cannot answer, because
 * `StatCard` renders null as "coming soon" and a zero as a fact.
 */
export async function portalOutstandingSummary(
  session: CustomerSession,
): Promise<PortalOutstanding | null> {
  const result = await readCustomerBilling(session, { take: 200 });
  return result.available ? result.outstanding : null;
}
