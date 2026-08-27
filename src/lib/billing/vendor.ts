import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import type { PaymentMode, RateBasis } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { recordAudit } from "@/server/services/audit";
import { nextNumber } from "@/lib/numbering/number-series";
import { dec, money, type MoneyIn } from "./ageing";
import { totalVendorBill } from "./totals";

/**
 * Vendor payable.
 *
 * The mirror of the customer side: what we owe a transporter for running
 * the trip. Reconciliation against the rate contract flags variances
 * before payment, which is the only moment anybody has both the contract
 * and the bill in front of them.
 */

export type VendorBillLineInput = {
  tripId?: string | null;
  description: string;
  amount: MoneyIn;
  taxPercent?: MoneyIn;
};

export type ContractExpectation = {
  tripId: string;
  tripNumber: string;
  expected: Decimal | null;
  basis: RateBasis | null;
  contractLineId: string | null;
  note: string;
};

/**
 * What the contract says this trip should cost.
 *
 * Null when no contract line covers the lane — which is itself worth
 * saying out loud on the bill rather than treating an uncovered trip as
 * automatically correct.
 */
export async function expectedTripRate(
  options: { vendorId: string; tripId: string; on: Date },
): Promise<ContractExpectation> {
  const trip = await prisma.trip.findUnique({
    where: { id: options.tripId },
    select: {
      id: true,
      number: true,
      originBranchId: true,
      destinationBranchId: true,
      distanceKm: true,
      vehicle: { select: { vehicleTypeId: true } },
    },
  });

  if (!trip) {
    return {
      tripId: options.tripId,
      tripNumber: "—",
      expected: null,
      basis: null,
      contractLineId: null,
      note: "That trip no longer exists.",
    };
  }

  const contracts = await prisma.vendorRateContract.findMany({
    where: {
      vendorId: options.vendorId,
      isActive: true,
      effectiveFrom: { lte: options.on },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: options.on } }],
    },
    include: { lines: true },
  });

  const candidates = contracts
    .flatMap((contract) => contract.lines)
    .filter((line) => {
      if (line.originBranchId && line.originBranchId !== trip.originBranchId) return false;
      if (line.destinationBranchId && line.destinationBranchId !== trip.destinationBranchId) {
        return false;
      }
      if (line.vehicleTypeId && line.vehicleTypeId !== trip.vehicle.vehicleTypeId) return false;
      return true;
    })
    // Most specific first — a lane-and-vehicle line beats a lane line
    // beats a blanket rate, the same discipline as the customer side.
    .sort((a, b) => specificity(b) - specificity(a));

  const line = candidates[0];

  if (!line) {
    return {
      tripId: trip.id,
      tripNumber: trip.number,
      expected: null,
      basis: null,
      contractLineId: null,
      note: "No contract line covers this lane — the bill cannot be checked against anything.",
    };
  }

  const rate = dec(line.rate.toString());
  let expected: Decimal;

  switch (line.basis) {
    case "PER_KM": {
      const km = dec(trip.distanceKm?.toString());
      expected = rate.times(km);
      break;
    }
    case "PER_TRIP":
    case "PER_VEHICLE":
    case "FLAT":
    default:
      expected = rate;
      break;
  }

  const minimum = dec(line.minimumAmount);
  if (minimum.greaterThan(expected)) expected = minimum;

  return {
    tripId: trip.id,
    tripNumber: trip.number,
    expected: money(expected),
    basis: line.basis,
    contractLineId: line.id,
    note: `Contract rate ₹${rate.toFixed(4)} on ${line.basis}.`,
  };
}

function specificity(line: {
  originBranchId: string | null;
  destinationBranchId: string | null;
  vehicleTypeId: string | null;
}): number {
  return (
    (line.originBranchId ? 1 : 0) +
    (line.destinationBranchId ? 1 : 0) +
    (line.vehicleTypeId ? 1 : 0)
  );
}

export type VendorBillResult =
  | { ok: true; billId: string; number: string; variance: Decimal | null }
  | { ok: false; error: string };

