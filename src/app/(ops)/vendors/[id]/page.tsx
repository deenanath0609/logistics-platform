import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { anyBranchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { EntityFormDialog, type EntityField } from "@/components/finance/entity-form";
import { ReasonAction } from "@/components/finance/reason-action";
import {
  BackLink,
  StatTiles,
  StatusPill,
  MoneyCell,
} from "@/components/finance/finance-shell";
import { formatDate, formatMoney, isoDate } from "@/components/finance/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VENDOR_FIELDS } from "../page";
import {
  updateVendorAction,
  saveBankAccountAction,
  createRateContractAction,
  saveRateLineAction,
  createVendorBillAction,
  approveVendorBillAction,
  disputeVendorBillAction,
  recordVendorPaymentAction,
} from "../actions";

export const metadata: Metadata = { title: "Vendor" };
export const dynamic = "force-dynamic";

const BANK_FIELDS: EntityField[] = [
  { type: "text", name: "accountName", label: "Account name", required: true },
  { type: "text", name: "accountNumber", label: "Account number", required: true, half: true, mono: true },
  { type: "text", name: "ifsc", label: "IFSC", required: true, half: true, mono: true, placeholder: "HDFC0001234" },
  { type: "text", name: "bankName", label: "Bank", half: true },
  {
    type: "switch",
    name: "isPrimary",
    label: "Primary account",
    help: "Payments default here.",
    defaultChecked: true,
  },
];

export default async function VendorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("vendor.read");
  const { id } = await params;

  const canEdit = can(user, "vendor.update");
  const canBill = can(user, "expense.record");
  const canApprove = can(user, "settlement.approve");
  const canDispute = can(user, "expense.approve");
  const canPay = can(user, "payment.record");

  const vendor = await prisma.vendor.findUnique({
    where: { id },
    include: {
      bankAccounts: { orderBy: { isPrimary: "desc" } },
      rateContracts: {
        orderBy: { effectiveFrom: "desc" },
        include: { lines: true },
      },
      bills: {
        orderBy: { billDate: "desc" },
        take: 40,
        include: { lines: { select: { description: true, tripId: true } } },
      },
      payments: { orderBy: { paidOn: "desc" }, take: 20 },
      _count: { select: { trips: true, vehicles: true, drivers: true } },
    },
  });

  if (!vendor || vendor.deletedAt || vendor.orgId !== user.orgId) notFound();

  const [branches, vehicleTypes, trips] = await Promise.all([
    prisma.branch.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.vehicleType.findMany({
      where: { isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.trip.findMany({
      where: { vendorId: vendor.id, ...anyBranchScope(user, ["originBranchId", "destinationBranchId"]) },
      orderBy: { plannedDepartureAt: "desc" },
      take: 60,
      select: {
        id: true,
        number: true,
        originBranch: { select: { code: true } },
        destinationBranch: { select: { code: true } },
        plannedDepartureAt: true,
      },
    }),
  ]);

  const branchOptions = branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }));
  const vehicleOptions = vehicleTypes.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` }));
  const branchCode = new Map(branches.map((b) => [b.id, b.code]));
  const vehicleCode = new Map(vehicleTypes.map((t) => [t.id, t.code]));

  const payable = vendor.bills.reduce(
    (sum, bill) => sum.plus(new Decimal(bill.amountDue.toString())),
    new Decimal(0),
  );
  const flagged = vendor.bills.filter(
    (bill) => bill.varianceAmount !== null && Number(bill.varianceAmount) !== 0,
  );

  const billFields: EntityField[] = [
    {
      type: "select",
      name: "tripId",
      label: "Trip",
      options: trips.map((trip) => ({
        value: trip.id,
        label: `${trip.number} · ${trip.originBranch.code}→${trip.destinationBranch.code}`,
      })),
      placeholder: "Not against a trip",
      help: "Picking a trip is what lets the bill be checked against the contract.",
    },
    {
      type: "date",
      name: "billDate",
      label: "Bill date",
      required: true,
      half: true,
      defaultValue: isoDate(new Date()),
    },
    { type: "number", name: "amount", label: "Amount (₹)", required: true, half: true, step: "0.01" },
    { type: "text", name: "description", label: "What is being billed", required: true },
    { type: "number", name: "taxPercent", label: "Tax %", half: true, step: "0.001" },
    {
      type: "number",
      name: "deductions",
      label: "Deductions (₹)",
      half: true,
      step: "0.01",
      help: "Damage, shortage, fines withheld.",
    },
    {
      type: "number",
      name: "advanceAdjusted",
      label: "Advance adjusted (₹)",
      half: true,
      step: "0.01",
    },
    { type: "textarea", name: "notes", label: "Notes" },
  ];

  return (
    <>
      <BackLink href="/vendors" label="All vendors" />

      <PageHeader
        eyebrow={`${vendor.kind.replace(/_/g, " ").toLowerCase()} · ${vendor.code}`}
        title={vendor.name}
        description={
          vendor.gstin
            ? `GSTIN ${vendor.gstin}${vendor.pan ? ` · PAN ${vendor.pan}` : ""}`
            : "No GSTIN on file — capture it before the first bill."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <EntityFormDialog
                title={`Edit ${vendor.code}`}
                fields={VENDOR_FIELDS}
                record={vendor as unknown as Record<string, unknown>}
                action={updateVendorAction}
                trigger={{ label: "Edit", icon: "pencil", variant: "outline" }}
              />
            )}
            {canBill && (
              <EntityFormDialog
                title="New vendor bill"
                description="The bill is reconciled against the rate contract as it is raised, and the variance is stored on it — the contract can be revised later, and the figure that matters is the one at billing time."
                fields={billFields}
                hidden={{ vendorId: vendor.id }}
                action={createVendorBillAction}
                submitLabel="Raise bill"
                trigger={{ label: "New bill", icon: "plus" }}
              />
            )}
          </div>
        }
      />

      {vendor.isBlocked && (
        <p className="mb-6 rounded-lg border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad">
          This vendor is blocked and cannot be billed.
        </p>
      )}

      <StatTiles
        items={[
          { label: "Payable", value: formatMoney(payable.toFixed(2)), tone: payable.greaterThan(0) ? "warn" : "ok" },
          {
            label: "Bills with variance",
            value: String(flagged.length),
            tone: flagged.length > 0 ? "bad" : "ok",
          },
          { label: "Trips run", value: String(vendor._count.trips) },
          { label: "Vehicles attached", value: String(vendor._count.vehicles) },
          {
            label: "Payment terms",
            value: vendor.paymentTermDays ? `${vendor.paymentTermDays} days` : "—",
          },
        ]}
      />

      {/* ── Rate contracts ─────────────────────────────────── */}
      <section className="pb-8">
        <div className="flex items-center justify-between pb-3">
          <h2 className="text-sm font-semibold">Rate contracts</h2>
          {canEdit && (
            <EntityFormDialog
              title="New rate contract"
              description="Lane-wise and vehicle-type-wise payable rates, mirroring the customer rate card so margin per trip is computable."
              fields={[
                { type: "text", name: "code", label: "Code", required: true, half: true, mono: true },
                {
                  type: "date",
                  name: "effectiveFrom",
                  label: "Effective from",
                  required: true,
                  half: true,
                  defaultValue: isoDate(new Date()),
                },
                { type: "text", name: "name", label: "Name", required: true },
                { type: "date", name: "effectiveTo", label: "Effective to", half: true },
              ]}
              hidden={{ vendorId: vendor.id }}
              action={createRateContractAction}
              submitLabel="Create"
              trigger={{ label: "New contract", icon: "plus", size: "sm", variant: "outline" }}
            />
          )}
        </div>

        {vendor.rateContracts.length === 0 ? (
          <TableFrame>
            <EmptyState
              title="No rate contract"
              description="Without one, a bill from this vendor cannot be checked against anything — it will be flagged as uncovered."
            />
          </TableFrame>
        ) : (
          <div className="flex flex-col gap-4">
            {vendor.rateContracts.map((contract) => (
              <div key={contract.id} className="rounded-lg border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                  <div>
                    <p className="font-medium">
                      {contract.name}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {contract.code}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(contract.effectiveFrom)} –{" "}
                      {contract.effectiveTo ? formatDate(contract.effectiveTo) : "open"}
                    </p>
                  </div>
                  {canEdit && (
                    <EntityFormDialog
                      title="Add a lane rate"
                      description="Leave a dimension blank for 'any'. The most specific line wins when a bill is checked."
                      fields={[
                        {
                          type: "select",
                          name: "originBranchId",
                          label: "Origin branch",
                          half: true,
                          options: branchOptions,
                        },
                        {
                          type: "select",
                          name: "destinationBranchId",
                          label: "Destination branch",
                          half: true,
                          options: branchOptions,
                        },
                        {
                          type: "select",
                          name: "vehicleTypeId",
                          label: "Vehicle type",
                          half: true,
                          options: vehicleOptions,
                        },
                        {
                          type: "select",
                          name: "basis",
                          label: "Basis",
                          required: true,
                          half: true,
                          options: [
                            { value: "PER_TRIP", label: "Per trip" },
                            { value: "PER_KM", label: "Per km" },
                            { value: "PER_KG", label: "Per kg" },
                            { value: "PER_VEHICLE", label: "Per vehicle" },
                            { value: "FLAT", label: "Flat" },
                          ],
                          defaultValue: "PER_TRIP",
                        },
                        { type: "number", name: "rate", label: "Rate (₹)", required: true, half: true, step: "0.0001" },
                        { type: "number", name: "minimumAmount", label: "Minimum (₹)", half: true, step: "0.01" },
                      ]}
                      hidden={{ contractId: contract.id, vendorId: vendor.id }}
                      action={saveRateLineAction}
                      submitLabel="Add lane"
                      trigger={{ label: "Add lane", icon: "plus", size: "xs", variant: "ghost" }}
                    />
                  )}
                </div>

                {contract.lines.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-muted-foreground">
                    No lanes on this contract yet.
                  </p>
                ) : (
                  <Table className="min-w-[600px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Lane</TableHead>
                        <TableHead>Vehicle</TableHead>
                        <TableHead>Basis</TableHead>
                        <TableHead className="text-right">Rate</TableHead>
                        <TableHead className="text-right">Minimum</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contract.lines.map((line) => (
                        <TableRow key={line.id}>
                          <TableCell className="font-mono text-xs">
                            {(line.originBranchId && branchCode.get(line.originBranchId)) ?? "Any"} →{" "}
                            {(line.destinationBranchId &&
                              branchCode.get(line.destinationBranchId)) ?? "Any"}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {(line.vehicleTypeId && vehicleCode.get(line.vehicleTypeId)) ?? "Any"}
                          </TableCell>
                          <TableCell className="text-xs">
                            {line.basis.replace(/_/g, " ")}
                          </TableCell>
                          <TableCell className="text-right">
                            <MoneyCell value={line.rate.toString()} />
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {line.minimumAmount
                              ? formatMoney(line.minimumAmount.toString())
                              : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Bills ──────────────────────────────────────────── */}
      <section className="pb-8">
        <h2 className="pb-3 text-sm font-semibold">Bills</h2>
        <TableFrame>
          {vendor.bills.length === 0 ? (
            <EmptyState title="No bills yet" />
          ) : (
            <Table className="min-w-[1000px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>For</TableHead>
                  <TableHead className="text-right">Subtotal</TableHead>
                  <TableHead className="text-right">TDS</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Due</TableHead>
                  <TableHead>Variance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vendor.bills.map((bill) => {
                  const variance = bill.varianceAmount
                    ? new Decimal(bill.varianceAmount.toString())
                    : null;
                  const hasVariance = variance !== null && !variance.isZero();

                  return (
                    <TableRow key={bill.id}>
                      <TableCell className="font-mono text-xs font-medium">
                        {bill.number}
                      </TableCell>
                      <TableCell className="text-xs">{formatDate(bill.billDate)}</TableCell>
                      <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground">
                        {bill.lines[0]?.description ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <MoneyCell value={bill.subtotal.toString()} />
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <MoneyCell
                          value={bill.tdsAmount.toString()}
                          tone="text-muted-foreground"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <MoneyCell value={bill.total.toString()} strong />
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <MoneyCell
                          value={bill.amountDue.toString()}
                          tone={
                            Number(bill.amountDue) > 0 ? "text-warn" : "text-muted-foreground"
                          }
                        />
                      </TableCell>
                      <TableCell className="text-xs">
                        {hasVariance ? (
                          <span
                            className="inline-flex items-center gap-1 text-bad"
                            title={bill.varianceNote ?? undefined}
                          >
                            <TriangleAlert className="size-3" />
                            {formatMoney(variance.toFixed(2))}
                          </span>
                        ) : bill.varianceNote ? (
                          <span className="text-warn" title={bill.varianceNote}>
                            Unchecked
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Matches</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusPill status={bill.status} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {canApprove &&
                            (bill.status === "SUBMITTED" || bill.status === "DISPUTED") && (
                              <ReasonAction
                                id={bill.id}
                                title={`Approve ${bill.number} for payment?`}
                                description={
                                  hasVariance
                                    ? `This bill differs from the contract by ${formatMoney(variance.toFixed(2))}. ${bill.varianceNote ?? ""} Approving accepts that variance on your name.`
                                    : "Approving releases the bill into the payment run."
                                }
                                reasonLabel="What you checked"
                                reasonPlaceholder="Trip sheet and POD tallied; the extra ₹1,200 is the detention agreed on the phone."
                                confirmLabel="Approve"
                                icon="approve"
                                size="xs"
                                variant="outline"
                                action={approveVendorBillAction}
                              />
                            )}
                          {canDispute && bill.status === "SUBMITTED" && (
                            <ReasonAction
                              id={bill.id}
                              title={`Dispute ${bill.number}?`}
                              description="Parks the bill out of the payment run until it is settled."
                              reasonLabel="What is disputed"
                              confirmLabel="Dispute"
                              icon="cancel"
                              size="xs"
                              variant="ghost"
                              action={disputeVendorBillAction}
                            />
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </TableFrame>
      </section>

      {/* ── Payments & bank ────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <div className="flex items-center justify-between pb-3">
            <h2 className="text-sm font-semibold">Payments</h2>
            {canPay && (
              <EntityFormDialog
                title="Record a vendor payment"
                description="Applied to the oldest approved bills first."
                fields={[
                  { type: "number", name: "amount", label: "Amount (₹)", required: true, half: true, step: "0.01" },
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
                      { value: "ADJUSTMENT", label: "Adjustment" },
                    ],
                    defaultValue: "NEFT",
                  },
                  {
                    type: "date",
                    name: "paidOn",
                    label: "Paid on",
                    required: true,
                    half: true,
                    defaultValue: isoDate(new Date()),
                  },
                  { type: "text", name: "reference", label: "Reference", half: true, mono: true },
                  { type: "textarea", name: "notes", label: "Notes" },
                ]}
                hidden={{ vendorId: vendor.id }}
                action={recordVendorPaymentAction}
                submitLabel="Record"
                trigger={{ label: "Record payment", icon: "plus", size: "sm", variant: "outline" }}
              />
            )}
          </div>
          <TableFrame>
            {vendor.payments.length === 0 ? (
              <EmptyState title="No payments yet" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Paid</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vendor.payments.map((payment) => (
                    <TableRow key={payment.id}>
                      <TableCell className="font-mono text-xs">{payment.number}</TableCell>
                      <TableCell className="text-xs">{formatDate(payment.paidOn)}</TableCell>
                      <TableCell className="text-xs">{payment.mode}</TableCell>
                      <TableCell className="text-right">
                        <MoneyCell value={payment.amount.toString()} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableFrame>
        </section>

        <section>
          <div className="flex items-center justify-between pb-3">
            <h2 className="text-sm font-semibold">Bank accounts</h2>
            {/* Not `canEdit`: where a vendor is paid is a payout decision,
                not a vendor-record edit. The action refuses anything less
                than `settlement.approve`, and the button follows it. */}
            {canApprove && (
              <EntityFormDialog
                title="Add bank account"
                description="Where this vendor is paid. The change is audited against your name, with the account it replaces."
                fields={BANK_FIELDS}
                hidden={{ vendorId: vendor.id }}
                action={saveBankAccountAction}
                submitLabel="Save"
                trigger={{ label: "Add account", icon: "plus", size: "sm", variant: "outline" }}
              />
            )}
          </div>
          <TableFrame>
            {vendor.bankAccounts.length === 0 ? (
              <EmptyState
                title="No bank details"
                description="A vendor with no account on file cannot be paid by transfer."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account name</TableHead>
                    <TableHead>Number</TableHead>
                    <TableHead>IFSC</TableHead>
                    <TableHead>Primary</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vendor.bankAccounts.map((account) => (
                    <TableRow key={account.id}>
                      <TableCell className="text-sm">{account.accountName}</TableCell>
                      <TableCell className="font-mono text-xs">
                        ••••{account.accountNumber.slice(-4)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{account.ifsc}</TableCell>
                      <TableCell className="text-xs">
                        {account.isPrimary ? "Yes" : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableFrame>
        </section>
      </div>
    </>
  );
}
