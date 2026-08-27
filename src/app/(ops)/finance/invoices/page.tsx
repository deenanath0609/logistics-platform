import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { EntityFormDialog, type EntityField } from "@/components/finance/entity-form";
import { StatTiles, StatusPill, MoneyCell } from "@/components/finance/finance-shell";
import { formatDate, isoDate, formatMoneyShort } from "@/components/finance/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { generateInvoiceAction, runBillingAction } from "./actions";

export const metadata: Metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const STATUSES = [
  "DRAFT",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "CREDITED",
  "CANCELLED",
] as const;

function monthStart(): string {
  const now = new Date();
  return isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
}

function generateFields(
  customers: Array<{ value: string; label: string }>,
  branches: Array<{ value: string; label: string }>,
): EntityField[] {
  return [
    {
      type: "select",
      name: "customerId",
      label: "Customer",
      required: true,
      options: customers,
      placeholder: "Pick an account",
    },
    {
      type: "select",
      name: "branchId",
      label: "Billing branch",
      required: true,
      half: true,
      options: branches,
      placeholder: "Pick a branch",
    },
    {
      type: "switch",
      name: "deliveredOnly",
      label: "Delivered consignments only",
      help: "Off bills everything booked in the window, delivered or not.",
      defaultChecked: true,
    },
    {
      type: "date",
      name: "periodFrom",
      label: "From",
      required: true,
      half: true,
      defaultValue: monthStart(),
    },
    {
      type: "date",
      name: "periodTo",
      label: "To",
      required: true,
      half: true,
      defaultValue: isoDate(new Date()),
    },
    { type: "textarea", name: "notes", label: "Notes on the invoice" },
  ];
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const user = await requirePermission("invoice.read");
  const writable = can(user, "invoice.create");
  const { q, status, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const where = {
    ...branchScope(user, "branchId"),
    ...(status && STATUSES.includes(status as (typeof STATUSES)[number])
      ? { status: status as (typeof STATUSES)[number] }
      : {}),
    ...(q
      ? {
          OR: [
            { number: { contains: q, mode: "insensitive" as const } },
            { customer: { name: { contains: q, mode: "insensitive" as const } } },
            { customer: { code: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const [rows, total, totals, customers, branches] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { invoiceDate: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        customer: { select: { code: true, name: true } },
        branch: { select: { code: true } },
        _count: { select: { lines: true, creditNotes: true } },
      },
    }),
    prisma.invoice.count({ where }),
    prisma.invoice.aggregate({
      where: { ...branchScope(user, "branchId"), status: { notIn: ["CANCELLED", "DRAFT"] } },
      _sum: { total: true, amountDue: true },
      _count: true,
    }),
    prisma.customer.findMany({
      where: { isActive: true, deletedAt: null, ...branchScope(user, "branchId") },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true },
      take: 500,
    }),
    prisma.branch.findMany({
      where: { isActive: true, deletedAt: null, ...branchScope(user, "id") },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  const draftCount = await prisma.invoice.count({
    where: { ...branchScope(user, "branchId"), status: "DRAFT" },
  });

  const customerOptions = customers.map((c) => ({
    value: c.id,
    label: `${c.code} — ${c.name}`,
  }));
  const branchOptions = branches.map((b) => ({
    value: b.id,
    label: `${b.code} — ${b.name}`,
  }));

  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Invoices"
        description="Every line traces to the consignment it came from and to the stored calculation trace. Reverse-charge invoices state the tax and leave it out of the total — the recipient pays it."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Invoice number or customer" />
            {writable && (
              <>
                <EntityFormDialog
                  title="Monthly bill run"
                  description="One consolidated invoice per credit account for the window, or one per account per branch. Accounts with nothing billable are skipped, not failed."
                  fields={[
                    {
                      type: "select",
                      name: "branchId",
                      label: "Billing branch",
                      required: true,
                      options: branchOptions,
                      placeholder: "Pick a branch",
                      help: "Ignored when billing branch-wise — each invoice is then raised from the branch that booked the consignments.",
                    },
                    {
                      type: "switch",
                      name: "perBranch",
                      label: "Branch-wise invoices",
                      help: "One invoice per account per originating branch, rather than one covering the network.",
                    },
                    {
                      type: "date",
                      name: "periodFrom",
                      label: "From",
                      required: true,
                      half: true,
                      defaultValue: monthStart(),
                    },
                    {
                      type: "date",
                      name: "periodTo",
                      label: "To",
                      required: true,
                      half: true,
                      defaultValue: isoDate(new Date()),
                    },
                    {
                      type: "switch",
                      name: "deliveredOnly",
                      label: "Delivered consignments only",
                      defaultChecked: true,
                    },
                  ]}
                  action={runBillingAction}
                  submitLabel="Run"
                  trigger={{ label: "Bill run", icon: "copy", variant: "outline" }}
                />
                <EntityFormDialog
                  title="New invoice"
                  description="Bills one customer for a window. Consignments already on a live invoice are excluded automatically."
                  fields={generateFields(customerOptions, branchOptions)}
                  action={generateInvoiceAction}
                  submitLabel="Generate draft"
                  trigger={{ label: "New invoice", icon: "plus" }}
                />
              </>
            )}
          </div>
        }
      />

      <StatTiles
        items={[
          { label: "Live invoices", value: String(totals._count) },
          {
            label: "Billed",
            value: formatMoneyShort(totals._sum.total?.toString() ?? 0),
          },
          {
            label: "Outstanding",
            value: formatMoneyShort(totals._sum.amountDue?.toString() ?? 0),
            tone: "warn",
          },
          {
            label: "Drafts",
            value: String(draftCount),
            tone: draftCount > 0 ? "info" : "default",
            hint: draftCount > 0 ? "Awaiting approval" : undefined,
          },
        ]}
      />

      <div className="flex flex-wrap gap-1.5 pb-4">
        <FilterChip label="All" href="/finance/invoices" active={!status} />
        {STATUSES.map((value) => (
          <FilterChip
            key={value}
            label={value.replace(/_/g, " ")}
            href={`/finance/invoices?status=${value}`}
            active={status === value}
          />
        ))}
      </div>

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title={q ? `Nothing matches “${q}”` : "No invoices yet"}
            description="Generate one for a customer, or run consolidated monthly billing."
          />
        ) : (
          <Table className="min-w-[940px]">
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell className="font-mono text-xs font-medium">
                    <Link href={`/finance/invoices/${invoice.id}`} className="hover:underline">
                      {invoice.number}
                    </Link>
                    {invoice.isReverseCharge && (
                      <span className="ml-1.5 rounded-sm bg-warn-muted px-1 py-0.5 text-[0.55rem] uppercase tracking-wider text-warn">
                        RCM
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-medium">
                    {invoice.customer.name}
                    <span className="ml-1.5 font-mono text-[0.65rem] text-muted-foreground">
                      {invoice.customer.code}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">{formatDate(invoice.invoiceDate)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(invoice.dueDate)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular">
                    {invoice._count.lines}
                    {invoice._count.creditNotes > 0 && (
                      <span className="ml-1 text-warn">
                        +{invoice._count.creditNotes} CN
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyCell value={invoice.total.toString()} />
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyCell
                      value={invoice.amountDue.toString()}
                      tone={Number(invoice.amountDue) > 0 ? "text-warn" : "text-muted-foreground"}
                    />
                  </TableCell>
                  <TableCell>
                    <StatusPill status={invoice.status} />
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/finance/invoices/${invoice.id}`}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={`Open ${invoice.number}`}
                    >
                      <ChevronRight className="size-4" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        baseParams={{ q, status }}
        pathname="/finance/invoices"
      />
    </>
  );
}

function FilterChip({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-2.5 py-0.5 font-mono text-[0.65rem] uppercase tracking-wider transition-colors ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-muted"
      }`}
    >
      {label}
    </Link>
  );
}
