import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { customerLedger, statementOfAccount, checkCustomerCredit } from "@/lib/billing/receivables";
import { BUCKET_LABEL, AGEING_BUCKETS } from "@/lib/billing/ageing";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { EntityFormDialog, type EntityField } from "@/components/finance/entity-form";
import {
  BackLink,
  StatTiles,
  AgeingBar,
  MoneyCell,
  StatusPill,
} from "@/components/finance/finance-shell";
import { formatDate, formatMoney, isoDate } from "@/components/finance/format";
import { endOfBusinessDay, startOfBusinessDay } from "@/lib/time/business-day";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  allocateOnAccountAction,
  recordPaymentAction,
  setCreditTermsAction,
} from "../actions";

export const metadata: Metadata = { title: "Customer ledger" };
export const dynamic = "force-dynamic";

function paymentFields(
  invoices: Array<{ value: string; label: string }>,
): EntityField[] {
  return [
    {
      type: "number",
      name: "amount",
      label: "Amount received (₹)",
      required: true,
      half: true,
      step: "0.01",
    },
    {
      type: "number",
      name: "tdsAmount",
      label: "TDS deducted (₹)",
      half: true,
      step: "0.01",
      help: "Settles invoice value without arriving as cash.",
    },
    {
      type: "select",
      name: "mode",
      label: "Mode",
      required: true,
      half: true,
      options: [
        { value: "NEFT", label: "NEFT" },
        { value: "RTGS", label: "RTGS" },
        { value: "UPI", label: "UPI" },
        { value: "CHEQUE", label: "Cheque" },
        { value: "CASH", label: "Cash" },
        { value: "CARD", label: "Card" },
        { value: "ADJUSTMENT", label: "Adjustment" },
      ],
      defaultValue: "NEFT",
    },
    {
      type: "date",
      name: "receivedOn",
      label: "Received on",
      required: true,
      half: true,
      defaultValue: isoDate(new Date()),
    },
    { type: "text", name: "reference", label: "Reference", mono: true, placeholder: "UTR / cheque no." },
    {
      type: "select",
      name: "invoiceId",
      label: "Apply to",
      options: invoices,
      placeholder: "Oldest first",
      help: "Leave on oldest-first unless the customer named an invoice.",
    },
    { type: "textarea", name: "notes", label: "Notes" },
  ];
}

