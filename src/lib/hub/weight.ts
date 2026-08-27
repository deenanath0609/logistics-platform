import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { appendShipmentEvent } from "@/lib/shipment/events";
import { ruleFor, STATUS_LABELS } from "@/lib/shipment/state-machine";
import { raiseException } from "@/lib/exceptions/service";
import { recordAudit } from "@/server/services/audit";
import { enqueueOutbox } from "@/server/services/outbox";
import { rerateShipment, type RerateResult } from "@/lib/pricing/rerate";
import {
  liveInvoiceForShipment,
  raiseReweighDebitNote,
  type ReweighDebitNoteOutcome,
} from "@/lib/billing/debit-note";

/**
 * Weighment, and the money that follows it.
 *
 * The hub puts the consignment on the scale and the number the customer
 * is billed on moves. Until this existed the revised figure was written
 * onto the shipment and nothing repriced, so every upward reweigh was
 * revenue the company had measured and then given away — the booking
 * estimate went on the invoice regardless.
 *
 * One call now does the whole sequence (BRD §A.6, §A.12, §B.7):
 *
 *   1. re-rate on the revised weight, storing a second `FreightCalculation`
 *      at the INVOICE stage — the booking one is never touched, because it
 *      is the only evidence of what was quoted at the counter;
 *   2. record `WEIGHT_CAPTURED` on the timeline, carrying the delta;
 *   3. raise a debit note when the consignment has already been invoiced,
 *      since an issued invoice cannot be edited;
 *   4. when the increase is beyond the configured tolerance, open an
 *      exception and tell the customer before they are billed for it.
 *
 * It lives in its own file so the scanning console keeps its single
 * entry point. The hub weighment screen — `src/app/(ops)/hub/weigh` — is
 * what calls it.
 */

/**
 * The one way in.
 *
 * Nothing may write `Shipment.chargeableWeight` outside booking without
 * coming through here. A screen that updates that column directly gets the
 * number right and reintroduces the leak this function exists to close —
 * the re-rate, the debit note and the tolerance exception all hang off
 * this call, not off the column.
 */
export const WEIGHT_CAPTURE_CALL_SITE =
  "src/app/(ops)/hub/weigh — the hub weighment screen calls captureRevisedWeight()";

export type CaptureRevisedWeightInput = {
  shipmentId: string;
  /** The hub doing the weighing. Checked against the actor's scope. */
  branchId: string;
  /** What the scale read. */
  actualWeight?: Decimal | number | string | null;
  /**
   * The revised chargeable figure, where the hub has one — a weighbridge
   * ticket, or a re-measure. Omit to let the engine derive it.
   */
  chargeableWeight?: Decimal | number | string | null;
  /** Weighbridge ticket, scale id, whatever the floor can point at. */
  reference?: string | null;
  deviceId?: string | null;
  occurredAt?: Date;
  /** One per physical weighing. The offline queue retries; this makes that safe. */
  idempotencyKey?: string;
  reason?: string;
};

export type CaptureRevisedWeightResult =
  | {
      ok: true;
      shipmentId: string;
      lrNumber: string;
      previousChargeableWeight: Decimal;
      revisedChargeableWeight: Decimal;
      previousTotal: Decimal;
      revisedTotal: Decimal;
      /** New minus previous. Negative when the reweigh went the other way. */
      delta: Decimal;
      deltaPercent: Decimal;
      /** The taxable part of the delta, which is what a debit note bills. */
      taxableDelta: Decimal;
      taxDelta: Decimal;
      calculationId: string;
      tolerancePercent: Decimal;
      /** Beyond tolerance: an exception is open and the customer was told. */
      exceedsTolerance: boolean;
      exceptionNumber: string | null;
      customerNotified: boolean;
      debitNote: ReweighDebitNoteOutcome;
      /** Non-fatal things the floor should see. The money was still saved. */
      warnings: string[];
    }
  | { ok: false; error: string };

/**
 * Captures a revised weight and reprices on it.
 *
 * The re-rate is the point of the function. Everything after it — the
 * timeline event, the debit note, the exception, the notification —
 * follows from a price that moved, and is reported rather than thrown, so
 * a dead SMS gateway cannot lose a weighment the floor has already done.
 */
