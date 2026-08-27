import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, ShieldAlert } from "lucide-react";
import Decimal from "decimal.js";
import { requirePermission } from "@/lib/auth/session";
import { receivablesOverview } from "@/lib/billing/receivables";
import { AGEING_BUCKETS, BUCKET_LABEL } from "@/lib/billing/ageing";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { StatTiles, AgeingBar, MoneyCell } from "@/components/finance/finance-shell";
import { formatMoneyShort } from "@/components/finance/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Receivables" };
export const dynamic = "force-dynamic";

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requirePermission("payment.read");
  const { q } = await searchParams;

  const accounts = await receivablesOverview({ search: q }, user);

  const totals = AGEING_BUCKETS.reduce<Record<string, Decimal>>((acc, bucket) => {
    acc[bucket] = accounts.reduce(
      (sum, account) => sum.plus(account.summary.buckets[bucket]),
      new Decimal(0),
    );
    return acc;
  }, {});

  const book = accounts.reduce(
    (sum, account) => sum.plus(account.summary.total),
    new Decimal(0),
  );
  const overdue = accounts.reduce(
    (sum, account) => sum.plus(account.summary.overdue),
    new Decimal(0),
  );
  const overLimit = accounts.filter(
    (account) => account.creditLimit && account.summary.total.greaterThan(account.creditLimit),
  );

  const bucketStrings = Object.fromEntries(
    AGEING_BUCKETS.map((bucket) => [bucket, totals[bucket].toFixed(2)]),
  ) as Record<(typeof AGEING_BUCKETS)[number], string>;

  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Receivables"
        description="Who owes what, and for how long. Money sitting unallocated on an account nets against the ledger, so an account is never chased for a payment already banked."
        actions={<SearchInput placeholder="Customer name or code" />}
      />

      <StatTiles
        items={[
          { label: "Total book", value: formatMoneyShort(book.toFixed(2)) },
          {
            label: "Overdue",
            value: formatMoneyShort(overdue.toFixed(2)),
            tone: overdue.greaterThan(0) ? "warn" : "ok",
          },
          {
            label: "90+ days",
            value: formatMoneyShort(totals.D90_PLUS.toFixed(2)),
            tone: totals.D90_PLUS.greaterThan(0) ? "bad" : "ok",
          },
          { label: "Accounts open", value: String(accounts.length) },
          {
            label: "Over limit",
            value: String(overLimit.length),
            tone: overLimit.length > 0 ? "bad" : "ok",
            hint: overLimit.length > 0 ? "Bookings are blocked" : undefined,
          },
        ]}
      />

      <div className="rounded-lg border bg-card p-4 mb-6">
        <p className="pb-3 font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
          Ageing profile
        </p>
        <AgeingBar buckets={bucketStrings} />
      </div>

      <TableFrame>
        {accounts.length === 0 ? (
          <EmptyState
            title={q ? `Nothing matches “${q}”` : "Nothing outstanding"}
            description="Either every invoice is settled, or none have been issued yet."
          />
        ) : (
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                {AGEING_BUCKETS.filter((b) => b !== "CURRENT").map((bucket) => (
                  <TableHead key={bucket} className="text-right">
                    {BUCKET_LABEL[bucket]}
                  </TableHead>
                ))}
                <TableHead className="text-right">Not due</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Limit</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account) => {
                const breached =
                  account.creditLimit &&
                  account.summary.total.greaterThan(account.creditLimit);

                return (
                  <TableRow key={account.customerId}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/finance/receivables/${account.customerId}`}
                        className="hover:underline"
                      >
                        {account.name}
                      </Link>
                      <span className="ml-1.5 font-mono text-[0.65rem] text-muted-foreground">
                        {account.code}
                      </span>
                      {account.summary.oldestDays > 90 && (
                        <span className="ml-1.5 rounded-sm bg-bad-muted px-1 py-0.5 text-[0.55rem] uppercase tracking-wider text-bad">
                          {account.summary.oldestDays}d
                        </span>
                      )}
                    </TableCell>
                    {AGEING_BUCKETS.filter((b) => b !== "CURRENT").map((bucket) => (
                      <TableCell key={bucket} className="text-right text-xs">
                        <MoneyCell
                          value={account.summary.buckets[bucket].toFixed(2)}
                          tone={
                            account.summary.buckets[bucket].isZero()
                              ? "text-muted-foreground"
                              : bucket === "D90_PLUS"
                                ? "text-bad"
                                : undefined
                          }
                        />
                      </TableCell>
                    ))}
                    <TableCell className="text-right text-xs">
                      <MoneyCell
                        value={account.summary.buckets.CURRENT.toFixed(2)}
                        tone="text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyCell value={account.summary.total.toFixed(2)} strong />
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {account.creditLimit ? (
                        <span
                          className={`inline-flex items-center gap-1 tabular ${
                            breached ? "text-bad" : "text-muted-foreground"
                          }`}
                        >
                          {breached && <ShieldAlert className="size-3" />}
                          {formatMoneyShort(account.creditLimit.toFixed(2))}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">None set</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/finance/receivables/${account.customerId}`}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Open ${account.name}`}
                      >
                        <ChevronRight className="size-4" />
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TableFrame>
    </>
  );
}
