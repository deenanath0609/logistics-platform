import { randomUUID } from "node:crypto";
import { prisma, tenantTransaction, type Tx } from "@/lib/prisma";
import type {
  Prisma,
  ReasonCategory,
  ShipmentStatus,
} from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { appendShipmentEvent } from "./events";
import { humanise } from "./state-machine";
import { chargeableWeight } from "./weight";
import { rerateShipment } from "@/lib/pricing/rerate";

/**
 * A consignment's own lifecycle — the five things that happen to a booking
 * rather than to the freight.
 *
 * Cancelling, holding, releasing, amending and correcting a status all
 * existed in the state machine and had no caller anywhere in the product:
 * a branch that booked the wrong consignment could not un-book it, a hub
 * holding freight for a payment dispute had nowhere to say so — the detail
 * page has always rendered an on-hold badge that nothing could set — and a
 * mis-scan was permanent.
 *
 * Every function here is a service in the shape `src/lib/delivery/execute.ts`
 * uses: it takes the actor, checks the permission and the branch scope
 * itself, and returns a result rather than throwing. The screens call these,
 * and so does `scripts/verify-shipment-lifecycle.ts`.
 *
 * Status is never written here. Each one ends at `appendShipmentEvent`,
 * which is the only writer of `currentStatus`, and the transition rules in
 * `state-machine.ts` are the specification — nothing below widens one.
 */

// ────────────────────────────────────────────────────────────
// Shared loading and guards
// ────────────────────────────────────────────────────────────

const SHIPMENT_SELECT = {
  id: true,
  // Stamped onto the package rows an amendment adds, from the parent rather
  // than from the actor: a box belongs to whoever owns the consignment.
  orgId: true,
  lrNumber: true,
  currentStatus: true,
  isOnHold: true,
  deletedAt: true,
  bookingBranchId: true,
  originBranchId: true,
  destinationBranchId: true,
  currentBranchId: true,
  packageCount: true,
  packageTypeId: true,
  actualWeight: true,
  chargeableWeight: true,
  goodsDescription: true,
  specialInstructions: true,
  consignorName: true,
  consignorCompany: true,
  consignorPhone: true,
  consignorEmail: true,
  consignorGstin: true,
  consignorAddress: true,
  consigneeName: true,
  consigneeCompany: true,
  consigneePhone: true,
  consigneeEmail: true,
  consigneeGstin: true,
  consigneeAddress: true,
  consigneeLandmark: true,
  serviceType: { select: { volumetricDivisor: true } },
} satisfies Prisma.ShipmentSelect;

type LoadedShipment = Prisma.ShipmentGetPayload<{
  select: typeof SHIPMENT_SELECT;
}>;

type Loaded =
  | { ok: true; shipment: LoadedShipment }
  | { ok: false; error: string };

/**
 * Loads a consignment the actor is allowed to act on.
 *
 * The four branches are the same four the detail page checks: a consignment
 * belongs to where it was booked, where it started, where it is going, and
 * where it physically is now, and somebody covering any one of them has a
 * reason to act on it. The page guard is not an action guard — a server
 * action is reachable without ever rendering the page, so the check is
 * repeated here rather than assumed.
 */
async function loadShipment(
  shipmentId: string,
  actor: SessionUser,
): Promise<Loaded> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: SHIPMENT_SELECT,
  });

  if (!shipment || shipment.deletedAt) {
    return { ok: false, error: "That consignment no longer exists." };
  }

  const reachable = [
    shipment.bookingBranchId,
    shipment.originBranchId,
    shipment.destinationBranchId,
    shipment.currentBranchId,
  ].filter((branchId): branchId is string => Boolean(branchId));

  if (!reachable.some((branchId) => coversBranch(actor, branchId))) {
    return { ok: false, error: "That consignment is outside your scope." };
  }

  return { ok: true, shipment };
}

type ReasonRow = { id: string; code: string; name: string };

