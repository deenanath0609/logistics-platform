"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { recordAudit } from "@/server/services/audit";
import { nextNumber } from "@/lib/numbering/number-series";
import { appendShipmentEvent } from "@/lib/shipment/events";
import { canReassign } from "@/lib/pickup/assignment";
import type { ActionState } from "@/server/services/master-crud";

const PATH = "/pickups";

const optional = (max = 200) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable(),
  );

const requestSchema = z.object({
  shipmentId: optional(40),
  customerId: optional(40),
  branchId: z.string().min(1, "Choose a branch"),
  contactName: z.string().trim().min(2, "Required").max(120),
  phone: z.string().trim().regex(/^\d{10}$/, "Ten digits"),
  address: z.string().trim().min(4, "Required").max(300),
  cityId: z.string().min(1, "Choose a city"),
  pincode: z.string().trim().regex(/^\d{6}$/, "Six digits"),
  landmark: optional(120),
  requestedDate: z.coerce.date({ message: "Enter a valid date" }),
  slot: z.enum(["MORNING", "AFTERNOON", "EVENING", "ANYTIME"]),
  priority: z.coerce.number().int().min(0).max(9),
  expectedPackages: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().int().min(1).nullable(),
  ),
  expectedWeight: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().min(0).nullable(),
  ),
  goodsDescription: optional(300),
  notes: optional(300),
});

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

export async function createPickupRequest(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("pickup.create");

    const parsed = requestSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const data = parsed.data;
    if (!coversBranch(actor, data.branchId)) {
      return { error: "That branch is outside your scope." };
    }

    const created = await tenantTransaction(async (tx) => {
      // Numbered inside the transaction, so an abandoned request does not
      // consume a number.
      const number = await nextNumber(
        { document: "PICKUP" },
        tx,
      );

      return tx.pickupRequest.create({
        data: { ...data, number, orgId: actor.orgId, createdById: actor.id },
      });
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "PickupRequest",
      entityId: created.id,
      entityRef: created.number,
      branchId: created.branchId,
      after: created,
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

export async function cancelPickup(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("pickup.cancel");

    const id = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();

    if (!id) return { error: "Nothing selected." };
    if (reason.length < 3) {
      return {
        error: "Give a reason — it goes on the record.",
        fieldErrors: { reason: "Required" },
      };
    }

    const request = await prisma.pickupRequest.findUnique({ where: { id } });
    if (!request) return { error: "That pickup no longer exists." };
    if (!coversBranch(actor, request.branchId)) {
      return { error: "That pickup is outside your scope." };
    }
    if (request.status === "COMPLETED") {
      return { error: "That pickup has already been collected." };
    }

    await prisma.pickupRequest.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date(), notes: reason },
    });

    await recordAudit({
      user: actor,
      action: "CANCEL",
      entity: "PickupRequest",
      entityId: id,
      entityRef: request.number,
      branchId: request.branchId,
      reason,
      before: { status: request.status },
      after: { status: "CANCELLED" },
    });

    revalidatePath(PATH);
    return { ok: true, message: `${request.number} cancelled.` };
  } catch (error) {
    return { error: describe(error) };
  }
}
