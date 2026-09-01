import Decimal from "decimal.js";
import { prisma, tenantTransaction } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { recordAudit } from "@/server/services/audit";
import { nextNumber } from "@/lib/numbering/number-series";
import { coversBranch } from "@/server/repositories/scope";
import { dec, money, type MoneyIn } from "./ageing";

/**
 * Driver settlement.
 *
 * Trip earning, less advances, less approved expenses, less deductions,
 * equals net payable — with an approval step before payout, because this
 * is cash leaving the building against a document nobody outside the
 * company ever sees.
 */

export type SettlementDraft = {
  driverId: string;
  driverName: string;
  /**
   * The app_user behind this driver, when they have a field login. Carried
   * so the preparer can be compared against the payee — see
   * `createSettlement`.
   */
  driverUserId: string | null;
  tripId: string | null;
  tripNumber: string | null;
  tripEarning: Decimal;
  /** True when the figure was typed rather than read off the trip. */
  tripEarningWasEntered: boolean;
  advancesPaid: Decimal;
  expensesClaimed: Decimal;
  /** Expenses submitted but not yet approved — visible, but not paid. */
  expensesPending: Decimal;
  deductions: Decimal;
  netPayable: Decimal;
  lines: Array<{ label: string; amount: Decimal; kind: "EARNING" | "DEDUCTION" }>;
};

/**
 * Works out what a trip owes its driver.
 *
 * Only approved expenses count. An unapproved claim is shown separately
 * rather than folded in — paying it and approving it later is how a
 * settlement stops reconciling.
 *
 * Takes the actor because a settlement is a payout, and this read used to
 * be a bare `findUnique` on a trip id: tenant-scoped, but scoped to
 * nothing else, so any id reachable by guessing or from another screen
 * drafted a settlement. Branch scope is what was missing, and it is
 * checked against both ends of the lane because the settlements queue
 * lists a trip to its origin and its destination alike.
 */
export async function draftSettlement(
  options: { tripId: string; deductions?: MoneyIn; tripEarning?: MoneyIn },
  actor: SessionUser,
): Promise<SettlementDraft | null> {
  const trip = await prisma.trip.findUnique({
    where: { id: options.tripId },
    select: {
      id: true,
      number: true,
      driverId: true,
      originBranchId: true,
      destinationBranchId: true,
      freightPayable: true,
      advancePaid: true,
      driver: { select: { id: true, name: true, userId: true } },
      expenses: {
        select: {
          id: true,
          category: true,
          amount: true,
          isApproved: true,
          incurredOn: true,
        },
      },
    },
  });

  if (!trip || !trip.driver) return null;
  if (
    !coversBranch(actor, trip.originBranchId) &&
    !coversBranch(actor, trip.destinationBranchId)
  ) {
    return null;
  }

  // The trip's own agreed freight is the earning. A figure passed in is
  // accepted only where the trip carries none — it used to be *preferred*
  // over the trip, which meant a number posted on a form silently beat the
  // record every time, on any trip, for anyone holding `settlement.prepare`.
  const hasTripFreight =
    trip.freightPayable !== null && trip.freightPayable !== undefined;
  const entered =
    !hasTripFreight &&
    options.tripEarning !== undefined &&
    options.tripEarning !== null;

  const tripEarning = money(
    entered ? dec(options.tripEarning) : dec(trip.freightPayable?.toString()),
  );
  const advancesPaid = money(dec(trip.advancePaid?.toString()));

  const approved = trip.expenses.filter((expense) => expense.isApproved);
  const pending = trip.expenses.filter((expense) => !expense.isApproved);

  const expensesClaimed = money(
    approved.reduce((sum, e) => sum.plus(dec(e.amount.toString())), new Decimal(0)),
  );
  const expensesPending = money(
    pending.reduce((sum, e) => sum.plus(dec(e.amount.toString())), new Decimal(0)),
  );

  const deductions = money(dec(options.deductions));
  const netPayable = money(
    tripEarning.minus(advancesPaid).plus(expensesClaimed).minus(deductions),
  );

  return {
    driverId: trip.driver.id,
    driverName: trip.driver.name,
    driverUserId: trip.driver.userId,
    tripId: trip.id,
    tripNumber: trip.number,
    tripEarning,
    tripEarningWasEntered: entered,
    advancesPaid,
    expensesClaimed,
    expensesPending,
    deductions,
    netPayable,
    lines: [
      { label: "Trip earning", amount: tripEarning, kind: "EARNING" as const },
      { label: "Approved expenses", amount: expensesClaimed, kind: "EARNING" as const },
      { label: "Advances already paid", amount: advancesPaid, kind: "DEDUCTION" as const },
      { label: "Deductions", amount: deductions, kind: "DEDUCTION" as const },
    ].filter((line) => !line.amount.isZero()),
  };
}