export type CreateVendorBillInput = {
  vendorId: string;
  billDate: Date;
  dueDate?: Date | null;
  lines: VendorBillLineInput[];
  tdsAmount?: MoneyIn;
  deductions?: MoneyIn;
  deductionNote?: string | null;
  advanceAdjusted?: MoneyIn;
  notes?: string | null;
};

/**
 * Raises a vendor bill and checks it against the contract.
 *
 * The variance is stored on the bill rather than recomputed on the payment
 * screen: the contract can be revised between billing and payment, and the
 * figure that matters is the one at the time the bill was raised.
 */
export async function createVendorBill(
  input: CreateVendorBillInput,
  actor: SessionUser,
): Promise<VendorBillResult> {
  if (!can(actor, "expense.record")) {
    return { ok: false, error: "You do not have permission to raise vendor bills." };
  }
  if (input.lines.length === 0) {
    return { ok: false, error: "A vendor bill needs at least one line." };
  }

  const vendor = await prisma.vendor.findUnique({
    where: { id: input.vendorId },
    select: {
      id: true,
      code: true,
      name: true,
      isActive: true,
      isBlocked: true,
      deletedAt: true,
      tdsPercent: true,
      paymentTermDays: true,
    },
  });

  if (!vendor || vendor.deletedAt || !vendor.isActive) {
    return { ok: false, error: "That vendor is not available." };
  }
  if (vendor.isBlocked) {
    return { ok: false, error: `${vendor.name} is blocked. Clear the block before billing.` };
  }

  // TDS 194C comes off what we transfer, not off what was earned — see
  // `totals.ts`, where the arithmetic is pure and tested.
  const { subtotal, taxAmount, tdsAmount, deductions, advanceAdjusted, total } =
    totalVendorBill({
      lines: input.lines,
      tdsPercent: vendor.tdsPercent?.toString(),
      tdsAmount: input.tdsAmount,
      deductions: input.deductions,
      advanceAdjusted: input.advanceAdjusted,
    });

  // ── Contract reconciliation ───────────────────────────────
  const tripLines = input.lines.filter((line) => line.tripId);
  const expectations: ContractExpectation[] = [];

  for (const line of tripLines) {
    expectations.push(
      await expectedTripRate({
        vendorId: vendor.id,
        tripId: line.tripId!,
        on: input.billDate,
      }),
    );
  }

  const checkable = expectations.filter((e) => e.expected !== null);
  let variance: Decimal | null = null;
  let varianceNote: string | null = null;

  if (checkable.length > 0) {
    const expectedTotal = checkable.reduce(
      (sum, e) => sum.plus(e.expected!),
      new Decimal(0),
    );
    const billedOnTrips = money(
      tripLines
        .filter((line) => checkable.some((e) => e.tripId === line.tripId))
        .reduce((sum, line) => sum.plus(dec(line.amount)), new Decimal(0)),
    );

    variance = money(billedOnTrips.minus(expectedTotal));
    if (!variance.isZero()) {
      varianceNote =
        `Billed ₹${billedOnTrips.toFixed(2)} against a contract expectation of ` +
        `₹${money(expectedTotal).toFixed(2)} across ${checkable.length} trip(s).`;
    }
  }

  const uncovered = expectations.filter((e) => e.expected === null);
  if (uncovered.length > 0) {
    varianceNote =
      `${varianceNote ? `${varianceNote} ` : ""}` +
      `${uncovered.length} trip(s) have no contract line to check against.`;
  }

  const dueDate =
    input.dueDate ??
    (vendor.paymentTermDays
      ? new Date(input.billDate.getTime() + vendor.paymentTermDays * 86_400_000)
      : null);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(
        { document: "VENDOR_BILL", at: input.billDate },
        tx as unknown as Parameters<typeof nextNumber>[1],
      );

      return tx.vendorBill.create({
        data: {
          orgId: actor.orgId,
          number,
          vendorId: vendor.id,
          status: "SUBMITTED",
          billDate: input.billDate,
          dueDate: dueDate ?? undefined,
          subtotal: subtotal.toFixed(2),
          taxAmount: taxAmount.toFixed(2),
          tdsAmount: tdsAmount.toFixed(2),
          deductions: deductions.toFixed(2),
          advanceAdjusted: advanceAdjusted.toFixed(2),
          total: total.toFixed(2),
          amountPaid: "0",
          amountDue: total.toFixed(2),
          varianceAmount: variance?.toFixed(2) ?? null,
          varianceNote,
          notes: input.notes ?? undefined,
          createdById: actor.id,
          lines: {
            createMany: {
              data: input.lines.map((line, index) => ({
                tripId: line.tripId ?? null,
                description: line.description,
                amount: money(dec(line.amount)).toFixed(2),
                taxPercent: line.taxPercent ? dec(line.taxPercent).toFixed(3) : null,
                taxAmount: money(
                  dec(line.amount).times(dec(line.taxPercent)).dividedBy(100),
                ).toFixed(2),
                sortOrder: index * 10,
              })),
            },
          },
        },
        select: { id: true, number: true },
      });
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "VendorBill",
      entityId: created.id,
      entityRef: created.number,
      after: {
        vendor: vendor.code,
        subtotal: subtotal.toFixed(2),
        tdsAmount: tdsAmount.toFixed(2),
        deductions: deductions.toFixed(2),
        total: total.toFixed(2),
        varianceAmount: variance?.toFixed(2) ?? null,
        varianceNote,
      },
    });

    return { ok: true, billId: created.id, number: created.number, variance };
  } catch (error) {
    console.error("[billing/vendor] createVendorBill", error);
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No active number series")) {
      return {
        ok: false,
        error: "No vendor-bill number series is configured. Set one up under Masters.",
      };
    }
    return { ok: false, error: "Could not raise that bill. Nothing was saved." };
  }
}