/**
 * Resolves a reason code and refuses one from the wrong drawer.
 *
 * Reason categories are what make the reports mean anything: a hold reason
 * posted against a cancellation is a row nobody can count. The picker only
 * offers the right category, but the picker is not the boundary — the id
 * arrives as form data.
 */
async function loadReason(
  reasonCodeId: string | null | undefined,
  category: ReasonCategory,
  label: string,
): Promise<{ ok: true; reason: ReasonRow } | { ok: false; error: string }> {
  if (!reasonCodeId) {
    return { ok: false, error: `Choose a ${label} reason.` };
  }

  const reason = await prisma.reasonCode.findUnique({
    where: { id: reasonCodeId },
    select: { id: true, code: true, name: true, category: true, isActive: true },
  });

  if (!reason || !reason.isActive || reason.category !== category) {
    return { ok: false, error: `Choose a ${label} reason.` };
  }

  return { ok: true, reason: { id: reason.id, code: reason.code, name: reason.name } };
}

// ────────────────────────────────────────────────────────────
// Cancel
// ────────────────────────────────────────────────────────────

/**
 * Where a cancellation is still a booking correction.
 *
 * The transition rule allows the whole pre-dispatch range, up to and
 * including MANIFESTED. This action is deliberately narrower — narrower is
 * the action's business, widening would not be — and stops at the moment
 * the carrier takes the goods.
 *
 * Once a consignment is PICKED_UP there are boxes on a shelf. Cancelling
 * then would put a terminal status on freight that physically exists in the
 * network, with nothing owed to anybody to bring it back: the consignor's
 * goods have to be returned, which is an RTO with its own permission,
 * its own charge and its own delivery. That is the larger conversation, and
 * a Cancel button is not where it should happen.
 */
export const CANCELLABLE_FROM: ShipmentStatus[] = ["BOOKED", "PICKUP_ASSIGNED"];

export type CancelShipmentInput = {
  shipmentId: string;
  reasonCodeId: string;
  remarks?: string | null;
  idempotencyKey?: string;
};

export type CancelShipmentResult =
  | { ok: true; lrNumber: string; pickupsCancelled: number }
  | { ok: false; error: string; field?: string };

/**
 * Cancels a consignment that should never have been booked.
 *
 * The booking survives — it is not deleted, and the LR number is not
 * reissued. A cancelled consignment with a reason on it is what a duplicate
 * booking, a mistyped account or an unserviceable destination leaves
 * behind, and the count of them per branch is a real measure.
 */
export async function cancelShipment(
  input: CancelShipmentInput,
  actor: SessionUser,
): Promise<CancelShipmentResult> {
  if (!can(actor, "shipment.cancel")) {
    return { ok: false, error: "You do not have permission to cancel a booking." };
  }

  const loaded = await loadShipment(input.shipmentId, actor);
  if (!loaded.ok) return loaded;
  const { shipment } = loaded;

  if (!CANCELLABLE_FROM.includes(shipment.currentStatus)) {
    return {
      ok: false,
      error:
        shipment.currentStatus === "CANCELLED"
          ? "This consignment is already cancelled."
          : `The goods are already with us — ${humanise(shipment.currentStatus)}. A consignment in the network is returned to the consignor, not cancelled.`,
    };
  }

  const reason = await loadReason(input.reasonCodeId, "CANCELLATION", "cancellation");
  if (!reason.ok) return { ok: false, error: reason.error, field: "reasonCodeId" };

  try {
    const pickupsCancelled = await tenantTransaction(async (tx) => {
      const event = await appendShipmentEvent(
        {
          shipmentId: shipment.id,
          eventType: "CANCELLED",
          // Cancelling is a booking act, so it belongs to the counter that
          // took the booking rather than to wherever the actor happens to
          // sit. Nothing has moved yet by definition.
          branchId: shipment.bookingBranchId,
          reasonCodeId: reason.reason.id,
          remarks: input.remarks,
          idempotencyKey: input.idempotencyKey ?? randomUUID(),
          payload: {
            previousStatus: shipment.currentStatus,
            reasonCode: reason.reason.code,
            reasonName: reason.reason.name,
          },
        },
        actor,
        tx,
      );

      if (!event.ok) throw new LifecycleRefusal(event.error);

      // A booking with `pickupRequired` raises a collection of its own, and
      // cancelling the consignment without cancelling that would send a van
      // to an address for goods nobody is going to hand over.
      const { count } = await tx.pickupRequest.updateMany({
        where: {
          shipmentId: shipment.id,
          status: { in: ["REQUESTED", "ASSIGNED", "IN_PROGRESS"] },
        },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });

      return count;
    });

    return { ok: true, lrNumber: shipment.lrNumber, pickupsCancelled };
  } catch (error) {
    return refusalOrThrow(error, "cancelShipment");
  }
}