export async function captureRevisedWeight(
  input: CaptureRevisedWeightInput,
  actor: SessionUser,
): Promise<CaptureRevisedWeightResult> {
  if (!can(actor, "weight.capture")) {
    return { ok: false, error: "You do not have permission to capture weight." };
  }
  if (!coversBranch(actor, input.branchId)) {
    return { ok: false, error: "You cannot weigh at that branch." };
  }
  if (
    (input.actualWeight === undefined || input.actualWeight === null) &&
    (input.chargeableWeight === undefined || input.chargeableWeight === null)
  ) {
    return { ok: false, error: "Enter what the scale read." };
  }

  // Read before the re-rate writes: `rerateShipment` applies the new
  // figures to the shipment, so afterwards there is nothing to compare to.
  const before = await prisma.shipment.findUnique({
    where: { id: input.shipmentId },
    select: {
      id: true,
      orgId: true,
      lrNumber: true,
      deletedAt: true,
      cancelledAt: true,
      currentStatus: true,
      originBranchId: true,
      consignorId: true,
      chargeableWeight: true,
      actualWeight: true,
      chargesTotal: true,
      taxAmount: true,
      grandTotal: true,
      isReverseCharge: true,
    },
  });

  if (!before || before.deletedAt) {
    return { ok: false, error: "That consignment no longer exists." };
  }
  if (before.cancelledAt) {
    return { ok: false, error: "That consignment is cancelled. Nothing to reweigh." };
  }

  // ── Can this consignment be weighed at all? ───────────────
  // Asked before the re-rate, not after. The timeline event is what makes
  // a reweigh explicable to the customer six weeks later, and a price that
  // moved with no event to point at is worse than a price that did not
  // move: the invoice changes and nothing on the consignment says why.
  const rule = ruleFor("WEIGHT_CAPTURED");

  if (rule && !rule.from.includes(before.currentStatus)) {
    return {
      ok: false,
      error:
        `${before.lrNumber} is ${STATUS_LABELS[before.currentStatus].toLowerCase()}. ` +
        `A consignment is weighed once it has been received at a branch or hub — ` +
        `scan it in first.`,
    };
  }

  for (const [label, value] of [
    ["actual weight", input.actualWeight],
    ["chargeable weight", input.chargeableWeight],
  ] as const) {
    if (value === undefined || value === null) continue;
    let parsed: Decimal;
    try {
      parsed = new Decimal(value.toString());
    } catch {
      return { ok: false, error: `That ${label} is not a number.` };
    }
    if (parsed.lessThanOrEqualTo(0)) {
      return { ok: false, error: `A ${label} of zero is not a weighing.` };
    }
  }

  // ── Post-invoice guard ────────────────────────────────────
  // Revising the weight on a consignment that has already been billed is
  // a separate, sensitive permission: the correction is a debit note the
  // customer will query, not a quiet edit.
  const invoiceLink = await liveInvoiceForShipment(before.id);

  if (invoiceLink?.isIssued && !can(actor, "shipment.edit_weight_post_invoice")) {
    return {
      ok: false,
      error:
        `${before.lrNumber} is already billed on ${invoiceLink.number}. Revising the weight ` +
        `now raises a debit note, which needs the post-invoice weight permission.`,
    };
  }

  const reason =
    input.reason?.trim() ||
    `Reweighed at the hub${input.reference ? ` against ${input.reference}` : ""}.`;

  // ── The re-rate ───────────────────────────────────────────
  const rerated: RerateResult = await rerateShipment(
    {
      shipmentId: before.id,
      revisedActualWeight: input.actualWeight ?? null,
      revisedChargeableWeight: input.chargeableWeight ?? null,
      stage: "INVOICE",
      applyToShipment: true,
      reason,
    },
    actor,
  );

  if (!rerated.ok) return { ok: false, error: rerated.error };

  const warnings: string[] = [];

  const previousChargeable = new Decimal(before.chargeableWeight.toString());
  const revisedChargeable = rerated.result.chargeableWeight;
  const previousCharges = new Decimal(before.chargesTotal.toString());
  const taxableDelta = rerated.result.chargesTotal
    .minus(previousCharges)
    .toDecimalPlaces(2);

  // The tax on the delta at the rate the engine actually applied. Under
  // reverse charge `taxTotal` is zero by design, so the figure has to come
  // off the stated taxes — the recipient still owes it on the extra value.
  const statedTax = rerated.result.taxes.reduce(
    (sum, tax) => sum.plus(tax.amount),
    new Decimal(0),
  );
  const taxableBase = rerated.result.taxes.reduce(
    (sum, tax) => sum.plus(tax.taxableValue),
    new Decimal(0),
  );
  const effectiveTaxPercent = taxableBase.greaterThan(0)
    ? statedTax.times(100).dividedBy(taxableBase)
    : new Decimal(0);
  const taxDelta = taxableDelta
    .times(effectiveTaxPercent)
    .dividedBy(100)
    .toDecimalPlaces(2);

  if (rerated.result.unrated) {
    warnings.push(
      `No rate rule matched this lane, so the revision priced at zero and the ` +
        `consignment stays on the coverage-gaps report. ` +
        `${rerated.result.unratedReason ?? ""}`.trim(),
    );
  }

  // ── Timeline ──────────────────────────────────────────────
  const event = await appendShipmentEvent(
    {
      shipmentId: before.id,
      eventType: "WEIGHT_CAPTURED",
      branchId: input.branchId,
      occurredAt: input.occurredAt,
      deviceId: input.deviceId,
      remarks: reason,
      idempotencyKey: input.idempotencyKey
        ? `weight:${input.idempotencyKey}`
        : undefined,
      payload: {
        previousChargeableWeight: previousChargeable.toFixed(3),
        chargeableWeight: revisedChargeable.toFixed(3),
        actualWeight: rerated.result.actualWeight.toFixed(3),
        weightBasis: rerated.result.weightBasis,
        previousTotal: rerated.previousTotal.toFixed(2),
        revisedTotal: rerated.newTotal.toFixed(2),
        delta: rerated.delta.toFixed(2),
        deltaPercent: rerated.deltaPercent.toFixed(2),
        exceedsTolerance: rerated.exceedsTolerance,
        reference: input.reference ?? null,
      },
    },
    actor,
  );

  if (!event.ok) {
    // The money is already right and the calculation is stored. A refused
    // transition means the consignment is somewhere the state machine does
    // not accept a weighing from — worth showing, not worth rolling back.
    warnings.push(`The timeline would not accept the weighing: ${event.error}`);
  }

  // ── Debit note ────────────────────────────────────────────
  const debitNote = await raiseReweighDebitNote(
    {
      shipmentId: before.id,
      delta: taxableDelta,
      taxDelta,
      taxPercent: effectiveTaxPercent,
      previousChargeableWeight: previousChargeable,
      revisedChargeableWeight: revisedChargeable,
      reason,
    },
    actor,
  );

  if (!debitNote.raised && debitNote.error) {
    warnings.push(`No debit note was raised: ${debitNote.error}`);
  }

  // ── Beyond tolerance ──────────────────────────────────────
  let exceptionNumber: string | null = null;
  let customerNotified = false;

  if (rerated.exceedsTolerance) {
    try {
      const raised = await raiseException({
        orgId: before.orgId,
        kind: "OTHER",
        priority: "HIGH",
        title: `Reweigh on ${before.lrNumber} moved the price by ${rerated.deltaPercent.toFixed(2)}%`,
        detail:
          `Chargeable weight revised from ${previousChargeable.toFixed(3)} kg to ` +
          `${revisedChargeable.toFixed(3)} kg. The consignment reprices from ` +
          `₹${rerated.previousTotal.toFixed(2)} to ₹${rerated.newTotal.toFixed(2)} ` +
          `(₹${rerated.delta.toFixed(2)}), which is past the ` +
          `${rerated.tolerancePercent.toFixed(2)}% tolerance. ` +
          (debitNote.raised
            ? `Debit note ${debitNote.number} raised.`
            : `No debit note: ${debitNote.raised === false ? debitNote.reason : ""}`),
        shipmentId: before.id,
        branchId: input.branchId,
        ownerBranchId: before.originBranchId,
        source: "hub",
        // One exception per weighing, not per look at it.
        dedupeKey: `reweigh-tolerance:${rerated.calculationId}`,
      });

      exceptionNumber = raised.exception.number;
    } catch (error) {
      console.error("[hub/weight] exception", error);
      warnings.push(
        "The reweigh is past tolerance but the exception could not be opened. Raise one by hand.",
      );
    }

    // The customer is told before they are billed for it (BRD §A.6). Written
    // to the outbox, so a dead gateway cannot fail a weighment.
    try {
      await enqueueOutbox({
        eventType: "shipment.reweighed",
        aggregate: "Shipment",
        aggregateId: before.id,
        payload: {
          lrNumber: before.lrNumber,
          eventId: event.ok ? event.eventId : rerated.calculationId,
          previousChargeableWeight: previousChargeable.toFixed(3),
          chargeableWeight: revisedChargeable.toFixed(3),
          previousTotal: rerated.previousTotal.toFixed(2),
          revisedTotal: rerated.newTotal.toFixed(2),
          delta: rerated.delta.toFixed(2),
          deltaPercent: rerated.deltaPercent.toFixed(2),
          tolerancePercent: rerated.tolerancePercent.toFixed(2),
          debitNoteNumber: debitNote.raised ? debitNote.number : null,
          branchId: input.branchId,
        },
      });
      customerNotified = true;
    } catch (error) {
      console.error("[hub/weight] notify", error);
      warnings.push(
        "The reweigh is past tolerance but the customer notification could not be queued.",
      );
    }
  }

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "Shipment",
    entityId: before.id,
    entityRef: before.lrNumber,
    branchId: input.branchId,
    before: {
      chargeableWeight: previousChargeable.toFixed(3),
      actualWeight: new Decimal(before.actualWeight.toString()).toFixed(3),
      chargesTotal: previousCharges.toFixed(2),
      grandTotal: rerated.previousTotal.toFixed(2),
    },
    after: {
      chargeableWeight: revisedChargeable.toFixed(3),
      actualWeight: rerated.result.actualWeight.toFixed(3),
      chargesTotal: rerated.result.chargesTotal.toFixed(2),
      grandTotal: rerated.newTotal.toFixed(2),
      delta: rerated.delta.toFixed(2),
      deltaPercent: rerated.deltaPercent.toFixed(2),
      exceedsTolerance: rerated.exceedsTolerance,
      calculationId: rerated.calculationId,
      debitNote: debitNote.raised ? debitNote.number : null,
      exception: exceptionNumber,
      reference: input.reference ?? null,
    },
    reason,
  });

  return {
    ok: true,
    shipmentId: before.id,
    lrNumber: before.lrNumber,
    previousChargeableWeight: previousChargeable,
    revisedChargeableWeight: revisedChargeable,
    previousTotal: rerated.previousTotal,
    revisedTotal: rerated.newTotal,
    delta: rerated.delta,
    deltaPercent: rerated.deltaPercent,
    taxableDelta,
    taxDelta,
    calculationId: rerated.calculationId,
    tolerancePercent: rerated.tolerancePercent,
    exceedsTolerance: rerated.exceedsTolerance,
    exceptionNumber,
    customerNotified,
    debitNote,
    warnings,
  };
}