/**
 * Approves a bill for payment.
 *
 * A bill carrying an unexplained variance cannot be approved without the
 * approver saying something about it — that note is the whole point of
 * flagging the variance in the first place.
 */
export async function approveVendorBill(
  input: { billId: string; reason: string; acceptVariance?: boolean },
  actor: SessionUser,
): Promise<{ ok: true; number: string } | { ok: false; error: string }> {
  if (!can(actor, "settlement.approve")) {
    return { ok: false, error: "You do not have permission to approve vendor bills." };
  }
  if (!input.reason?.trim()) {
    return { ok: false, error: "Give a reason — approving a bill for payment is audited." };
  }

  const bill = await prisma.vendorBill.findUnique({
    where: { id: input.billId },
    select: {
      id: true,
      number: true,
      status: true,
      total: true,
      varianceAmount: true,
      varianceNote: true,
    },
  });

  if (!bill) return { ok: false, error: "That bill no longer exists." };
  if (bill.status === "APPROVED" || bill.status === "PAID") {
    return { ok: false, error: "That bill is already approved." };
  }
  if (bill.status === "CANCELLED") {
    return { ok: false, error: "That bill is cancelled." };
  }

  const variance = bill.varianceAmount ? dec(bill.varianceAmount.toString()) : null;
  if (variance && !variance.isZero() && !input.acceptVariance) {
    return {
      ok: false,
      error:
        `This bill differs from the contract by ₹${variance.toFixed(2)}. ` +
        `Confirm you are accepting the variance before approving.`,
    };
  }

  await prisma.vendorBill.update({
    where: { id: bill.id },
    data: { status: "APPROVED", approvedAt: new Date(), approvedById: actor.id },
  });

  await recordAudit({
    user: actor,
    action: "APPROVE",
    entity: "VendorBill",
    entityId: bill.id,
    entityRef: bill.number,
    before: { status: bill.status },
    after: {
      status: "APPROVED",
      total: bill.total.toString(),
      varianceAccepted: variance && !variance.isZero() ? variance.toFixed(2) : null,
    },
    reason: input.reason.trim(),
  });

  return { ok: true, number: bill.number };
}