export default async function CustomerLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requirePermission("payment.read");
  const { customerId } = await params;
  const { from, to } = await searchParams;

  const canRecord = can(user, "payment.record");
  const canSetCredit = can(user, "customer.manage_credit");

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      code: true,
      name: true,
      gstin: true,
      paymentTerm: true,
      creditLimit: true,
      creditDays: true,
      isBlocked: true,
      blockReason: true,
      deletedAt: true,
    },
  });

  if (!customer || customer.deletedAt) notFound();

  /**
   * The statement window, on the carrier's calendar.
   *
   * `new Date(now.getFullYear(), now.getMonth() - 3, 1)` reads the
   * *server's* local month, and the bounds off the query string were bare
   * `new Date("yyyy-mm-dd")` — UTC midnight. Nothing pins `process.env.TZ`,
   * so on a UTC container this window ran five and a half hours adrift at
   * both ends: a receipt banked at 23:00 IST on the last day of the period
   * fell outside the statement, and one at 02:00 IST on the first day of
   * the next fell inside it. A statement that does not tie out is the
   * document a customer disputes.
   */
  const now = new Date();
  // Three months back to the 1st, unchanged — but counted off the business
  // calendar day rather than the server's, so the window does not shift a
  // month at 01:00 IST on the 1st.
  const [todayYear, todayMonth] = isoDate(now).split("-").map(Number);
  const defaultFrom = new Date(Date.UTC(todayYear, todayMonth - 1 - 3, 1));
  const periodFrom = startOfBusinessDay(from ? new Date(from) : defaultFrom);
  const periodTo = endOfBusinessDay(to ? new Date(to) : now);

  const [ledger, statement, credit, onAccount] = await Promise.all([
    customerLedger({ customerId }, user),
    statementOfAccount({ customerId, from: periodFrom, to: periodTo }, user),
    checkCustomerCredit({ customerId }),
    prisma.payment.findMany({
      where: { customerId, unallocated: { gt: 0 } },
      orderBy: { receivedOn: "desc" },
      select: { id: true, number: true, receivedOn: true, unallocated: true, mode: true },
    }),
  ]);

  const bucketStrings = Object.fromEntries(
    AGEING_BUCKETS.map((bucket) => [bucket, ledger.summary.buckets[bucket].toFixed(2)]),
  ) as Record<(typeof AGEING_BUCKETS)[number], string>;

  const openInvoiceOptions = ledger.rows
    .filter((row) => row.amountDue.greaterThan(0))
    .map((row) => ({
      value: row.id,
      label: `${row.number} — ${formatMoney(row.amountDue.toFixed(2))} due ${formatDate(row.dueDate)}`,
    }));

  return (
    <>
      <BackLink href="/finance/receivables" label="All receivables" />

      <PageHeader
        eyebrow={`Receivables · ${customer.code}`}
        title={customer.name}
        description={
          customer.gstin
            ? `GSTIN ${customer.gstin} · ${customer.paymentTerm.toLowerCase()} terms`
            : `${customer.paymentTerm.toLowerCase()} terms`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canSetCredit && (
              <EntityFormDialog
                title="Credit terms"
                description="The limit is enforced at booking: a consignment that would take the account past it is refused, not warned about."
                fields={[
                  {
                    type: "number",
                    name: "creditLimit",
                    label: "Credit limit (₹)",
                    half: true,
                    step: "0.01",
                    defaultValue: customer.creditLimit?.toString() ?? "",
                  },
                  {
                    type: "number",
                    name: "creditDays",
                    label: "Credit days",
                    half: true,
                    defaultValue: customer.creditDays?.toString() ?? "",
                    help: "An invoice older than this blocks new credit bookings.",
                  },
                  {
                    type: "switch",
                    name: "isBlocked",
                    label: "Block new bookings",
                    defaultChecked: customer.isBlocked,
                  },
                  {
                    type: "text",
                    name: "blockReason",
                    label: "Block reason",
                    defaultValue: customer.blockReason ?? "",
                    help: "Shown to the booking clerk verbatim.",
                  },
                ]}
                hidden={{ customerId: customer.id }}
                action={setCreditTermsAction}
                submitLabel="Save terms"
                trigger={{ label: "Credit terms", icon: "pencil", variant: "outline" }}
              />
            )}
            {canRecord && (
              <EntityFormDialog
                title="Record a payment"
                description="Applied in the same transaction it is recorded in — a receipt that lands unapplied leaves the customer being chased for money they have already sent."
                fields={paymentFields(openInvoiceOptions)}
                hidden={{ customerId: customer.id }}
                action={recordPaymentAction}
                submitLabel="Record receipt"
                trigger={{ label: "Record payment", icon: "plus" }}
              />
            )}
          </div>
        }
      />

      {credit.verdict !== "OK" && (
        <p
          className={`mb-6 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
            credit.verdict === "BLOCK"
              ? "border-bad/40 bg-bad-muted text-bad"
              : "border-warn/40 bg-warn-muted text-warn"
          }`}
        >
          {credit.verdict === "BLOCK" ? (
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          ) : (
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          )}
          <span>{credit.reason}</span>
        </p>
      )}

      <StatTiles
        items={[
          {
            label: "Outstanding",
            value: formatMoney(ledger.summary.total.toFixed(2)),
            tone: ledger.summary.isCreditBalance ? "ok" : "default",
            hint: ledger.summary.isCreditBalance ? "In credit" : undefined,
          },
          {
            label: "Overdue",
            value: formatMoney(ledger.summary.overdue.toFixed(2)),
            tone: ledger.summary.overdue.greaterThan(0) ? "warn" : "ok",
          },
          {
            label: "Oldest",
            value: ledger.summary.oldestDays > 0 ? `${ledger.summary.oldestDays} days` : "—",
            tone: ledger.summary.oldestDays > 90 ? "bad" : "default",
          },
          {
            label: "On account",
            value: formatMoney(ledger.unallocated.toFixed(2)),
            tone: ledger.unallocated.greaterThan(0) ? "info" : "default",
            hint: ledger.unallocated.greaterThan(0) ? "Unapplied receipts" : undefined,
          },
          {
            label: "Limit",
            value: customer.creditLimit
              ? formatMoney(customer.creditLimit.toString())
              : "None set",
            hint: credit.utilisationPercent
              ? `${credit.utilisationPercent.toFixed(1)}% used`
              : undefined,
            tone:
              credit.utilisationPercent && credit.utilisationPercent.greaterThan(100)
                ? "bad"
                : "default",
          },
        ]}
      />

      <div className="mb-6 rounded-lg border bg-card p-4">
        <p className="pb-3 font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
          Ageing
        </p>
        <AgeingBar buckets={bucketStrings} />
      </div>

      {/* ── Open invoices ──────────────────────────────────── */}
      <section className="pb-8">
        <h2 className="pb-3 text-sm font-semibold">Open invoices</h2>
        <TableFrame>
          {ledger.rows.length === 0 ? (
            <EmptyState title="Nothing outstanding" />
          ) : (
            <Table className="min-w-[840px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Dated</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Bucket</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.summary.rows
                  .filter((row) => row.id !== "on-account")
                  .map((aged) => {
                    const invoice = ledger.rows.find((row) => row.id === aged.id);
                    if (!invoice) return null;

                    return (
                      <TableRow key={invoice.id}>
                        <TableCell className="font-mono text-xs font-medium">
                          <Link
                            href={`/finance/invoices/${invoice.id}`}
                            className="hover:underline"
                          >
                            {invoice.number}
                          </Link>
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatDate(invoice.invoiceDate)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(invoice.dueDate)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {BUCKET_LABEL[aged.bucket]}
                          {aged.days >= 0 && (
                            <span className="ml-1 text-muted-foreground">
                              ({aged.days}d)
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <MoneyCell value={invoice.total.toFixed(2)} />
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          <MoneyCell
                            value={invoice.amountPaid.toFixed(2)}
                            tone="text-muted-foreground"
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <MoneyCell value={invoice.amountDue.toFixed(2)} strong />
                        </TableCell>
                        <TableCell>
                          <StatusPill status={invoice.status} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          )}
        </TableFrame>
      </section>

      {/* ── Money on account ───────────────────────────────── */}
      {onAccount.length > 0 && (
        <section className="pb-8">
          <h2 className="pb-3 text-sm font-semibold">
            On account
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              received but not yet applied to an invoice
            </span>
          </h2>
          <TableFrame>
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead className="text-right">Unapplied</TableHead>
                  {canRecord && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {onAccount.map((payment) => (
                  <TableRow key={payment.id}>
                    <TableCell className="font-mono text-xs">{payment.number}</TableCell>
                    <TableCell className="text-xs">{formatDate(payment.receivedOn)}</TableCell>
                    <TableCell className="text-xs">{payment.mode}</TableCell>
                    <TableCell className="text-right">
                      <MoneyCell value={payment.unallocated.toString()} tone="text-ok" />
                    </TableCell>
                    {/*
                      ── The way to apply it ─────────────────────────────

                      `allocateOnAccountAction` was written, gated on
                      `payment.record` and audited, and no screen ever
                      reached it — so money received without an invoice
                      named sat here for good. That is not merely untidy:
                      `checkCustomerCredit` counts the open invoices and
                      does *not* net what is sitting on account, so a
                      customer who had paid a lump sum still had the whole
                      amount against their credit limit and got refused at
                      booking. This table said the money was in; the
                      booking desk said the account was over its limit.
                      Both were reading the same database.
                      ───────────────────────────────────────────────────
                    */}
                    {canRecord && (
                      <TableCell className="text-right">
                        <EntityFormDialog
                          title={`Apply ${payment.number}`}
                          description="Applies money already received to an invoice that is still open. The receipt is not re-banked — this is the allocation, not a new payment."
                          fields={[
                            {
                              type: "select",
                              name: "invoiceId",
                              label: "Apply to",
                              required: true,
                              options: openInvoiceOptions,
                              placeholder: "Pick an invoice",
                            },
                            {
                              type: "number",
                              name: "amount",
                              label: "Amount to apply (₹)",
                              required: true,
                              step: "0.01",
                              defaultValue: payment.unallocated.toString(),
                              help: `${formatMoney(payment.unallocated.toString())} is unapplied on this receipt.`,
                            },
                          ]}
                          hidden={{ id: payment.id }}
                          action={allocateOnAccountAction}
                          submitLabel="Apply"
                          trigger={{
                            label: "Apply",
                            icon: "plus",
                            size: "xs",
                            variant: "outline",
                            disabled: openInvoiceOptions.length === 0,
                            disabledReason: "Nothing is open on this account to apply it to.",
                          }}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        </section>
      )}

      {/* ── Statement of account ───────────────────────────── */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2 pb-3">
          <h2 className="text-sm font-semibold">Statement of account</h2>
          <p className="text-xs text-muted-foreground">
            {formatDate(periodFrom)} – {formatDate(periodTo)} · opening{" "}
            {formatMoney(statement.opening.toFixed(2))} · closing{" "}
            {formatMoney(statement.closing.toFixed(2))}
          </p>
        </div>

        <TableFrame>
          {statement.lines.length === 0 ? (
            <EmptyState title="No activity in this window" />
          ) : (
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statement.lines.map((line, index) => (
                  <TableRow key={`${line.reference}-${line.kind}-${index}`}>
                    <TableCell className="text-xs">{formatDate(line.date)}</TableCell>
                    <TableCell className="font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                      {line.kind.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{line.reference}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {line.description ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {line.debitAmount.isZero() ? "—" : formatMoney(line.debitAmount.toFixed(2))}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {line.creditAmount.isZero()
                        ? "—"
                        : formatMoney(line.creditAmount.toFixed(2))}
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyCell value={line.balance.toFixed(2)} strong />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableFrame>
      </section>
    </>
  );
}
