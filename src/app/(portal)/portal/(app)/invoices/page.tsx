import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { Download, Receipt } from "lucide-react";
import { requireCustomerUser } from "@/lib/auth/customer-session";
import { readCustomerBilling } from "@/lib/portal/billing";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, TableFrame } from "@/components/data/data-shell";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Invoices",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const TONE: Record<string, string> = {
  open: "bg-accent text-accent-foreground",
  overdue: "bg-bad-muted text-bad",
  settled: "bg-ok-muted text-ok",
  void: "bg-muted text-muted-foreground",
};

function rupees(amount: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return `₹${amount}`;
  return `₹${value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Invoices and outstanding.
 *
 * Everything on this page comes from `readCustomerBilling`, which is
 * account-scoped in its WHERE clause and computes the ageing with the
 * shared, tested `ageLedger` rather than a second opinion of its own. If
 * billing cannot answer, the page says so — it never renders a zero
 * balance, because a customer reading "nothing outstanding" from a module
 * that could not answer will believe it.
 */
export default async function PortalInvoicesPage() {
  const session = await requireCustomerUser();
  const billing = await readCustomerBilling(session);

  if (!billing.available) {
    return (
      <>
        <PageHeader
          title="Invoices"
          description={`Billing for ${session.customerName}.`}
        />

        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Receipt className="size-5" />
          </span>
          <p className="font-medium">Your invoices are not available yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {billing.reason}
          </p>
          <p className="max-w-md text-sm text-muted-foreground">
            We would rather say this than show you a balance of zero we cannot
            stand behind.
          </p>
          <p className="text-sm text-muted-foreground">
            Proof of delivery is already available on every delivered
            consignment —{" "}
            <Link
              href="/portal/shipments?group=done"
              className="underline underline-offset-4"
            >
              see delivered shipments
            </Link>
            .
          </p>
        </div>
      </>
    );
  }

  const { outstanding, invoices } = billing;
  const owed = Number(outstanding.total);

  return (
    <>
      <PageHeader
        title="Invoices"
        description={`Billing for ${session.customerName}.`}
      />

      <section className="mb-6 flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              {outstanding.isCreditBalance ? "In credit" : "Outstanding"}
            </p>
            <p
              className={cn(
                "text-3xl font-semibold tabular tracking-tight",
                outstanding.isCreditBalance && "text-ok",
              )}
            >
              {rupees(
                outstanding.isCreditBalance
                  ? String(Math.abs(owed))
                  : outstanding.total,
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {outstanding.openCount === 0
                ? "Nothing open"
                : `${outstanding.openCount} open ${outstanding.openCount === 1 ? "invoice" : "invoices"}`}
            </p>
          </div>

          <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Overdue
            </p>
            <p
              className={cn(
                "text-3xl font-semibold tabular tracking-tight",
                Number(outstanding.overdue) > 0 && "text-bad",
              )}
            >
              {rupees(outstanding.overdue)}
            </p>
            <p className="text-xs text-muted-foreground">
              {outstanding.oldestDays > 0
                ? `Oldest is ${outstanding.oldestDays} days past due`
                : "Nothing past its due date"}
            </p>
          </div>

          <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Credits held
            </p>
            <p className="text-3xl font-semibold tabular tracking-tight">
              {rupees(outstanding.credits)}
            </p>
            <p className="text-xs text-muted-foreground">
              Credit notes and payments not yet applied
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
            Ageing
          </h2>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {outstanding.buckets.map((bucket) => (
              <div key={bucket.bucket} className="flex flex-col gap-0.5">
                <dt className="font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
                  {bucket.label}
                </dt>
                <dd
                  className={cn(
                    "text-sm font-medium tabular",
                    bucket.bucket === "D90_PLUS" &&
                      Number(bucket.amount) > 0 &&
                      "text-bad",
                  )}
                >
                  {rupees(bucket.amount)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Invoices
        </h2>

        {invoices.length === 0 ? (
          <TableFrame>
            <EmptyState
              title="No invoices yet"
              description="Nothing has been billed to this account. Invoices appear here as soon as they are issued."
            />
          </TableFrame>
        ) : (
          <ul className="flex flex-col gap-2">
            {invoices.map((invoice) => (
              <li
                key={invoice.id}
                className="flex flex-col gap-2 rounded-lg border bg-card p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider",
                      TONE[invoice.tone],
                    )}
                  >
                    {invoice.statusLabel}
                  </span>
                  <span className="font-mono text-sm font-medium">
                    {invoice.number}
                  </span>
                  <span className="ml-auto text-lg font-semibold tabular">
                    {rupees(invoice.total)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    Dated {format(invoice.invoiceDate, "dd MMM yyyy")} · due{" "}
                    {format(invoice.dueDate, "dd MMM yyyy")}
                  </span>
                  {invoice.periodFrom && invoice.periodTo && (
                    <span>
                      Covers {format(invoice.periodFrom, "dd MMM")} –{" "}
                      {format(invoice.periodTo, "dd MMM yyyy")}
                    </span>
                  )}
                  <span>
                    {invoice.shipmentCount}{" "}
                    {invoice.shipmentCount === 1 ? "line" : "lines"}
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm">
                    {Number(invoice.amountDue) > 0 ? (
                      <>
                        <span className="text-muted-foreground">Still due </span>
                        <span
                          className={cn(
                            "font-medium tabular",
                            invoice.daysOverdue > 0 && "text-bad",
                          )}
                        >
                          {rupees(invoice.amountDue)}
                        </span>
                        {invoice.daysOverdue > 0 && (
                          <span className="text-bad">
                            {" "}
                            · {invoice.daysOverdue} days late
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-ok">Settled in full</span>
                    )}
                  </p>

                  {invoice.hasDocument ? (
                    <a
                      href={`/portal/invoices/${invoice.id}/document`}
                      className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
                    >
                      <Download className="size-3.5" aria-hidden />
                      PDF
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      PDF still being prepared
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