// ────────────────────────────────────────────────────────────
// Hold and release
// ────────────────────────────────────────────────────────────

export type HoldShipmentInput = {
  shipmentId: string;
  reasonCodeId: string;
  remarks?: string | null;
  /** The branch physically sitting on the freight. Defaults to where it is. */
  branchId?: string | null;
  idempotencyKey?: string;
};

export type HoldResult =
  | { ok: true; lrNumber: string; isOnHold: boolean }
  | { ok: false; error: string; field?: string };

/**
 * Stops a consignment where it stands.
 *
 * A hold is not a status: the goods are exactly where they were, and the
 * consignment carries on being at a hub or on a manifest. `isOnHold` is
 * what dispatch reads before loading, so the projection — set by the HELD
 * event, not by this function — is the whole mechanism.
 */
export async function holdShipment(
  input: HoldShipmentInput,
  actor: SessionUser,
): Promise<HoldResult> {
  if (!can(actor, "shipment.hold")) {
    return { ok: false, error: "You do not have permission to hold a consignment." };
  }

  const loaded = await loadShipment(input.shipmentId, actor);
  if (!loaded.ok) return loaded;
  const { shipment } = loaded;

  if (shipment.isOnHold) {
    return { ok: false, error: "This consignment is already on hold." };
  }

  const reason = await loadReason(input.reasonCodeId, "HOLD", "hold");
  if (!reason.ok) return { ok: false, error: reason.error, field: "reasonCodeId" };

  const branchId = holdBranch(shipment, input.branchId);
  if (branchId && !coversBranch(actor, branchId)) {
    return { ok: false, error: "That branch is outside your scope.", field: "branchId" };
  }

  try {
    await tenantTransaction(async (tx) => {
      const event = await appendShipmentEvent(
        {
          shipmentId: shipment.id,
          eventType: "HELD",
          branchId,
          reasonCodeId: reason.reason.id,
          remarks: input.remarks,
          idempotencyKey: input.idempotencyKey ?? randomUUID(),
          payload: {
            heldAtStatus: shipment.currentStatus,
            reasonCode: reason.reason.code,
            reasonName: reason.reason.name,
          },
        },
        actor,
        tx,
      );

      if (!event.ok) throw new LifecycleRefusal(event.error);
    });

    return { ok: true, lrNumber: shipment.lrNumber, isOnHold: true };
  } catch (error) {
    return refusalOrThrow(error, "holdShipment");
  }
}

export type ReleaseHoldInput = {
  shipmentId: string;
  /** Required: what changed. A hold that lifts itself explains nothing. */
  remarks: string;
  branchId?: string | null;
  idempotencyKey?: string;
};

/**
 * Lifts a hold.
 *
 * The rule asks for no reason code — a release is the end of a reason, not
 * a reason of its own — but it does ask a person to say what changed. The
 * payment landed, the e-way bill arrived, customs signed it off: that
 * sentence is the only thing standing between this and freight that was
 * stopped for a documented cause and quietly let go.
 */
