import Decimal from "decimal.js";
import { prisma, tenantTransaction, type Db } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { anyBranchScope, coversBranch } from "@/server/repositories/scope";
import { recordAudit } from "@/server/services/audit";
import type { FreightResult } from "./engine";
import {
  SHIPMENT_PRICING_SELECT,
  loadPricingContext,
  priceShipment,
  snapshotShipment,
  storeFreightCalculation,
  type FreightStage,
} from "./resolve";

/**
 * Re-rating after a weight revision.
 *
 * The hub weighs again, and the number the customer is billed on moves.
 * The original calculation is never touched — a second `FreightCalculation`
 * is stored at the INVOICE stage, and the delta between the two is what a
 * debit note is raised from. Overwriting the first would leave no evidence
 * of what was quoted at the counter, which is the one document a disputed
 * reweigh turns on.
 */

/** How much of an increase passes without anybody being told. */
export const DEFAULT_REWEIGH_TOLERANCE_PERCENT = 10;

const TOLERANCE_KEY = "billing.reweighTolerancePercent";

/** The org's tolerance, or the default when nothing is configured. */
export async function reweighTolerancePercent(
  orgId: string,
  client: Pick<Db, "systemConfig"> = prisma,
): Promise<Decimal> {
  const row = await client.systemConfig.findFirst({
    where: { orgId, key: TOLERANCE_KEY },
    select: { value: true },
  });

  const raw = row?.value;
  if (raw === null || raw === undefined) {
    return new Decimal(DEFAULT_REWEIGH_TOLERANCE_PERCENT);
  }

  try {
    return new Decimal(String(raw));
  } catch {
    // Falling back is right — a typo in a config row must not stop the hub
    // weighing — but it is said out loud, because silently reverting to 10%
    // when somebody meant to set 2% is a tolerance nobody can explain.
    console.warn(
      `[pricing/rerate] ${TOLERANCE_KEY} is not a number (${String(raw)}); ` +
        `falling back to ${DEFAULT_REWEIGH_TOLERANCE_PERCENT}%.`,
    );
    return new Decimal(DEFAULT_REWEIGH_TOLERANCE_PERCENT);
  }
}

export type RerateInput = {
  shipmentId: string;
  /** The hub's revised figure. Omit to re-price on the stored weight. */
  revisedChargeableWeight?: Decimal | number | string | null;
  revisedActualWeight?: Decimal | number | string | null;
  stage?: FreightStage;
  /** Write the new figures back onto the shipment. */
  applyToShipment?: boolean;
  reason?: string;
};

export type RerateResult =
  | {
      ok: true;
      calculationId: string;
      previousTotal: Decimal;
      newTotal: Decimal;
      /** New minus previous. Negative when the reweigh went the other way. */
      delta: Decimal;
      deltaPercent: Decimal;
      /** The increase is beyond tolerance — tell the customer before billing. */
      exceedsTolerance: boolean;
      tolerancePercent: Decimal;
      result: FreightResult;
    }
  | { ok: false; error: string };

