import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { EntityFormDialog, type EntityField } from "@/components/finance/entity-form";
import { StatTiles, MoneyCell } from "@/components/finance/finance-shell";
import { formatMoneyShort, formatPercent } from "@/components/finance/format";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createVendorAction } from "./actions";

export const metadata: Metadata = { title: "Vendors" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const KIND_LABEL: Record<string, string> = {
  TRANSPORTER: "Transporter",
  BROKER: "Broker",
  ATTACHED_OWNER: "Attached owner",
  SERVICE: "Service",
};

export const VENDOR_FIELDS: EntityField[] = [
  { type: "text", name: "code", label: "Code", required: true, half: true, mono: true, placeholder: "SHREE01" },
  {
    type: "select",
    name: "kind",
    label: "Kind",
    required: true,
    half: true,
    options: [
      { value: "TRANSPORTER", label: "Transporter" },
      { value: "BROKER", label: "Broker" },
      { value: "ATTACHED_OWNER", label: "Attached vehicle owner" },
      { value: "SERVICE", label: "Service provider" },
    ],
    defaultValue: "TRANSPORTER",
  },
  { type: "text", name: "name", label: "Trading name", required: true, placeholder: "Shree Roadlines" },
  { type: "text", name: "legalName", label: "Legal name", help: "As it appears on their invoices, if different." },
  { type: "text", name: "phone", label: "Phone", required: true, half: true, mono: true },
  { type: "text", name: "email", label: "Email", half: true },
  {
    type: "text",
    name: "gstin",
    label: "GSTIN",
    half: true,
    mono: true,
    placeholder: "06ABCDE1234F1Z5",
  },
  { type: "text", name: "pan", label: "PAN", half: true, mono: true, placeholder: "ABCDE1234F" },
  { type: "textarea", name: "address", label: "Address" },
  {
    type: "number",
    name: "paymentTermDays",
    label: "Payment term (days)",
    half: true,
    help: "Days from bill date to due date.",
  },
  {
    type: "number",
    name: "tdsPercent",
    label: "TDS %",
    half: true,
    step: "0.01",
    help: "194C: 1% for individuals and HUF, 2% otherwise.",
  },
  { type: "textarea", name: "notes", label: "Notes" },
];

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const user = await requirePermission("vendor.read");
  const writable = can(user, "vendor.create");
  const { q, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const where = {
    orgId: user.orgId,
    deletedAt: null,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { code: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q } },
            { gstin: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, total, payable, flagged] = await Promise.all([
    prisma.vendor.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        _count: { select: { rateContracts: true, trips: true, vehicles: true } },
        bills: {
          where: { status: { in: ["SUBMITTED", "APPROVED", "PARTIALLY_PAID", "DISPUTED"] } },
          select: { amountDue: true, varianceAmount: true, status: true },
        },
      },
    }),
    prisma.vendor.count({ where }),
    prisma.vendorBill.aggregate({
      where: { orgId: user.orgId, status: { in: ["APPROVED", "PARTIALLY_PAID"] } },
      _sum: { amountDue: true },
    }),
    prisma.vendorBill.count({
      where: {
        orgId: user.orgId,
        status: { in: ["SUBMITTED", "DISPUTED"] },
        NOT: { varianceAmount: null },
      },
    }),
  ]);

  const activeCount = rows.filter((vendor) => vendor.isActive).length;

  return (
    <>
      <PageHeader
        eyebrow="Parties"
        title="Vendors"
        description="Transporters, brokers and attached-vehicle owners. Their rate contract mirrors the customer rate card, which is what makes margin per trip computable rather than guessed."
        actions={
          <div className="flex items-center gap-2">
            <SearchInput placeholder="Name, code, phone, GSTIN" />
            {writable && (
              <EntityFormDialog
                title="New vendor"
                description="PAN and GSTIN are worth capturing now: TDS and reverse charge both key off them, and chasing them at payment time is how a bill sits unpaid for a fortnight."
                fields={VENDOR_FIELDS}
                action={createVendorAction}
                submitLabel="Create"
                trigger={{ label: "New vendor", icon: "plus" }}
              />
            )}
          </div>
        }
      />

      <StatTiles
        items={[
          { label: "Vendors", value: String(total) },
          { label: "Active", value: String(activeCount) },
          {
            label: "Payable",
            value: formatMoneyShort(payable._sum.amountDue?.toString() ?? 0),
            tone: "warn",
          },
          {
            label: "Bills with variance",
            value: String(flagged),
            tone: flagged > 0 ? "bad" : "ok",
            hint: "Checked against the contract",
          },
        ]}
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title={q ? `Nothing matches “${q}”` : "No vendors yet"}
            description="Add the transporters you run line-haul with first."
          />
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>GSTIN</TableHead>
                <TableHead className="text-right">TDS</TableHead>
                <TableHead className="text-right">Contracts</TableHead>
                <TableHead className="text-right">Payable</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((vendor) => {
                const due = vendor.bills.reduce(
                  (sum, bill) => sum.plus(new Decimal(bill.amountDue.toString())),
                  new Decimal(0),
                );
                const hasVariance = vendor.bills.some(
                  (bill) =>
                    bill.varianceAmount !== null && Number(bill.varianceAmount) !== 0,
                );

                return (
                  <TableRow key={vendor.id} className={vendor.isActive ? "" : "opacity-55"}>
                    <TableCell className="font-mono text-xs font-medium">
                      <Link href={`/vendors/${vendor.id}`} className="hover:underline">
                        {vendor.code}
                      </Link>
                    </TableCell>
                    <TableCell className="font-medium">
                      {vendor.name}
                      {hasVariance && (
                        <span className="ml-1.5 rounded-sm bg-bad-muted px-1 py-0.5 text-[0.55rem] uppercase tracking-wider text-bad">
                          variance
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {KIND_LABEL[vendor.kind] ?? vendor.kind}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {vendor.gstin ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular text-muted-foreground">
                      {vendor.tdsPercent ? formatPercent(vendor.tdsPercent.toString()) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular">
                      {vendor._count.rateContracts}
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyCell
                        value={due.toFixed(2)}
                        tone={due.greaterThan(0) ? "text-warn" : "text-muted-foreground"}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge variant={vendor.isBlocked ? "destructive" : vendor.isActive ? "secondary" : "outline"}>
                        {vendor.isBlocked ? "Blocked" : vendor.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/vendors/${vendor.id}`}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Open ${vendor.code}`}
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

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        baseParams={{ q }}
        pathname="/vendors"
      />
    </>
  );
}