export async function releaseHold(
  input: ReleaseHoldInput,
  actor: SessionUser,
): Promise<HoldResult> {
  if (!can(actor, "shipment.hold")) {
    return { ok: false, error: "You do not have permission to release a hold." };
  }

  const loaded = await loadShipment(input.shipmentId, actor);
  if (!loaded.ok) return loaded;
  const { shipment } = loaded;

  if (!shipment.isOnHold) {
    return { ok: false, error: "This consignment is not on hold." };
  }

  const remarks = (input.remarks ?? "").trim();
  if (remarks.length < 3) {
    return {
      ok: false,
      error: "Say what changed — it goes on the record beside the hold.",
      field: "remarks",
    };
  }

  const branchId = holdBranch(shipment, input.branchId);
  if (branchId && !coversBranch(actor, branchId)) {
    return { ok: false, error: "That branch is outside your scope.", field: "branchId" };
  }

  try {
    await tenantTransaction(async (tx) => {
      const event = await appendShipmentEvent(
        {
          shipmentId: shipment.id,
          eventType: "HOLD_RELEASED",
          branchId,
          remarks,
          idempotencyKey: input.idempotencyKey ?? randomUUID(),
          payload: { releasedAtStatus: shipment.currentStatus },
        },
        actor,
        tx,
      );

      if (!event.ok) throw new LifecycleRefusal(event.error);
    });

    return { ok: true, lrNumber: shipment.lrNumber, isOnHold: false };
  } catch (error) {
    return refusalOrThrow(error, "releaseHold");
  }
}

/** Where the freight is, which is who is sitting on it. */
function holdBranch(
  shipment: LoadedShipment,
  supplied?: string | null,
): string | null {
  return supplied ?? shipment.currentBranchId ?? shipment.originBranchId;
}

// ────────────────────────────────────────────────────────────
// Amend
// ────────────────────────────────────────────────────────────

/**
 * WHAT MAY BE AMENDED, AND WHEN.
 *
 * `BOOKING_AMENDED` is allowed by the state machine for the whole
 * pre-dispatch range. That is the outer bound; within it there are two
 * tiers, and the line between them is custody — whether the carrier is
 * holding the goods.
 *
 * Before pickup (BOOKED, PICKUP_ASSIGNED) the consignment is a piece of
 * paper. Nobody has counted the boxes or put them on a scale, so every
 * figure on it is the consignor's declaration typed by a clerk, and
 * correcting a typo is a booking correction in the plainest sense.
 *
 * After the goods are in the network (PICKED_UP and beyond) the physical
 * facts stop being typeable:
 *
 *   · `packageCount` — the boxes have been counted at handover. A count
 *     that disagrees with the booking is a shortage or an excess, and it is
 *     recorded as one on an inbound receipt with a discrepancy against it.
 *     Editing the booking to match would erase the discrepancy, which is
 *     the whole record of what went wrong.
 *   · `actualWeight` — the hub weighs it, and `captureRevisedWeight` is the
 *     one door that may revise the billed weight: it re-rates, raises a
 *     debit note against an issued invoice, and opens a tolerance
 *     exception. Typing a new weight here would move the number and skip
 *     all three, which is exactly the leak that function was written to
 *     close.
 *   · `consignorAddress` — the van already went there. Where it was
 *     collected from is history, not a field.
 *   · `goodsDescription` — what is in the sealed box is what the e-way bill
 *     and the LR were printed from. Changing the description of freight
 *     already moving is a compliance question, not a correction.
 *
 * What is left, and stays amendable right up to dispatch, is everything
 * that describes *people*: names, companies, phones, emails, GSTINs, the
 * consignee's address and landmark, and the special instructions the
 * delivery agent reads. Those change legitimately while a consignment is in
 * transit — a consignee moves office, a phone number was taken down wrong —
 * and getting them right is how the box arrives.
 *
 * Not amendable at any status, and deliberately absent below: service type,
 * mode, origin and destination branch, either city or PIN code, payment
 * type, COD amount and freight. Those decide the lane, the price and the
 * money. Changing one is a different consignment, and the honest way to do
 * it is to cancel this booking and take a new one.
 */
