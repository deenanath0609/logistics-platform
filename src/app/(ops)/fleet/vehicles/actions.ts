"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { VehicleStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { authorize } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { recordAudit, changedFields } from "@/server/services/audit";
import {
  zBool,
  zOptionalInt,
  zOptionalText,
  type ActionState,
} from "@/server/services/master-crud";
import { zOptionalDate, zRegistration } from "@/lib/fleet/form";
import { formatRegistration } from "@/lib/fleet/registration";
import { DOCUMENT_LABELS, VEHICLE_DOCUMENT_KINDS } from "@/lib/fleet/documents";
import {
  checkHomeBranch,
  describeFleetError,
  fieldErrors,
} from "../action-support";

const PATH = "/fleet/vehicles";

/**
 * The statuses a person is allowed to set by hand.
 *
 * Everything between Assigned and Unloading is produced by trip events, and
 * letting the fleet screen write them would put a second author on the
 * vehicle state machine — the same mistake the shipment spine exists to
 * prevent (docs/BRD.html §A.1). Taking a vehicle off the road, or putting it
 * back, is a human decision and stays here.
 */
const MANUAL_STATUSES = ["AVAILABLE", "MAINTENANCE", "INACTIVE"] as const;

const ALL_STATUSES = [
  "AVAILABLE",
  "ASSIGNED",
  "LOADING",
  "DISPATCHED",
  "IN_TRANSIT",
  "AT_HUB",
  "UNLOADING",
  "MAINTENANCE",
  "INACTIVE",
] as const;

const CURRENT_YEAR = new Date().getUTCFullYear();

const vehicleSchema = z.object({
  registrationNumber: zRegistration(),
  vehicleTypeId: z.string().min(1, "Choose a vehicle type"),
  ownership: z.enum(["OWN", "VENDOR", "ATTACHED"], {
    message: "Choose an ownership",
  }),
  branchId: zOptionalText(40),
  status: z.enum(ALL_STATUSES, { message: "Choose a status" }),
  make: zOptionalText(60),
  model: zOptionalText(60),
  manufactureYear: zOptionalInt(1970, CURRENT_YEAR + 1),
  gpsDeviceId: zOptionalText(80),
  fastagId: zOptionalText(80),
  currentOdometerKm: zOptionalInt(0, 9_999_999),
  notes: zOptionalText(500),
  isActive: zBool,
});

function isManual(status: VehicleStatus): boolean {
  return (MANUAL_STATUSES as readonly string[]).includes(status);
}

export async function createVehicle(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("vehicle.create");

    const parsed = vehicleSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const data = parsed.data;

    const branchProblem = checkHomeBranch(actor, data.branchId);
    if (branchProblem) {
      return { error: branchProblem, fieldErrors: { branchId: branchProblem } };
    }

    if (!isManual(data.status)) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: {
          status:
            "A new vehicle starts available, in maintenance, or inactive. Trip statuses are set by trip events.",
        },
      };
    }

    const created = await prisma.vehicle.create({
      data: { ...data, orgId: actor.orgId },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Vehicle",
      entityId: created.id,
      entityRef: created.registrationNumber,
      branchId: created.branchId,
      after: created,
    });

    revalidatePath(PATH);
    return {
      ok: true,
      message: `${formatRegistration(created.registrationNumber)} added to the fleet.`,
    };
  } catch (error) {
    return { error: describeFleetError(error, "Vehicle") };
  }
}

export async function updateVehicle(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("vehicle.update");

    const id = String(formData.get("id") ?? "");
    if (!id) return { error: "Nothing selected to update." };

    const parsed = vehicleSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const data = parsed.data;

    const branchProblem = checkHomeBranch(actor, data.branchId);
    if (branchProblem) {
      return { error: branchProblem, fieldErrors: { branchId: branchProblem } };
    }

    const before = await prisma.vehicle.findUnique({ where: { id } });
    if (!before || before.deletedAt) {
      return { error: "That vehicle no longer exists." };
    }
    if (before.branchId && !coversBranch(actor, before.branchId)) {
      return { error: "That vehicle is outside your scope." };
    }

    // The status may be left where the trip machine put it, or moved to one
    // of the manual states — but it may not be pushed into a trip state.
    if (data.status !== before.status && !isManual(data.status)) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: {
          status:
            "Trip statuses are set by trip events, not here. Choose available, maintenance or inactive.",
        },
      };
    }

    const after = await prisma.vehicle.update({ where: { id }, data });
    const diff = changedFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );

    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        user: actor,
        action: "UPDATE",
        entity: "Vehicle",
        entityId: id,
        entityRef: after.registrationNumber,
        branchId: after.branchId,
        before: diff.before,
        after: diff.after,
      });
    }

    revalidatePath(PATH);
    revalidatePath(`${PATH}/${id}`);
    return {
      ok: true,
      message: `${formatRegistration(after.registrationNumber)} updated.`,
    };
  } catch (error) {
    return { error: describeFleetError(error, "Vehicle") };
  }
}

/**
 * Vehicles are deactivated, never deleted — a sold truck still appears on
 * last year's trip sheets and its documents are part of that record.
 */