export type SettlementResult =
  | { ok: true; settlementId: string; number: string; netPayable: Decimal }
  | { ok: false; error: string };

export async function createSettlement(
  input: {
    tripId: string;
    deductions?: MoneyIn;
    deductionNote?: string | null;
    tripEarning?: MoneyIn;
  },
  actor: SessionUser,
): Promise<SettlementResult> {
  if (!can(actor, "settlement.prepare")) {
    return { ok: false, error: "You do not have permission to prepare settlements." };
  }

  const draft = await draftSettlement(input, actor);
  if (!draft) {
    return {
      ok: false,
      error:
        "That trip cannot be settled here — it has no driver, or it ran " +
        "between branches you do not cover.",
    };
  }

  // Nobody settles their own trip. The same control as the one on approval
  // a few lines down, applied at the other end: `settlement.prepare` is the
  // gate here and the DRIVER role holds it, so without this a driver with
  // a field login could raise the document that pays them.
  if (draft.driverUserId && draft.driverUserId === actor.id) {
    return {
      ok: false,
      error:
        "A driver cannot prepare their own settlement. Ask the transport " +
        "desk to raise it.",
    };
  }

  const deductions = money(dec(input.deductions));
  if (deductions.greaterThan(0) && !input.deductionNote?.trim()) {
    return { ok: false, error: "Say what the deduction is for — a driver will ask." };
  }

  const existing = await prisma.driverSettlement.findFirst({
    where: { tripId: input.tripId, status: { not: "CANCELLED" } },
    select: { number: true },
  });
  if (existing) {
    return { ok: false, error: `Trip already settled on ${existing.number}.` };
  }

  try {
    const created = await tenantTransaction(async (tx) => {
      const number = await nextNumber(
        { document: "SETTLEMENT" },
        tx,
      );

      return tx.driverSettlement.create({
        data: {
          orgId: actor.orgId,
          number,
          driverId: draft.driverId,
          tripId: draft.tripId,
          status: "DRAFT",
          tripEarning: draft.tripEarning.toFixed(2),
          advancesPaid: draft.advancesPaid.toFixed(2),
          expensesClaimed: draft.expensesClaimed.toFixed(2),
          deductions: draft.deductions.toFixed(2),
          deductionNote: input.deductionNote?.trim() ?? undefined,
          netPayable: draft.netPayable.toFixed(2),
          createdById: actor.id,
        },
        select: { id: true, number: true },
      });
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "DriverSettlement",
      entityId: created.id,
      entityRef: created.number,
      after: {
        driver: draft.driverName,
        trip: draft.tripNumber,
        tripEarning: draft.tripEarning.toFixed(2),
        // Where the earning came from. A trip with no `freightPayable` has
        // to take a typed figure, and the audit row should say so rather
        // than let it read like the trip's own number.
        tripEarningSource: draft.tripEarningWasEntered
          ? "entered by hand"
          : "trip freight payable",
        advancesPaid: draft.advancesPaid.toFixed(2),
        expensesClaimed: draft.expensesClaimed.toFixed(2),
        deductions: draft.deductions.toFixed(2),
        netPayable: draft.netPayable.toFixed(2),
      },
    });

    return {
      ok: true,
      settlementId: created.id,
      number: created.number,
      netPayable: draft.netPayable,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("No active number series")) {
      return {
        ok: false,
        error:
          "No settlement number series is configured. Set one up under Masters → Number series.",
      };
    }
    console.error("[billing/settlement] create", error);
    return { ok: false, error: "Could not prepare that settlement. Nothing was saved." };
  }
}


/**
 * The branches a settlement belongs to, through the trip it settles.
 *
 * `DriverSettlement.tripId` is a bare column with no Prisma relation, so
 * this is two queries rather than an `include` — and it is why the check
 * has to be spelled out at each call site rather than living in a `where`.
 *
 * `createSettlement` has asked this since it was written, through
 * `draftSettlement`. Approving, paying and cancelling did not: a settlement
 * id off a form was enough, so a branch-scoped approver holding
 * `settlement.approve` could release a payout on a trip between two
 * branches they have never seen. Only network-scoped roles hold that
 * permission today, which is why nothing has gone wrong — a custom role is
 * one screen away from changing that.
 */
async function coversSettlement(
  actor: SessionUser,
  tripId: string | null,
): Promise<boolean> {
  if (actor.branchIds === null) return true;
  // No trip means no branch to check against, and a branch-scoped user is
  // not the person to act on a payout that belongs to nowhere.
  if (!tripId) return false;

  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    select: { originBranchId: true, destinationBranchId: true },
  });
  if (!trip) return false;

  return (
    coversBranch(actor, trip.originBranchId) ||
    coversBranch(actor, trip.destinationBranchId)
  );
}