const PRE_CUSTODY_STATUSES: ShipmentStatus[] = ["BOOKED", "PICKUP_ASSIGNED"];

/** True once the carrier is physically holding the goods. */
export function hasCustody(status: ShipmentStatus): boolean {
  return !PRE_CUSTODY_STATUSES.includes(status);
}

/** Amendable only while the carrier has not yet taken the goods. */
const PRE_CUSTODY_ONLY = [
  "consignorAddress",
  "goodsDescription",
  "packageCount",
  "actualWeight",
] as const;

const PRE_CUSTODY_LABEL: Record<(typeof PRE_CUSTODY_ONLY)[number], string> = {
  consignorAddress:
    "The pickup address cannot change once the goods have been collected — that is where they came from.",
  goodsDescription:
    "What the box contains cannot be re-described after it is in the network.",
  packageCount:
    "The boxes have been counted. A different count is a shortage or an excess, raised on the inbound receipt.",
  actualWeight:
    "Weight is revised at the weighbridge, which re-rates and raises a debit note. Use hub weighment.",
};

export type AmendBookingInput = {
  shipmentId: string;
  /** Omit a field to leave it alone. Null clears an optional one. */
  consignorName?: string;
  consignorCompany?: string | null;
  consignorPhone?: string;
  consignorEmail?: string | null;
  consignorGstin?: string | null;
  consignorAddress?: string;

  consigneeName?: string;
  consigneeCompany?: string | null;
  consigneePhone?: string;
  consigneeEmail?: string | null;
  consigneeGstin?: string | null;
  consigneeAddress?: string;
  consigneeLandmark?: string | null;

  goodsDescription?: string;
  specialInstructions?: string | null;
  packageCount?: number;
  actualWeight?: number;

  /** Why. Not demanded by the rule, asked for anyway. */
  remarks?: string | null;
  idempotencyKey?: string;
};

export type AmendBookingResult =
  | {
      ok: true;
      lrNumber: string;
      changed: string[];
      /** Set when the amendment moved the weight and the price with it. */
      repriced: { from: string; to: string } | null;
      warnings: string[];
    }
  | { ok: false; error: string; field?: string };

