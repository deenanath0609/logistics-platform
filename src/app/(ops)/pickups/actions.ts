"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { recordAudit } from "@/server/services/audit";
import { appendShipmentEvent } from "@/lib/shipment/events";
import { canReassign } from "@/lib/pickup/assignment";
import { cancelPickupRequest } from "@/lib/pickup/cancel";
import { pickupRequestSchema, raisePickupRequest } from "@/lib/pickup/request";
import type { ActionState } from "@/server/services/master-crud";

const PATH = "/pickups";

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

function describe(error: unknown): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to do that.";
  }
  console.error("[pickups]", error);
  return "Something went wrong. Nothing was saved.";
}

/**
 * Raising a collection by hand — the consignor who telephones.
 *
 * The validation and the write are in `lib/pickup/request.ts`, so the screen
 * and the verification suite go through the same code. This is the form
 * boundary: authorise, parse, audit, revalidate.
 */
export async function createPickupRequest(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("pickup.create");

    const parsed = pickupRequestSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const created = await raisePickupRequest(parsed.data, actor);
    if (!created.ok) return { error: created.error };

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "PickupRequest",
      entityId: created.id,
      entityRef: created.number,
      branchId: created.branchId,
      after: { ...parsed.data, number: created.number },
    });

    revalidatePath(PATH);
    return { ok: true, message: `Pickup ${created.number} raised.` };
  } catch (error) {
    return { error: describe(error) };
  }
}

const assignSchema = z.object({
  pickupRequestId: z.string().min(1),
  assignedToId: z.string().min(1, "Choose an executive"),
  sequence: z.coerce.number().int().min(0).max(999),
});

export async function assignPickup(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("pickup.assign");

    const parsed = assignSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const { pickupRequestId, assignedToId, sequence } = parsed.data;

    const request = await prisma.pickupRequest.findUnique({
      where: { id: pickupRequestId },
      include: { assignments: { where: { supersededAt: null } } },
    });
    if (!request) return { error: "That pickup no longer exists." };
    if (!coversBranch(actor, request.branchId)) {
      return { error: "That pickup is outside your scope." };
    }

    const reassignable = canReassign(request.status);
    if (!reassignable.ok) return { error: reassignable.reason };

    // The picker only offers active field users, but the picker is not the
    // boundary: a form left open while somebody was deactivated would
    // otherwise hand a live pickup to an account that can no longer sign
    // in, and the request would sit at ASSIGNED with nobody coming.
    // `createDeliveryRun` makes the same check for delivery agents.
    const assignee = await prisma.user.findUnique({
      where: { id: assignedToId },
      select: { name: true, isFieldUser: true, status: true, deletedAt: true },
    });
    if (
      !assignee ||
      assignee.deletedAt ||
      assignee.status !== "ACTIVE" ||
      !assignee.isFieldUser
    ) {
      return { error: "That executive is no longer available." };
    }

    await tenantTransaction(async (tx) => {
      // Supersede rather than overwrite: who held this task and when has
      // to survive a reassignment.
      await tx.pickupAssignment.updateMany({
        where: { pickupRequestId, supersededAt: null },
        data: { supersededAt: new Date() },
      });

      await tx.pickupAssignment.create({
        data: {
          orgId: actor.orgId,
          pickupRequestId,
          assignedToId,
          sequence,
          assignedById: actor.id,
        },
      });

      await tx.pickupRequest.update({
        where: { id: pickupRequestId },
        data: { status: "ASSIGNED" },
      });
    });

    // A pickup against a booked shipment moves the shipment too. Raised
    // through the state machine, never by writing currentStatus.
    if (request.shipmentId) {
      const event = await appendShipmentEvent(
        {
          shipmentId: request.shipmentId,
          eventType: "PICKUP_ASSIGNED",
          branchId: request.branchId,
          payload: { pickupNumber: request.number, assignedToId },
        },
        actor,
      );

      if (!event.ok && event.code !== "INVALID_TRANSITION") {
        return { error: event.error };
      }
    }

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "PickupRequest",
      entityId: pickupRequestId,
      entityRef: request.number,
      branchId: request.branchId,
      before: { status: request.status },
      after: { status: "ASSIGNED", assignedToId },
    });

    revalidatePath(PATH);
    return {
      ok: true,
      message: `${request.number} assigned to ${assignee.name}.`,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

const cancelSchema = z.object({
  id: z.string().min(1, "Nothing selected."),
  reason: z
    .string()
    .trim()
    .min(3, "Give a reason — it goes on the record.")
    .max(300),
});

/**
 * Calling a collection off.
 *
 * The work is in `lib/pickup/cancel.ts`, which is also where the reasoning
 * lives — including why a cancelled pickup leaves its consignment reading
 * `PICKUP_ASSIGNED`. This is the form boundary: authorise, parse, audit,
 * revalidate.
 */
export async function cancelPickup(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("pickup.cancel");

    const parsed = cancelSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Give a reason — it goes on the record.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const { id, reason } = parsed.data;

    const result = await cancelPickupRequest(
      { pickupRequestId: id, reason },
      actor,
    );
    if (!result.ok) return { error: result.error };

    await recordAudit({
      user: actor,
      action: "CANCEL",
      entity: "PickupRequest",
      entityId: id,
      entityRef: result.number,
      branchId: result.branchId,
      reason,
      before: {
        status: result.previousStatus,
        assignedTo: result.unassigned,
      },
      after: { status: "CANCELLED", assignedTo: [] },
    });

    revalidatePath(PATH);
    return { ok: true, message: `${result.number} cancelled.` };
  } catch (error) {
    return { error: describe(error) };
  }
}
