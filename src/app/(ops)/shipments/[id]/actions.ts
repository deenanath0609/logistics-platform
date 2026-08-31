"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import { recordAudit } from "@/server/services/audit";
import {
  amendBooking,
  cancelShipment,
  correctShipmentStatus,
  holdShipment,
  releaseHold,
} from "@/lib/shipment/lifecycle";
import { STATUS_LABELS, humanise } from "@/lib/shipment/state-machine";
import type { ShipmentStatus } from "@/generated/prisma/client";
import type { ActionState } from "@/server/services/master-crud";

/**
 * The consignment's own lifecycle, from the detail page.
 *
 * Thin on purpose. Each one authorises, parses, hands the work to
 * `src/lib/shipment/lifecycle.ts`, writes the audit row and revalidates —
 * the decisions all live in the service, which is what the verification
 * script drives and what any other surface would call.
 */

const PATH = "/shipments";

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

function describe(error: unknown, where: string): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to do that.";
  }
  console.error(`[shipments/${where}]`, error);
  return "Something went wrong. Nothing was saved.";
}

function revalidate(shipmentId: string) {
  revalidatePath(`${PATH}/${shipmentId}`);
  revalidatePath(PATH);
}

const optionalText = (max = 300) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable(),
  );

// ────────────────────────────────────────────────────────────
// Cancel
// ────────────────────────────────────────────────────────────

const cancelSchema = z.object({
  shipmentId: z.string().min(1),
  reasonCodeId: z.string().min(1, "Choose a reason"),
  remarks: optionalText(300),
});

export async function cancelShipmentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("shipment.cancel");

    const parsed = cancelSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await cancelShipment(parsed.data, actor);
    if (!result.ok) {
      return {
        error: result.error,
        fieldErrors: result.field ? { [result.field]: result.error } : undefined,
      };
    }

    await recordAudit({
      user: actor,
      action: "CANCEL",
      entity: "Shipment",
      entityId: parsed.data.shipmentId,
      entityRef: result.lrNumber,
      after: { currentStatus: "CANCELLED" },
      reason: parsed.data.remarks ?? "Booking cancelled.",
    });

    revalidate(parsed.data.shipmentId);
    return {
      ok: true,
      message:
        result.pickupsCancelled > 0
          ? `${result.lrNumber} cancelled, and the collection with it.`
          : `${result.lrNumber} cancelled.`,
    };
  } catch (error) {
    return { error: describe(error, "cancel") };
  }
}

// ────────────────────────────────────────────────────────────
// Hold and release
// ────────────────────────────────────────────────────────────

const holdSchema = z.object({
  shipmentId: z.string().min(1),
  reasonCodeId: z.string().min(1, "Choose a reason"),
  remarks: optionalText(300),
});

export async function holdShipmentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("shipment.hold");

    const parsed = holdSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await holdShipment(parsed.data, actor);
    if (!result.ok) {
      return {
        error: result.error,
        fieldErrors: result.field ? { [result.field]: result.error } : undefined,
      };
    }

    await recordAudit({
      user: actor,
      action: "STATUS_CHANGE",
      entity: "Shipment",
      entityId: parsed.data.shipmentId,
      entityRef: result.lrNumber,
      before: { isOnHold: false },
      after: { isOnHold: true },
      reason: parsed.data.remarks ?? "Placed on hold.",
    });

    revalidate(parsed.data.shipmentId);
    return { ok: true, message: `${result.lrNumber} is on hold. Dispatch will not load it.` };
  } catch (error) {
    return { error: describe(error, "hold") };
  }
}

const releaseSchema = z.object({
  shipmentId: z.string().min(1),
  remarks: z.string().trim().min(3, "Say what changed"),
});

export async function releaseHoldAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("shipment.hold");

    const parsed = releaseSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await releaseHold(parsed.data, actor);
    if (!result.ok) {
      return {
        error: result.error,
        fieldErrors: result.field ? { [result.field]: result.error } : undefined,
      };
    }

    await recordAudit({
      user: actor,
      action: "STATUS_CHANGE",
      entity: "Shipment",
      entityId: parsed.data.shipmentId,
      entityRef: result.lrNumber,
      before: { isOnHold: true },
      after: { isOnHold: false },
      reason: parsed.data.remarks,
    });

    revalidate(parsed.data.shipmentId);
    return { ok: true, message: `The hold on ${result.lrNumber} is lifted.` };
  } catch (error) {
    return { error: describe(error, "release") };
  }
}