export async function amendBooking(
  input: AmendBookingInput,
  actor: SessionUser,
): Promise<AmendBookingResult> {
  if (!can(actor, "shipment.update")) {
    return { ok: false, error: "You do not have permission to amend a booking." };
  }

  const loaded = await loadShipment(input.shipmentId, actor);
  if (!loaded.ok) return loaded;
  const { shipment } = loaded;

  const inCustody = hasCustody(shipment.currentStatus);

  // ── What actually changed ─────────────────────────────────
  const changes: Record<string, string | number | null> = {};
  const before: Record<string, string | number | null> = {};

  for (const [field, next] of Object.entries(input)) {
    if (!AMENDABLE_FIELDS.has(field)) continue;
    if (next === undefined) continue;

    const current = shipment[field as keyof LoadedShipment];
    const currentValue =
      current === null || current === undefined ? null : String(current);
    const nextValue = next === null ? null : String(next);

    // Numbers compare as numbers — "30" and "30.000" are the same weight.
    const same =
      typeof next === "number"
        ? Number(currentValue) === next
        : currentValue === nextValue;
    if (same) continue;

    changes[field] = next as string | number | null;
    before[field] = currentValue;
  }

  if (Object.keys(changes).length === 0) {
    return { ok: false, error: "Nothing was changed." };
  }

  if (inCustody) {
    for (const field of PRE_CUSTODY_ONLY) {
      if (field in changes) {
        return { ok: false, error: PRE_CUSTODY_LABEL[field], field };
      }
    }
  }

  if ("packageCount" in changes) {
    const count = Number(changes.packageCount);
    if (!Number.isInteger(count) || count < 1) {
      return { ok: false, error: "A consignment needs at least one package.", field: "packageCount" };
    }
  }
  if ("actualWeight" in changes) {
    const weight = Number(changes.actualWeight);
    if (!(weight > 0)) {
      return { ok: false, error: "Enter the weight.", field: "actualWeight" };
    }
  }

  const weightMoved = "actualWeight" in changes || "packageCount" in changes;

  try {
    await tenantTransaction(async (tx) => {
      const data: Prisma.ShipmentUpdateInput = { ...changes } as Prisma.ShipmentUpdateInput;

      if ("packageCount" in changes) {
        await resizePackages(tx, shipment, Number(changes.packageCount));
      }

      if (weightMoved) {
        // Recomputed exactly the way booking computes it, from the declared
        // actual and the dimensions on the package rows as they now stand.
        // This is the booking figure being corrected, not a revision of a
        // measured one — the weighbridge remains the only thing that may
        // do that.
        const packages = await tx.shipmentPackage.findMany({
          where: { shipmentId: shipment.id },
          select: { lengthCm: true, breadthCm: true, heightCm: true },
        });

        const weights = chargeableWeight({
          actualWeight:
            "actualWeight" in changes
              ? Number(changes.actualWeight)
              : Number(shipment.actualWeight),
          packages: packages.map((pkg) => ({
            lengthCm: pkg.lengthCm ? Number(pkg.lengthCm) : null,
            breadthCm: pkg.breadthCm ? Number(pkg.breadthCm) : null,
            heightCm: pkg.heightCm ? Number(pkg.heightCm) : null,
          })),
          volumetricDivisor: shipment.serviceType.volumetricDivisor,
        });

        data.actualWeight = weights.actual.toString();
        data.volumetricWeight = weights.volumetric.toString();
        data.chargeableWeight = weights.chargeable.toString();
      }

      await tx.shipment.update({ where: { id: shipment.id }, data });

      const event = await appendShipmentEvent(
        {
          shipmentId: shipment.id,
          eventType: "BOOKING_AMENDED",
          branchId: shipment.bookingBranchId,
          remarks: input.remarks,
          idempotencyKey: input.idempotencyKey ?? randomUUID(),
          payload: {
            amendedAtStatus: shipment.currentStatus,
            fields: Object.keys(changes),
            before,
            after: changes,
          },
        },
        actor,
        tx,
      );

      if (!event.ok) throw new LifecycleRefusal(event.error);
    });
  } catch (error) {
    return refusalOrThrow(error, "amendBooking");
  }

  // ── The money that follows the weight ─────────────────────
  // Outside the transaction on purpose: `rerateShipment` opens its own, and
  // a rate card that cannot be consulted must not undo an amendment the
  // branch has already been told about. Same reasoning as booking, which
  // records a consignment it could not price rather than losing it.
  const warnings: string[] = [];
  let repriced: { from: string; to: string } | null = null;

  if (weightMoved) {
    try {
      const rerated = await rerateShipment(
        {
          shipmentId: shipment.id,
          // The booking stage, not INVOICE: this is still the price at the
          // counter being corrected, and nothing has been billed.
          stage: "BOOKING",
          applyToShipment: true,
          reason: `Booking amended before pickup — ${Object.keys(changes).join(", ")}.`,
        },
        actor,
      );

      if (rerated.ok) {
        repriced = {
          from: rerated.previousTotal.toFixed(2),
          to: rerated.newTotal.toFixed(2),
        };
      } else {
        warnings.push(`The amendment was saved but the freight was not repriced: ${rerated.error}`);
      }
    } catch (error) {
      console.error("[lifecycle] amend reprice", error);
      warnings.push("The amendment was saved but the freight could not be repriced.");
    }
  }

  return {
    ok: true,
    lrNumber: shipment.lrNumber,
    changed: Object.keys(changes),
    repriced,
    warnings,
  };
}