export async function rerateShipment(
  input: RerateInput,
  actor: SessionUser,
): Promise<RerateResult> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: input.shipmentId },
    select: {
      ...SHIPMENT_PRICING_SELECT,
      orgId: true,
      deletedAt: true,
      cancelledAt: true,
      originBranchId: true,
      currentBranchId: true,
      destinationBranchId: true,
      freightAmount: true,
      chargesTotal: true,
      taxAmount: true,
      grandTotal: true,
    },
  });

  if (!shipment || shipment.deletedAt) {
    return { ok: false, error: "That shipment no longer exists." };
  }

  // Every caller reaches this with a shipment id off a form, and the id is
  // the only thing they send. `captureRevisedWeight` checks its own scope
  // before calling in; the pricing desk's re-rate did not, so a branch-
  // scoped user could reprice any consignment on the network by id alone.
  if (
    !coversBranch(actor, shipment.originBranchId) &&
    !coversBranch(actor, shipment.destinationBranchId) &&
    !(shipment.currentBranchId && coversBranch(actor, shipment.currentBranchId))
  ) {
    return {
      ok: false,
      error: `${shipment.lrNumber} has not been anywhere near your branches.`,
    };
  }

  if (shipment.cancelledAt) {
    return {
      ok: false,
      error: `${shipment.lrNumber} is cancelled. There is nothing left to price.`,
    };
  }

  const snapshot = await snapshotShipment(shipment);

  // A revised chargeable weight is authoritative: the hub has the goods on
  // the scale, the booking clerk had a customer's word for it.
  if (input.revisedActualWeight !== undefined && input.revisedActualWeight !== null) {
    snapshot.actualWeight = input.revisedActualWeight.toString();
  }
  if (
    input.revisedChargeableWeight !== undefined &&
    input.revisedChargeableWeight !== null
  ) {
    const revised = new Decimal(input.revisedChargeableWeight.toString());
    // Feeding it in as actual weight lets the engine's own floors and
    // rounding still apply, rather than bypassing them.
    if (revised.greaterThan(new Decimal(snapshot.actualWeight?.toString() ?? 0))) {
      snapshot.actualWeight = revised.toString();
    }
    snapshot.volumetricWeight = revised.toString();
  }

  const context = await loadPricingContext(shipment.orgId);
  const result = await priceShipment(snapshot, {
    orgId: shipment.orgId,
    volumetricDivisor: shipment.serviceType.volumetricDivisor,
    context,
  });

  const previousTotal = new Decimal(shipment.grandTotal.toString());
  const newTotal = result.total;
  const delta = newTotal.minus(previousTotal).toDecimalPlaces(2);
  const deltaPercent = previousTotal.greaterThan(0)
    ? delta.times(100).dividedBy(previousTotal).toDecimalPlaces(2)
    : new Decimal(0);

  const tolerancePercent = await reweighTolerancePercent(shipment.orgId);
  const exceedsTolerance =
    delta.greaterThan(0) && deltaPercent.greaterThan(tolerancePercent);

  const stage: FreightStage = input.stage ?? "INVOICE";

  const calculationId = await tenantTransaction(async (tx) => {
    const id = await storeFreightCalculation(
      { shipmentId: shipment.id, result, stage, userId: actor.id },
      tx,
    );

    if (input.applyToShipment !== false) {
      await tx.shipment.update({
        where: { id: shipment.id },
        data: {
          chargeableWeight: result.chargeableWeight.toFixed(3),
          volumetricWeight: result.volumetricWeight.toFixed(3),
          freightAmount: result.freightAmount.toFixed(2),
          chargesTotal: result.chargesTotal.toFixed(2),
          taxAmount: result.taxTotal.toFixed(2),
          grandTotal: result.total.toFixed(2),
        },
      });

      // Engine-generated charge rows are replaced; anything a clerk added
      // by hand survives, because the engine did not put it there and has
      // no business taking it away.
      await tx.shipmentCharge.deleteMany({
        where: { shipmentId: shipment.id, isManual: false },
      });

      if (result.lines.length > 0) {
        await tx.shipmentCharge.createMany({
          data: result.lines
            .filter((line) => !line.chargeTypeId.startsWith("synthetic:"))
            .map((line, index) => ({
              orgId: shipment.orgId,
              shipmentId: shipment.id,
              chargeTypeId: line.chargeTypeId,
              basis: line.basis as Prisma.ShipmentChargeCreateManyInput["basis"],
              rate: line.rate.toFixed(4),
              quantity: line.quantity.toFixed(3),
              amount: line.amount.toFixed(2),
              taxRateId: line.taxRateId,
              taxPercent: line.taxPercent.toFixed(3),
              taxAmount: line.amount
                .times(line.taxPercent)
                .dividedBy(100)
                .toFixed(2),
              isManual: false,
              remarks: `Re-rated ${new Date().toISOString().slice(0, 10)}`,
              sortOrder: index * 10,
            })),
        });
      }
    }

    return id;
  });

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "FreightCalculation",
    entityId: calculationId,
    entityRef: shipment.lrNumber,
    before: { grandTotal: previousTotal.toFixed(2) },
    after: {
      grandTotal: newTotal.toFixed(2),
      chargeableWeight: result.chargeableWeight.toFixed(3),
      delta: delta.toFixed(2),
      deltaPercent: deltaPercent.toFixed(2),
      exceedsTolerance,
      unrated: result.unrated,
    },
    reason:
      input.reason ??
      `Re-rated at ${stage} stage after a weight revision (${deltaPercent.toFixed(2)}% change).`,
  });

  return {
    ok: true,
    calculationId,
    previousTotal,
    newTotal,
    delta,
    deltaPercent,
    exceedsTolerance,
    tolerancePercent,
    result,
  };
}