/** Disputes a bill, which parks it out of the payment run. */
export async function disputeVendorBill(
  input: { billId: string; reason: string },
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "expense.approve")) {
    return { ok: false, error: "You do not have permission to dispute vendor bills." };
  }
  if (!input.reason?.trim()) {
    return { ok: false, error: "Say what is disputed." };
  }

  const bill = await prisma.vendorBill.findUnique({
    where: { id: input.billId },
    select: { id: true, number: true, status: true },
  });
  if (!bill) return { ok: false, error: "That bill no longer exists." };

  await prisma.vendorBill.update({
    where: { id: bill.id },
    data: { status: "DISPUTED", varianceNote: input.reason.trim() },
  });

  await recordAudit({
    user: actor,
    action: "STATUS_CHANGE",
    entity: "VendorBill",
    entityId: bill.id,
    entityRef: bill.number,
    before: { status: bill.status },
    after: { status: "DISPUTED" },
    reason: input.reason.trim(),
  });

  return { ok: true };
}

export type VendorPaymentInput = {
  vendorId: string;
  amount: MoneyIn;
  mode: PaymentMode;
  reference?: string | null;
  paidOn: Date;
  notes?: string | null;
  /** Bills this payment settles, oldest first when omitted. */
  billIds?: string[];
};

/** Pays a vendor and settles the approved bills it covers. */
export async function recordVendorPayment(
  input: VendorPaymentInput,
  actor: SessionUser,
): Promise<{ ok: true; paymentId: string; number: string } | { ok: false; error: string }> {
  if (!can(actor, "payment.record")) {
    return { ok: false, error: "You do not have permission to record payments." };
  }

  const amount = money(dec(input.amount));
  if (amount.lessThanOrEqualTo(0)) {
    return { ok: false, error: "Enter the amount paid." };
  }

  const bills = await prisma.vendorBill.findMany({
    where: {
      vendorId: input.vendorId,
      status: { in: ["APPROVED", "PARTIALLY_PAID"] },
      amountDue: { gt: 0 },
      ...(input.billIds && input.billIds.length > 0 ? { id: { in: input.billIds } } : {}),
    },
    orderBy: { billDate: "asc" },
    select: { id: true, number: true, amountPaid: true, amountDue: true },
  });

  try {
    const created = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(
        { document: "VENDOR_PAYMENT", at: input.paidOn },
        tx as unknown as Parameters<typeof nextNumber>[1],
      );

      const payment = await tx.vendorPayment.create({
        data: {
          orgId: actor.orgId,
          number,
          vendorId: input.vendorId,
          amount: amount.toFixed(2),
          mode: input.mode,
          reference: input.reference ?? undefined,
          paidOn: input.paidOn,
          notes: input.notes ?? undefined,
          createdById: actor.id,
        },
        select: { id: true, number: true },
      });

      // Oldest bill first. `VendorBill` has no allocation table, so the
      // settlement is written onto the bill itself.
      let remaining = amount;
      for (const bill of bills) {
        if (remaining.lessThanOrEqualTo(0)) break;
        const due = dec(bill.amountDue.toString());
        const applied = remaining.greaterThanOrEqualTo(due) ? due : remaining;
        const paid = money(dec(bill.amountPaid.toString()).plus(applied));
        const stillDue = money(due.minus(applied));

        await tx.vendorBill.update({
          where: { id: bill.id },
          data: {
            amountPaid: paid.toFixed(2),
            amountDue: stillDue.toFixed(2),
            status: stillDue.lessThanOrEqualTo(0) ? "PAID" : "PARTIALLY_PAID",
          },
        });

        remaining = money(remaining.minus(applied));
      }

      return payment;
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "VendorPayment",
      entityId: created.id,
      entityRef: created.number,
      after: {
        amount: amount.toFixed(2),
        mode: input.mode,
        reference: input.reference,
        bills: bills.map((b) => b.number),
      },
    });

    return { ok: true, paymentId: created.id, number: created.number };
  } catch (error) {
    if (error instanceof Error && error.message.includes("No active number series")) {
      return {
        ok: false,
        error:
          "No vendor payment number series is configured. Set one up under Masters → Number series.",
      };
    }
    console.error("[billing/vendor] recordVendorPayment", error);
    return { ok: false, error: "Could not record that payment. Nothing was saved." };
  }
}