const AMENDABLE_FIELDS = new Set<string>([
  "consignorName",
  "consignorCompany",
  "consignorPhone",
  "consignorEmail",
  "consignorGstin",
  "consignorAddress",
  "consigneeName",
  "consigneeCompany",
  "consigneePhone",
  "consigneeEmail",
  "consigneeGstin",
  "consigneeAddress",
  "consigneeLandmark",
  "goodsDescription",
  "specialInstructions",
  "packageCount",
  "actualWeight",
]);

/**
 * Adds or removes package rows to match a corrected count.
 *
 * Barcodes keep the sequence they were minted with, so a consignment that
 * went from three boxes to five carries -01 … -05 and never reuses a
 * number. Removing only ever takes the tail, and only while every row it
 * would take is still PENDING: a box that has been scanned exists, whatever
 * the booking says.
 */
async function resizePackages(
  tx: Tx,
  shipment: LoadedShipment,
  count: number,
): Promise<void> {
  const packages = await tx.shipmentPackage.findMany({
    where: { shipmentId: shipment.id },
    orderBy: { sequence: "asc" },
    select: { id: true, sequence: true, status: true },
  });

  if (count > packages.length) {
    const highest = packages.at(-1)?.sequence ?? 0;
    const additions = Array.from(
      { length: count - packages.length },
      (_, index) => highest + index + 1,
    );

    await tx.shipmentPackage.createMany({
      data: additions.map((sequence) => ({
        orgId: shipment.orgId,
        shipmentId: shipment.id,
        sequence,
        barcode: `${shipment.lrNumber}-${String(sequence).padStart(2, "0")}`,
        packageTypeId: shipment.packageTypeId ?? undefined,
      })),
    });
    return;
  }

  if (count < packages.length) {
    const removing = packages.slice(count);
    if (removing.some((pkg) => pkg.status !== "PENDING")) {
      throw new LifecycleRefusal(
        "Some of those packages have already been scanned. They cannot be removed from the booking.",
      );
    }

    await tx.shipmentPackage.deleteMany({
      where: { id: { in: removing.map((pkg) => pkg.id) } },
    });
  }
}

// ────────────────────────────────────────────────────────────
// Status correction
// ────────────────────────────────────────────────────────────

/**
 * Statuses a correction may not assert.
 *
 * A correction moves a marker. It cannot manufacture the evidence that
 * these three carry: a delivery has a receiver, a signature or a
 * photograph, and a COD reconciliation behind it, and a POD is a document
 * that either exists or does not. Somebody typing DELIVERED here would
 * close a consignment, stop the SLA clock and satisfy an invoice with
 * nothing at the door to show for it.
 *
 * Correcting *away* from a wrong delivery is allowed and is exactly what
 * this is for; correcting *to* one is not.
 */
export const UNCORRECTABLE_TO: ShipmentStatus[] = [
  "DELIVERED",
  "POD_UPLOADED",
  "RTO_DELIVERED",
];

/** A correction has to be explained, not just reasoned. */
const MIN_CORRECTION_REMARKS = 10;

export type CorrectStatusInput = {
  shipmentId: string;
  correctedTo: ShipmentStatus;
  reasonCodeId: string;
  remarks: string;
  branchId?: string | null;
  idempotencyKey?: string;
};

export type CorrectStatusResult =
  | {
      ok: true;
      lrNumber: string;
      previousStatus: ShipmentStatus;
      currentStatus: ShipmentStatus;
    }
  | { ok: false; error: string; field?: string };

/**
 * Puts a consignment into a status the normal rules cannot reach.
 *
 * The escape hatch, and the most dangerous thing in this file. A scan went
 * onto the wrong LR, an offline device replayed a stale queue, a
 * consignment sits DISPATCHED on a trip that never left — none of those can
 * be undone by any ordinary event, because every ordinary event only moves
 * forwards.
 *
 * So it is gated on `shipment.correct_status`, which is its own sensitive
 * permission held by nobody in the seeded roles except SUPER_ADMIN — not by
 * an operations manager, not by a branch manager — and it demands both a
 * reason code from the STATUS_CORRECTION drawer and a written explanation.
 * The event it writes carries the status it moved away from, so the
 * timeline shows the correction as its own act rather than as a status that
 * silently changed.
 */
