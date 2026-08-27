import type { Metadata } from "next";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { anyBranchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { EntityFormDialog } from "@/components/finance/entity-form";
import { ReasonAction } from "@/components/finance/reason-action";
import { StatTiles, StatusPill, MoneyCell } from "@/components/finance/finance-shell";
import { formatDate, formatMoney, formatMoneyShort } from "@/components/finance/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  prepareSettlementAction,
  approveSettlementAction,
  markSettlementPaidAction,
  cancelSettlementAction,
} from "./actions";

export const metadata: Metadata = { title: "Driver settlements" };
export const dynamic = "force-dynamic";

export default async function SettlementsPage() {
  const user = await requirePermission("settlement.read");
  const canPrepare = can(user, "expense.record");
  const canApprove = can(user, "settlement.approve");
  const canPay = can(user, "payment.record");

  const settlements = await prisma.driverSettlement.findMany({
    where: { orgId: user.orgId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { driver: { select: { code: true, name: true } } },
  });

  const settledTripIds = new Set(
    settlements
      .filter((settlement) => settlement.status !== "CANCELLED")
      .map((settlement) => settlement.tripId)
      .filter(Boolean) as string[],
  );

  // Closed trips with a driver and no live settlement — the queue.
  const closedTrips = await prisma.trip.findMany({
    where: {
      status: "COMPLETED",
      driverId: { not: null },
      ...anyBranchScope(user, ["originBranchId", "destinationBranchId"]),
    },
    orderBy: { actualArrivalAt: "desc" },
    take: 60,
    select: {
      id: true,
      number: true,
      actualArrivalAt: true,
      plannedArrivalAt: true,
      freightPayable: true,
      advancePaid: true,
      driver: { select: { name: true } },
      originBranch: { select: { code: true } },
      destinationBranch: { select: { code: true } },
      expenses: { select: { amount: true, isApproved: true } },
    },
  });

  const pendingTrips = closedTrips.filter((trip) => !settledTripIds.has(trip.id));

  const awaitingApproval = settlements.filter((s) => s.status === "DRAFT");
  const approvedUnpaid = settlements.filter((s) => s.status === "APPROVED");

  const payableTotal = approvedUnpaid.reduce(
    (sum, s) => sum.plus(new Decimal(s.netPayable.toString())),
    new Decimal(0),
  );

  const unapprovedExpenses = closedTrips.reduce(
    (sum, trip) =>
      sum.plus(
        trip.expenses
          .filter((expense) => !expense.isApproved)
          .reduce((inner, expense) => inner.plus(new Decimal(expense.amount.toString())), new Decimal(0)),
      ),
    new Decimal(0),
  );

  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Driver settlements"
        description="Trip earning less advances, less approved expenses, less deductions. Only approved expenses count — paying an unapproved claim and approving it afterwards is how a settlement stops reconciling."
      />

      <StatTiles
        items={[
          { label: "Trips awaiting settlement", value: String(pendingTrips.length) },
          {
            label: "Awaiting approval",
            value: String(awaitingApproval.length),
            tone: awaitingApproval.length > 0 ? "warn" : "default",
          },
          {
            label: "Approved, unpaid",
            value: formatMoneyShort(payableTotal.toFixed(2)),
            tone: payableTotal.greaterThan(0) ? "info" : "default",
          },
          {
            label: "Unapproved expenses",
            value: formatMoneyShort(unapprovedExpenses.toFixed(2)),
            tone: unapprovedExpenses.greaterThan(0) ? "warn" : "ok",
            hint: "Not included in any settlement",
          },
        ]}
      />

      {/* ── Queue ──────────────────────────────────────────── */}
      <section className="pb-8">
        <h2 className="pb-3 text-sm font-semibold">Trips awaiting settlement</h2>
        <TableFrame>
          {pendingTrips.length === 0 ? (
            <EmptyState
              title="Nothing waiting"
              description="Every closed trip with a driver has a settlement against it."
            />
          ) : (
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Trip</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Lane</TableHead>
                  <TableHead>Arrived</TableHead>
                  <TableHead className="text-right">Earning</TableHead>
                  <TableHead className="text-right">Advance</TableHead>
                  <TableHead className="text-right">Approved exp.</TableHead>
                  {canPrepare && <TableHead className="text-right">Action</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingTrips.map((trip) => {
                  const approvedExpenses = trip.expenses
                    .filter((expense) => expense.isApproved)
                    .reduce(
                      (sum, expense) => sum.plus(new Decimal(expense.amount.toString())),
                      new Decimal(0),
                    );

                  return (
                    <TableRow key={trip.id}>
                      <TableCell className="font-mono text-xs font-medium">
                        {trip.number}
                      </TableCell>
                      <TableCell className="font-medium">
                        {trip.driver?.name ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {trip.originBranch.code} → {trip.destinationBranch.code}
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatDate(trip.actualArrivalAt ?? trip.plannedArrivalAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <MoneyCell value={trip.freightPayable?.toString() ?? 0} />
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <MoneyCell
                          value={trip.advancePaid?.toString() ?? 0}
                          tone="text-muted-foreground"
                        />
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <MoneyCell
                          value={approvedExpenses.toFixed(2)}
                          tone="text-muted-foreground"
                        />
                      </TableCell>
                      {canPrepare && (
                        <TableCell className="text-right">
                          <EntityFormDialog
                            title={`Settle ${trip.number}`}
                            description="Earning less advances, plus approved expenses, less deductions. Unapproved expenses are deliberately left out."
                            fields={[
                              {
                                type: "number",
                                name: "tripEarning",
                                label: "Trip earning (₹)",
                                half: true,
                                step: "0.01",
                                defaultValue: trip.freightPayable?.toString() ?? "",
                              },
                              {
                                type: "number",
                                name: "deductions",
                                label: "Deductions (₹)",
                                half: true,
                                step: "0.01",
                                help: "Damage, shortage, fines.",
                              },
                              {
                                type: "textarea",
                                name: "deductionNote",
                                label: "What the deduction is for",
                                help: "Required if you deduct anything — the driver will ask.",
                              },
                            ]}
                            hidden={{ tripId: trip.id }}
                            action={prepareSettlementAction}
                            submitLabel="Prepare"
                            trigger={{ label: "Prepare", icon: "plus", size: "xs", variant: "outline" }}
                          />
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </TableFrame>
      </section>

      {/* ── Settlements ────────────────────────────────────── */}
      <section>
        <h2 className="pb-3 text-sm font-semibold">Settlements</h2>
        <TableFrame>
          {settlements.length === 0 ? (
            <EmptyState title="No settlements yet" />
          ) : (
            <Table className="min-w-[1040px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead className="text-right">Earning</TableHead>
                  <TableHead className="text-right">Advances</TableHead>
                  <TableHead className="text-right">Expenses</TableHead>
                  <TableHead className="text-right">Deductions</TableHead>
                  <TableHead className="text-right">Net payable</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {settlements.map((settlement) => (
                  <TableRow key={settlement.id}>
                    <TableCell className="font-mono text-xs font-medium">
                      {settlement.number}
                      <p className="font-sans text-[0.65rem] text-muted-foreground">
                        {formatDate(settlement.createdAt)}
                      </p>
                    </TableCell>
                    <TableCell className="font-medium">
                      {settlement.driver.name}
                      <span className="ml-1.5 font-mono text-[0.65rem] text-muted-foreground">
                        {settlement.driver.code}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      <MoneyCell value={settlement.tripEarning.toString()} />
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      <MoneyCell
                        value={settlement.advancesPaid.toString()}
                        tone="text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      <MoneyCell
                        value={settlement.expensesClaimed.toString()}
                        tone="text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      <MoneyCell
                        value={settlement.deductions.toString()}
                        tone={
                          Number(settlement.deductions) > 0
                            ? "text-warn"
                            : "text-muted-foreground"
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyCell value={settlement.netPayable.toString()} strong />
                    </TableCell>
                    <TableCell>
                      <StatusPill status={settlement.status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        {canApprove && settlement.status === "DRAFT" && (
                          <ReasonAction
                            id={settlement.id}
                            title={`Approve ${settlement.number}?`}
                            description={`Releases ${formatMoney(settlement.netPayable.toString())} for payout to ${settlement.driver.name}. A settlement cannot be approved by whoever prepared it.`}
                            reasonLabel="What you checked"
                            reasonPlaceholder="Expenses matched against bills; advance tallies with the cash book."
                            confirmLabel="Approve"
                            icon="approve"
                            size="xs"
                            variant="outline"
                            action={approveSettlementAction}
                          />
                        )}
                        {canPay && settlement.status === "APPROVED" && (
                          <ReasonAction
                            id={settlement.id}
                            title={`Mark ${settlement.number} paid?`}
                            reasonLabel="Payment reference"
                            reasonHelp="Recorded on the audit trail against your name."
                            confirmLabel="Mark paid"
                            icon="send"
                            size="xs"
                            variant="outline"
                            action={markSettlementPaidAction}
                          />
                        )}
                        {canApprove && settlement.status === "DRAFT" && (
                          <ReasonAction
                            id={settlement.id}
                            title={`Cancel ${settlement.number}?`}
                            confirmLabel="Cancel"
                            icon="cancel"
                            size="xs"
                            destructive
                            action={cancelSettlementAction}
                          />
                        )}
                      </div>
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