/**
 * Approves a settlement for payout.
 *
 * Sensitive and audited with a reason. The person who prepared it cannot
 * be the person who approves it — the whole control is that two people
 * looked at the figure.
 */
export async function approveSettlement(
  input: { settlementId: string; reason: string },
  actor: SessionUser,
): Promise<{ ok: true; number: string } | { ok: false; error: string }> {
  if (!can(actor, "settlement.approve")) {
    return { ok: false, error: "You do not have permission to approve settlements." };
  }
  if (!input.reason?.trim()) {
    return { ok: false, error: "Give a reason — approving a payout is audited." };
  }

  const settlement = await prisma.driverSettlement.findUnique({
    where: { id: input.settlementId },
    select: {
      id: true,
      number: true,
      status: true,
      netPayable: true,
      createdById: true,
      tripId: true,
      driver: { select: { name: true } },
    },
  });

  if (!settlement) return { ok: false, error: "That settlement no longer exists." };
  if (!(await coversSettlement(actor, settlement.tripId))) {
    return { ok: false, error: "That settlement is outside your branch scope." };
  }
  if (settlement.status !== "DRAFT") {
    return { ok: false, error: `That settlement is already ${settlement.status.toLowerCase()}.` };
  }
  if (settlement.createdById === actor.id) {
    return {
      ok: false,
      error:
        "A settlement cannot be approved by the person who prepared it. " +
        "Ask a second approver.",
    };
  }

  await prisma.driverSettlement.update({
    where: { id: settlement.id },
    data: { status: "APPROVED", approvedAt: new Date(), approvedById: actor.id },
  });

  await recordAudit({
    user: actor,
    action: "APPROVE",
    entity: "DriverSettlement",
    entityId: settlement.id,
    entityRef: settlement.number,
    before: { status: "DRAFT" },
    after: {
      status: "APPROVED",
      driver: settlement.driver.name,
      netPayable: settlement.netPayable.toString(),
    },
    reason: input.reason.trim(),
  });

  return { ok: true, number: settlement.number };
}

/** Marks an approved settlement as paid out. */
export async function markSettlementPaid(
  input: { settlementId: string; reference?: string | null },
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "payment.record")) {
    return { ok: false, error: "You do not have permission to record payouts." };
  }

  const settlement = await prisma.driverSettlement.findUnique({
    where: { id: input.settlementId },
    select: { id: true, number: true, status: true, netPayable: true, tripId: true },
  });

  if (!settlement) return { ok: false, error: "That settlement no longer exists." };
  if (!(await coversSettlement(actor, settlement.tripId))) {
    return { ok: false, error: "That settlement is outside your branch scope." };
  }
  if (settlement.status !== "APPROVED") {
    return { ok: false, error: "Only an approved settlement can be paid out." };
  }

  await prisma.driverSettlement.update({
    where: { id: settlement.id },
    data: { status: "PAID", paidAt: new Date() },
  });

  await recordAudit({
    user: actor,
    action: "STATUS_CHANGE",
    entity: "DriverSettlement",
    entityId: settlement.id,
    entityRef: settlement.number,
    before: { status: "APPROVED" },
    after: {
      status: "PAID",
      amount: settlement.netPayable.toString(),
      reference: input.reference ?? null,
    },
    reason: "Paid out to the driver.",
  });

  return { ok: true };
}

export async function cancelSettlement(
  input: { settlementId: string; reason: string },
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "settlement.approve")) {
    return { ok: false, error: "You do not have permission to cancel settlements." };
  }
  if (!input.reason?.trim()) {
    return { ok: false, error: "Give a reason." };
  }

  const settlement = await prisma.driverSettlement.findUnique({
    where: { id: input.settlementId },
    select: { id: true, number: true, status: true, tripId: true },
  });

  if (!settlement) return { ok: false, error: "That settlement no longer exists." };
  if (!(await coversSettlement(actor, settlement.tripId))) {
    return { ok: false, error: "That settlement is outside your branch scope." };
  }
  if (settlement.status === "PAID") {
    return { ok: false, error: "That settlement has already been paid out." };
  }

  await prisma.driverSettlement.update({
    where: { id: settlement.id },
    data: { status: "CANCELLED" },
  });

  await recordAudit({
    user: actor,
    action: "CANCEL",
    entity: "DriverSettlement",
    entityId: settlement.id,
    entityRef: settlement.number,
    before: { status: settlement.status },
    after: { status: "CANCELLED" },
    reason: input.reason.trim(),
  });

  return { ok: true };
}