export async function correctShipmentStatus(
  input: CorrectStatusInput,
  actor: SessionUser,
): Promise<CorrectStatusResult> {
  if (!can(actor, "shipment.correct_status")) {
    return {
      ok: false,
      error:
        "Correcting a status is a restricted act. This account does not hold that permission.",
    };
  }

  const loaded = await loadShipment(input.shipmentId, actor);
  if (!loaded.ok) return loaded;
  const { shipment } = loaded;

  if (!input.correctedTo) {
    return { ok: false, error: "Choose the status this should be.", field: "correctedTo" };
  }
  if (input.correctedTo === shipment.currentStatus) {
    return {
      ok: false,
      error: `This consignment is already ${humanise(shipment.currentStatus)}.`,
      field: "correctedTo",
    };
  }
  if (UNCORRECTABLE_TO.includes(input.correctedTo)) {
    return {
      ok: false,
      error: `${humanise(input.correctedTo)} is recorded at the door with a receiver and proof. A correction cannot assert it.`,
      field: "correctedTo",
    };
  }

  const reason = await loadReason(
    input.reasonCodeId,
    "STATUS_CORRECTION",
    "status correction",
  );
  if (!reason.ok) return { ok: false, error: reason.error, field: "reasonCodeId" };

  const remarks = (input.remarks ?? "").trim();
  if (remarks.length < MIN_CORRECTION_REMARKS) {
    return {
      ok: false,
      error:
        "Write what went wrong and what the truth is. This entry is the only explanation the record will ever have.",
      field: "remarks",
    };
  }

  const branchId =
    input.branchId ??
    actor.primaryBranch?.id ??
    shipment.currentBranchId ??
    shipment.originBranchId;

  if (branchId && !coversBranch(actor, branchId)) {
    return { ok: false, error: "That branch is outside your scope.", field: "branchId" };
  }

  try {
    const result = await tenantTransaction(async (tx) => {
      const event = await appendShipmentEvent(
        {
          shipmentId: shipment.id,
          eventType: "STATUS_CORRECTED",
          correctedTo: input.correctedTo,
          branchId,
          reasonCodeId: reason.reason.id,
          remarks,
          idempotencyKey: input.idempotencyKey ?? randomUUID(),
          payload: {
            correctedFrom: shipment.currentStatus,
            correctedTo: input.correctedTo,
            reasonCode: reason.reason.code,
            reasonName: reason.reason.name,
          },
        },
        actor,
        tx,
      );

      if (!event.ok) throw new LifecycleRefusal(event.error);
      return event;
    });

    return {
      ok: true,
      lrNumber: shipment.lrNumber,
      previousStatus: result.previousStatus,
      currentStatus: result.currentStatus,
    };
  } catch (error) {
    return refusalOrThrow(error, "correctShipmentStatus");
  }
}

// ────────────────────────────────────────────────────────────
// Refusals
// ────────────────────────────────────────────────────────────

/**
 * A refusal the caller should be told about verbatim.
 *
 * Thrown rather than returned because it happens inside a transaction that
 * has to roll back — a refused transition must leave nothing behind, which
 * is how `PICKUP_ATTEMPTED` went missing for months.
 */
class LifecycleRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleRefusal";
  }
}

function refusalOrThrow(
  error: unknown,
  where: string,
): { ok: false; error: string } {
  if (error instanceof LifecycleRefusal) {
    return { ok: false, error: error.message };
  }

  // Prisma's messages name models, columns and constraints; a tenant error
  // names two organisation ids. Neither belongs in front of a clerk.
  console.error(`[lifecycle] ${where}`, error);
  return { ok: false, error: "That could not be saved. Nothing was changed." };
}