// ────────────────────────────────────────────────────────────
// Amend
// ────────────────────────────────────────────────────────────

/**
 * A blank box means "leave it alone", not "clear it".
 *
 * The form posts every field it renders, so an untouched optional input
 * arrives as an empty string. Treating that as null would wipe a company
 * name nobody meant to touch, so blanks are dropped before the service ever
 * sees them and clearing an optional field is simply not offered here.
 */
const amendText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

const amendNumber = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
  z.number().optional(),
);

const amendSchema = z.object({
  shipmentId: z.string().min(1),

  consignorName: amendText(120),
  consignorCompany: amendText(160),
  consignorPhone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().regex(/^\d{10}$/, "Ten digits").optional(),
  ),
  consignorEmail: amendText(160),
  consignorGstin: amendText(20),
  consignorAddress: amendText(300),

  consigneeName: amendText(120),
  consigneeCompany: amendText(160),
  consigneePhone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().regex(/^\d{10}$/, "Ten digits").optional(),
  ),
  consigneeEmail: amendText(160),
  consigneeGstin: amendText(20),
  consigneeAddress: amendText(300),
  consigneeLandmark: amendText(120),

  goodsDescription: amendText(300),
  specialInstructions: amendText(300),
  packageCount: amendNumber,
  actualWeight: amendNumber,

  remarks: optionalText(300),
});

export async function amendBookingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("shipment.update");

    const parsed = amendSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await amendBooking(parsed.data, actor);
    if (!result.ok) {
      return {
        error: result.error,
        fieldErrors: result.field ? { [result.field]: result.error } : undefined,
      };
    }

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "Shipment",
      entityId: parsed.data.shipmentId,
      entityRef: result.lrNumber,
      after: { amended: result.changed },
      reason: parsed.data.remarks ?? `Booking amended — ${result.changed.join(", ")}.`,
    });

    revalidate(parsed.data.shipmentId);

    const priced = result.repriced
      ? ` Freight ₹${result.repriced.from} → ₹${result.repriced.to}.`
      : "";

    return {
      ok: true,
      message:
        `${result.changed.length} field${result.changed.length === 1 ? "" : "s"} amended on ${result.lrNumber}.` +
        priced +
        (result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : ""),
    };
  } catch (error) {
    return { error: describe(error, "amend") };
  }
}

// ────────────────────────────────────────────────────────────
// Status correction
// ────────────────────────────────────────────────────────────

const STATUSES = Object.keys(STATUS_LABELS) as [ShipmentStatus, ...ShipmentStatus[]];

const correctSchema = z.object({
  shipmentId: z.string().min(1),
  correctedTo: z.enum(STATUSES),
  reasonCodeId: z.string().min(1, "Choose a reason"),
  remarks: z.string().trim().min(10, "Explain what went wrong"),
});

/**
 * The dangerous one.
 *
 * `authorize` refuses anyone without `shipment.correct_status` before a
 * single field is read, the service refuses again, and the result is
 * audited as an OVERRIDE carrying both statuses and the explanation —
 * because this is the one act in the product that changes what the record
 * says happened without anything having happened.
 */
export async function correctStatusAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("shipment.correct_status");

    const parsed = correctSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await correctShipmentStatus(parsed.data, actor);
    if (!result.ok) {
      return {
        error: result.error,
        fieldErrors: result.field ? { [result.field]: result.error } : undefined,
      };
    }

    await recordAudit({
      user: actor,
      action: "OVERRIDE",
      entity: "Shipment",
      entityId: parsed.data.shipmentId,
      entityRef: result.lrNumber,
      before: { currentStatus: result.previousStatus },
      after: { currentStatus: result.currentStatus },
      reason: `Status corrected by hand: ${parsed.data.remarks}`,
    });

    revalidate(parsed.data.shipmentId);
    return {
      ok: true,
      message: `${result.lrNumber} corrected from ${humanise(result.previousStatus)} to ${humanise(result.currentStatus)}.`,
    };
  } catch (error) {
    return { error: describe(error, "correct-status") };
  }
}