export async function setVehicleActive(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("vehicle.delete");

    const id = String(formData.get("id") ?? "");
    const isActive = formData.get("isActive") === "true";
    if (!id) return { error: "Nothing selected." };

    const before = await prisma.vehicle.findUnique({ where: { id } });
    if (!before || before.deletedAt) {
      return { error: "That vehicle no longer exists." };
    }
    if (before.branchId && !coversBranch(actor, before.branchId)) {
      return { error: "That vehicle is outside your scope." };
    }

    // Pulling a vehicle out of the pool while it is mid-trip would strand
    // the shipments on board without any record of why.
    if (!isActive && !isManual(before.status)) {
      return {
        error:
          "This vehicle is on an open trip. Close the trip before deactivating it.",
      };
    }

    const after = await prisma.vehicle.update({
      where: { id },
      data: {
        isActive,
        status: isActive ? "AVAILABLE" : "INACTIVE",
      },
    });

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "Vehicle",
      entityId: id,
      entityRef: after.registrationNumber,
      branchId: after.branchId,
      before: { isActive: before.isActive, status: before.status },
      after: { isActive: after.isActive, status: after.status },
      reason: isActive ? "Returned to the fleet" : "Withdrawn from the fleet",
    });

    revalidatePath(PATH);
    revalidatePath(`${PATH}/${id}`);
    return {
      ok: true,
      message: `${formatRegistration(after.registrationNumber)} ${
        isActive ? "returned to the fleet" : "withdrawn from the fleet"
      }.`,
    };
  } catch (error) {
    return { error: describeFleetError(error, "Vehicle") };
  }
}

// ────────────────────────────────────────────────────────────
// Documents
// ────────────────────────────────────────────────────────────

const documentSchema = z
  .object({
    vehicleId: z.string().min(1),
    kind: z.enum(VEHICLE_DOCUMENT_KINDS, { message: "Choose a document" }),
    documentNumber: zOptionalText(80),
    issuedOn: zOptionalDate(),
    expiresOn: zOptionalDate(),
    isMandatory: zBool,
    notes: zOptionalText(300),
  })
  .refine(
    (value) =>
      !value.issuedOn ||
      !value.expiresOn ||
      value.expiresOn.getTime() >= value.issuedOn.getTime(),
    { path: ["expiresOn"], message: "Expiry cannot be before the issue date" },
  );

async function loadVehicleForWrite(actor: Awaited<ReturnType<typeof authorize>>, vehicleId: string) {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: {
      id: true,
      registrationNumber: true,
      branchId: true,
      deletedAt: true,
    },
  });
  if (!vehicle || vehicle.deletedAt) return { error: "That vehicle no longer exists." } as const;
  if (vehicle.branchId && !coversBranch(actor, vehicle.branchId)) {
    return { error: "That vehicle is outside your scope." } as const;
  }
  return { vehicle } as const;
}

/**
 * Creates or amends one document.
 *
 * One action for both because the form is the same and the interesting part
 * — the expiry date that decides whether the vehicle may move — is
 * identical either way.
 */
export async function saveVehicleDocument(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("vehicle.update");

    const parsed = documentSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const { vehicleId, ...data } = parsed.data;
    const loaded = await loadVehicleForWrite(actor, vehicleId);
    if ("error" in loaded) return { error: loaded.error };

    const id = String(formData.get("id") ?? "");
    const label = DOCUMENT_LABELS[data.kind];

    if (id) {
      const before = await prisma.vehicleDocument.findUnique({ where: { id } });
      if (!before || before.vehicleId !== vehicleId) {
        return { error: "That document no longer exists." };
      }

      const after = await prisma.vehicleDocument.update({
        where: { id },
        data,
      });
      const diff = changedFields(
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
      );

      if (Object.keys(diff.after).length > 0) {
        await recordAudit({
          user: actor,
          action: "UPDATE",
          entity: "VehicleDocument",
          entityId: id,
          entityRef: `${loaded.vehicle.registrationNumber} · ${label}`,
          branchId: loaded.vehicle.branchId,
          before: diff.before,
          after: diff.after,
        });
      }

      revalidatePath(`${PATH}/${vehicleId}`);
      revalidatePath("/fleet/expiries");
      return { ok: true, message: `${label} updated.` };
    }

    const created = await prisma.vehicleDocument.create({
      data: { ...data, vehicleId },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "VehicleDocument",
      entityId: created.id,
      entityRef: `${loaded.vehicle.registrationNumber} · ${label}`,
      branchId: loaded.vehicle.branchId,
      after: created,
    });

    revalidatePath(`${PATH}/${vehicleId}`);
    revalidatePath("/fleet/expiries");
    return { ok: true, message: `${label} recorded.` };
  } catch (error) {
    return { error: describeFleetError(error, "Vehicle document") };
  }
}

export async function deleteVehicleDocument(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("vehicle.update");

    const id = String(formData.get("id") ?? "");
    const vehicleId = String(formData.get("vehicleId") ?? "");
    if (!id || !vehicleId) return { error: "Nothing selected." };

    const loaded = await loadVehicleForWrite(actor, vehicleId);
    if ("error" in loaded) return { error: loaded.error };

    const before = await prisma.vehicleDocument.findUnique({ where: { id } });
    if (!before || before.vehicleId !== vehicleId) {
      return { error: "That document no longer exists." };
    }

    await prisma.vehicleDocument.delete({ where: { id } });

    const label = DOCUMENT_LABELS[before.kind];
    await recordAudit({
      user: actor,
      action: "DELETE",
      entity: "VehicleDocument",
      entityId: id,
      entityRef: `${loaded.vehicle.registrationNumber} · ${label}`,
      branchId: loaded.vehicle.branchId,
      before,
      reason: "Document removed from the vehicle",
    });

    revalidatePath(`${PATH}/${vehicleId}`);
    revalidatePath("/fleet/expiries");
    return { ok: true, message: `${label} removed.` };
  } catch (error) {
    return { error: describeFleetError(error, "Vehicle document") };
  }
}