/**
 * Shipments the engine could not price.
 *
 * They booked with an unrated flag rather than silently at zero, and this
 * is the report that turns that flag into a rate card.
 */
export async function coverageGaps(
  options: { orgId: string; from?: Date; to?: Date; take?: number },
  user: SessionUser,
): Promise<
  Array<{
    shipmentId: string;
    lrNumber: string;
    bookedAt: Date;
    customerName: string | null;
    origin: string;
    destination: string;
    mode: string;
    reason: string;
  }>
> {
  const calculations = await prisma.freightCalculation.findMany({
    where: {
      trace: { path: ["unrated"], equals: true },
      ...(options.from || options.to
        ? {
            createdAt: {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.to ? { lte: options.to } : {}),
            },
          }
        : {}),
      // `ratecard.read` is in `allReads`, so every Branch Manager holds it
      // and a Booking Executive is granted it outright — both branch-scoped.
      // Without this the gap report answered a Gurugram clerk with Jaipur's
      // LR numbers, consignors and lanes, which is the one thing Phase 1
      // says must not happen through the UI or the API.
      //
      // Inside `AND`, never spread beside the rest: `anyBranchScope` returns
      // `{ OR: [...] }` and a second `OR` in the same object literal wins
      // silently. `src/server/repositories/scope.test.ts` reads this file.
      shipment: {
        orgId: options.orgId,
        deletedAt: null,
        AND: [anyBranchScope(user, ["originBranchId", "destinationBranchId"])],
      },
    },
    orderBy: { createdAt: "desc" },
    take: options.take ?? 200,
    select: {
      id: true,
      trace: true,
      shipment: {
        select: {
          id: true,
          lrNumber: true,
          bookedAt: true,
          mode: true,
          consignor: { select: { name: true } },
          originBranch: { select: { code: true } },
          destinationBranch: { select: { code: true } },
        },
      },
    },
  });

  /**
   * Lanes that have since been priced drop off.
   *
   * The query above finds every *unrated* calculation, which includes ones
   * a consignment has since been re-rated past: price the lane, re-rate the
   * consignment, and it stayed on the report forever. A worklist that never
   * empties is a worklist nobody reads, which is exactly what this screen
   * exists to prevent — so a shipment counts as a gap only while its
   * **latest** calculation is still the unrated one.
   *
   * Bounded by the shipments the page is already showing, so this cannot
   * become a trawl of the calculation table.
   */
  const shipmentIds = [...new Set(calculations.map((calc) => calc.shipment.id))];

  const latest = await prisma.freightCalculation.findMany({
    where: { shipmentId: { in: shipmentIds } },
    orderBy: { createdAt: "desc" },
    select: { id: true, shipmentId: true, trace: true },
  });

  const latestByShipment = new Map<string, string>();
  for (const calc of latest) {
    // `findMany` came back newest first, so the first sighting wins.
    if (!latestByShipment.has(calc.shipmentId)) {
      latestByShipment.set(calc.shipmentId, calc.id);
    }
  }

  const stillUnrated = new Set(
    latest
      .filter(
        (calc) =>
          latestByShipment.get(calc.shipmentId) === calc.id &&
          (calc.trace as { unrated?: boolean } | null)?.unrated === true,
      )
      .map((calc) => calc.shipmentId),
  );

  // One row per shipment: a lane re-priced three times is still one gap.
  const seen = new Set<string>();
  const rows = [];

  for (const calc of calculations) {
    if (seen.has(calc.shipment.id)) continue;
    if (!stillUnrated.has(calc.shipment.id)) continue;
    seen.add(calc.shipment.id);

    const trace = calc.trace as { unratedReason?: string } | null;

    rows.push({
      shipmentId: calc.shipment.id,
      lrNumber: calc.shipment.lrNumber,
      bookedAt: calc.shipment.bookedAt,
      customerName: calc.shipment.consignor?.name ?? null,
      origin: calc.shipment.originBranch.code,
      destination: calc.shipment.destinationBranch.code,
      mode: calc.shipment.mode,
      reason: trace?.unratedReason ?? "No rate rule matched this lane.",
    });
  }

  return rows;
}
