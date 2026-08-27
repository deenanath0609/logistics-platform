import type { Metadata } from "next";
import Link from "next/link";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import { requireUser, canAny, can } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { branchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { StatTiles } from "@/components/finance/finance-shell";
import { formatMoneyShort } from "@/components/finance/format";

export const metadata: Metadata = { title: "Finance" };
export const dynamic = "force-dynamic";

/**
 * The finance landing page.
 *
 * The sidebar is generated from a shared navigation table this phase does
 * not own, so this page is how the module is reachable until a Finance
 * group is added there. Each card is hidden when the user lacks the
 * permission behind it — the same rule the nav follows.
 */

const SECTIONS = [
  {
    href: "/finance/rate-cards",
    title: "Rate cards",
    permission: "ratecard.read",
    description:
      "Versioned tariffs and customer contracts. Approving a version freezes it, because invoices reference it.",
  },
  {
    href: "/finance/invoices",
    title: "Invoices",
    permission: "invoice.read",
    description:
      "Per shipment or consolidated for a period. Every line traces to its consignment and its calculation trace.",
  },
  {
    href: "/finance/receivables",
    title: "Receivables",
    permission: "payment.read",
    description:
      "Ageing, credit limits, receipts and allocation, TDS, and the statement of account.",
  },
  {
    href: "/vendors",
    title: "Vendors",
    permission: "vendor.read",
    description:
      "Rate contracts, bills reconciled against them, and payments. The other half of margin.",
  },
  {
    href: "/finance/settlements",
    title: "Driver settlements",
    permission: "settlement.read",
    description:
      "Trip earning less advances, less approved expenses, less deductions — with an approval before payout.",
  },
  {
    href: "/finance/profitability",
    title: "Profitability",
    permission: "report.financial",
    description: "Contribution per trip and per consignment, revenue against what the run cost.",
  },
  {
    href: "/finance/coverage-gaps",
    title: "Coverage gaps",
    permission: "ratecard.read",
    description:
      "Consignments no rate rule matched. They booked unrated rather than at zero; this is the list that closes them.",
  },
];

export default async function FinanceHomePage() {
  const user = await requireUser();

  const readable = SECTIONS.filter((section) => can(user, section.permission));
  if (readable.length === 0) redirect("/forbidden");

  const showMoney = canAny(user, ["invoice.read", "payment.read"]);

  const [receivable, payable, drafts, gaps] = showMoney
    ? await Promise.all([
        prisma.invoice.aggregate({
          where: {
            ...branchScope(user, "branchId"),
            status: { in: ["ISSUED", "PARTIALLY_PAID", "CREDITED"] },
          },
          _sum: { amountDue: true },
        }),
        prisma.vendorBill.aggregate({
          where: { orgId: user.orgId, status: { in: ["APPROVED", "PARTIALLY_PAID"] } },
          _sum: { amountDue: true },
        }),
        prisma.invoice.count({
          where: { ...branchScope(user, "branchId"), status: "DRAFT" },
        }),
        prisma.freightCalculation.count({
          where: { trace: { path: ["unrated"], equals: true } },
        }),
      ])
    : [null, null, 0, 0];

  const receivableTotal = new Decimal(receivable?._sum.amountDue?.toString() ?? 0);
  const payableTotal = new Decimal(payable?._sum.amountDue?.toString() ?? 0);

  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Rating, billing & settlement"
        description="What the customer is charged and what the vendor is paid, kept in the same place so margin is knowable rather than inferred at year end."
      />

      {showMoney && (
        <StatTiles
          items={[
            {
              label: "Receivable",
              value: formatMoneyShort(receivableTotal.toFixed(2)),
              tone: receivableTotal.greaterThan(0) ? "warn" : "ok",
            },
            {
              label: "Payable",
              value: formatMoneyShort(payableTotal.toFixed(2)),
              tone: payableTotal.greaterThan(0) ? "info" : "ok",
            },
            {
              label: "Net position",
              value: formatMoneyShort(receivableTotal.minus(payableTotal).toFixed(2)),
            },
            {
              label: "Draft invoices",
              value: String(drafts),
              tone: drafts > 0 ? "info" : "default",
            },
            {
              label: "Coverage gaps",
              value: String(gaps),
              tone: gaps > 0 ? "warn" : "ok",
            },
          ]}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {readable.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="flex flex-col gap-1.5 rounded-lg border bg-card px-4 py-3.5 transition-colors hover:border-primary/50 hover:bg-muted/40"
          >
            <span className="font-medium">{section.title}</span>
            <span className="text-sm text-muted-foreground">{section.description}</span>
          </Link>
        ))}
      </div>
    </>
  );
}
