import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, ShieldAlert } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { MasterFormDialog, type FieldDef } from "@/components/data/master-form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createCustomer } from "./actions";

export const metadata: Metadata = { title: "Customers" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const TYPE_TONE: Record<string, string> = {
  CORPORATE: "bg-accent text-accent-foreground",
  RETAIL: "bg-info-muted text-info",
  WALK_IN: "bg-muted text-muted-foreground",
};

export function buildCustomerFields(
  cities: Array<{ value: string; label: string }>,
  branches: Array<{ value: string; label: string }>,
  canSetCredit: boolean,
): FieldDef[] {
  return [
    { type: "text", name: "code", label: "Account code", required: true, half: true, mono: true, placeholder: "ACME01" },
    {
      type: "select",
      name: "type",
      label: "Type",
      required: true,
      half: true,
      options: [
        { value: "CORPORATE", label: "Corporate — credit account" },
        { value: "RETAIL", label: "Retail — regular walk-up" },
        { value: "WALK_IN", label: "Walk-in — cash, one off" },
      ],
    },
    { type: "text", name: "name", label: "Trading name", required: true, placeholder: "Acme Industries" },
    { type: "text", name: "legalName", label: "Legal name", help: "As it should appear on the invoice, if different." },
    { type: "text", name: "phone", label: "Phone", required: true, half: true, mono: true, placeholder: "9811100000" },
    { type: "text", name: "altPhone", label: "Alternate phone", half: true, mono: true },
    { type: "text", name: "email", label: "Email", half: true },
    {
      type: "select",
      name: "branchId",
      label: "Owning branch",
      half: true,
      options: branches,
      placeholder: "Your branch",
      help: "Decides who can see this account.",
    },
    {
      type: "text",
      name: "gstin",
      label: "GSTIN",
      half: true,
      mono: true,
      placeholder: "06ABCDE1234F1Z5",
      help: "Needed to decide reverse charge on the consignment note.",
    },
    { type: "text", name: "pan", label: "PAN", half: true, mono: true, placeholder: "ABCDE1234F" },
    { type: "textarea", name: "billingAddress", label: "Billing address" },
    { type: "select", name: "billingCityId", label: "Billing city", half: true, options: cities, placeholder: "—" },
    { type: "text", name: "billingPincode", label: "Billing PIN", half: true, mono: true },
    {
      type: "select",
      name: "paymentTerm",
      label: "Payment term",
      required: true,
      half: true,
      options: [
        { value: "CASH", label: "Cash on booking" },
        { value: "PREPAID", label: "Prepaid / advance" },
        { value: "CREDIT", label: "Credit account" },
      ],
      help: canSetCredit ? undefined : "Changing this needs the credit permission.",
    },
    {
      type: "number",
      name: "creditDays",
      label: "Credit days",
      half: true,
      help: canSetCredit ? undefined : "Accounts sets this.",
    },
    {
      type: "number",
      name: "creditLimit",
      label: "Credit limit (₹)",
      half: true,
      step: "0.01",
      help: "Enforced at booking from Phase 6.",
    },
    { type: "textarea", name: "notes", label: "Notes" },
    { type: "switch", name: "isActive", label: "Active", help: "Inactive accounts cannot be booked against." },
  ];
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const user = await requirePermission("customer.read");
  const writable = can(user, "customer.create");
  const canSetCredit = can(user, "customer.manage_credit");
  const { q, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const where = {
    deletedAt: null,
    ...branchScope(user, "branchId"),
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

  const [rows, total, cities, branches] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        branch: { select: { code: true } },
        _count: { select: { shipments: true, addresses: true } },
      },
    }),
    prisma.customer.count({ where }),
    prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true },
    }),
    prisma.branch.findMany({
      where: { isActive: true, deletedAt: null, ...branchScope(user, "id") },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  const fields = buildCustomerFields(
    cities.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` })),
    branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })),
    canSetCredit,
  );

  return (
    <>
      <PageHeader
        eyebrow="Parties"
        title="Customers"
        description="Accounts you book against. GSTIN drives the reverse-charge decision on the consignment note, so it is worth capturing at account level rather than per booking."
        actions={
          <div className="flex items-center gap-2">
            <SearchInput placeholder="Search name, code, phone, GSTIN" />
            {writable && (
              <MasterFormDialog
                title="New customer"
                description="Saved addresses make booking a two-field job instead of a twelve-field one."
                fields={fields}
                action={createCustomer}
                submitLabel="Create"
                trigger={{ label: "New customer", icon: "plus" }}
              />
            )}
          </div>
        }
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title={q ? `Nothing matches “${q}”` : "No customers yet"}
            description={
              q
                ? "Try the account code or a phone number."
                : "Add the accounts you book for most often first."
            }
          />
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>GSTIN</TableHead>
                <TableHead>Terms</TableHead>
                <TableHead className="text-right">Shipments</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className={row.isActive ? "" : "opacity-55"}>
                  <TableCell className="font-mono text-xs font-medium">
                    {row.code}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/customers/${row.id}`}
                      className="font-medium hover:underline"
                    >
                      {row.name}
                    </Link>
                    {row.isBlocked && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 rounded-sm bg-bad-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-bad"
                        title={row.blockReason ?? "Blocked"}
                      >
                        <ShieldAlert className="size-3" />
                        Blocked
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${TYPE_TONE[row.type]}`}
                    >
                      {row.type.replace("_", " ")}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.phone}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.gstin ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.paymentTerm === "CREDIT" ? (
                      <span>
                        Credit
                        {row.creditDays ? ` · ${row.creditDays}d` : ""}
                        {row.creditLimit
                          ? ` · ₹${Number(row.creditLimit).toLocaleString("en-IN")}`
                          : ""}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {row.paymentTerm === "PREPAID" ? "Prepaid" : "Cash"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {row._count.shipments}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.branch?.code ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/customers/${row.id}`}
                      aria-label={`Open ${row.name}`}
                      className="text-muted-foreground hover:text-foreground"
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
        baseParams={{ q }}
        pathname="/customers"
      />

      {!canSetCredit && (
        <p className="mt-4 max-w-prose text-sm text-muted-foreground">
          Credit terms are read-only for your role. Accounts sets limits and
          payment days — a booking clerk creating an account cannot also grant
          it credit.
        </p>
      )}
    </>
  );
}