/**
 * What a weighing would do, without doing it.
 *
 * The scanning console shows the clerk the new figure before they commit
 * it — a reweigh that surprises the customer is a reweigh that gets
 * disputed, and the person holding the scale is the one who can check it.
 */
export async function previewRevisedWeight(
  input: Pick<
    CaptureRevisedWeightInput,
    "shipmentId" | "actualWeight" | "chargeableWeight"
  >,
  actor: SessionUser,
): Promise<
  | {
      ok: true;
      previousTotal: Decimal;
      revisedTotal: Decimal;
      delta: Decimal;
      deltaPercent: Decimal;
      exceedsTolerance: boolean;
      tolerancePercent: Decimal;
      chargeableWeight: Decimal;
      unrated: boolean;
    }
  | { ok: false; error: string }
> {
  if (!can(actor, "weight.capture")) {
    return { ok: false, error: "You do not have permission to capture weight." };
  }

  // `applyToShipment: false` prices without touching the shipment. It still
  // stores the calculation, which is deliberate — a quote the clerk was
  // shown and then abandoned is worth being able to point at.
  const rerated = await rerateShipment(
    {
      shipmentId: input.shipmentId,
      revisedActualWeight: input.actualWeight ?? null,
      revisedChargeableWeight: input.chargeableWeight ?? null,
      stage: "INVOICE",
      applyToShipment: false,
      reason: "Reweigh preview — nothing was applied to the consignment.",
    },
    actor,
  );

  if (!rerated.ok) return { ok: false, error: rerated.error };

  return {
    ok: true,
    previousTotal: rerated.previousTotal,
    revisedTotal: rerated.newTotal,
    delta: rerated.delta,
    deltaPercent: rerated.deltaPercent,
    exceedsTolerance: rerated.exceedsTolerance,
    tolerancePercent: rerated.tolerancePercent,
    chargeableWeight: rerated.result.chargeableWeight,
    unrated: rerated.result.unrated,
  };
}
