"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { DriverStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { authorize } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { recordAudit, changedFields } from "@/server/services/audit";
import {
  zBool,
  zCode,
  zOptionalText,
  type ActionState,
} from "@/server/services/master-crud";
import { zMobile, zOptionalDate, zOptionalMobile } from "@/lib/fleet/form";
import { DOCUMENT_LABELS, DRIVER_DOCUMENT_KINDS } from "@/lib/fleet/documents";
import {
  checkHomeBranch,
  describeFleetError,
  fieldErrors,
} from "../action-support";

const PATH = "/fleet/drivers";

/**
 * `ON_TRIP` is absent deliberately: it is written when a driver is put on a
 * trip and cleared when the trip closes. Everything else — available, on
 * leave, suspended — is a decision somebody makes on this screen.
 */
const MANUAL_STATUSES = [
  "AVAILABLE",
  "ON_LEAVE",
  "SUSPENDED",
  "INACTIVE",
] as const;

const ALL_STATUSES = [
  "AVAILABLE",
  "ON_TRIP",
  "ON_LEAVE",
  "SUSPENDED",
  "INACTIVE",
] as const;

const driverSchema = z.object({
  code: zCode(2, 20),
  name: z.string().trim().min(2, "Required").max(120),
  mobile: zMobile(),
  altMobile: zOptionalMobile(),
  branchId: zOptionalText(40),
  licenceNumber: zOptionalText(40),
  licenceClass: zOptionalText(40),
  licenceExpiry: zOptionalDate(),
  bloodGroup: zOptionalText(10),
  emergencyContactName: zOptionalText(120),
  emergencyContactPhone: zOptionalText(20),
  address: zOptionalText(300),
  status: z.enum(ALL_STATUSES, { message: "Choose a status" }),
  notes: zOptionalText(500),
  isActive: zBool,
});

function isManual(status: DriverStatus): boolean {
  return (MANUAL_STATUSES as readonly string[]).includes(status);
}

export async function createDriver(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("driver.create");

    const parsed = driverSchema.safeParse(
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
          status: "On-trip is set when the driver is assigned to a trip.",
        },
      };
    }

    const created = await prisma.driver.create({
      data: { ...data, orgId: actor.orgId },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Driver",
      entityId: created.id,
      entityRef: created.code,
      branchId: created.branchId,
      after: created,
    });

    revalidatePath(PATH);
    return { ok: true, message: `${created.name} added.` };
  } catch (error) {
    return { error: describeFleetError(error, "Driver") };
  }
}

export async function updateDriver(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("driver.update");

    const id = String(formData.get("id") ?? "");
    if (!id) return { error: "Nothing selected to update." };

    const parsed = driverSchema.safeParse(
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

    const before = await prisma.driver.findUnique({ where: { id } });
    if (!before || before.deletedAt) {
      return { error: "That driver no longer exists." };
    }
    if (before.branchId && !coversBranch(actor, before.branchId)) {
      return { error: "That driver is outside your scope." };
    }

    if (data.status !== before.status && !isManual(data.status)) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: {
          status: "On-trip is set when the driver is assigned to a trip.",
        },
      };
    }

    const after = await prisma.driver.update({ where: { id }, data });
    const diff = changedFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );

    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        user: actor,
        // Suspending someone is a different kind of event from correcting
        // their blood group, and the audit trail should say which happened.
        action: diff.after.status ? "STATUS_CHANGE" : "UPDATE",
        entity: "Driver",
        entityId: id,
        entityRef: after.code,
        branchId: after.branchId,
        before: diff.before,
        after: diff.after,
        reason: diff.after.status
          ? `Status set to ${String(diff.after.status)}`
          : undefined,
      });
    }

    revalidatePath(PATH);
    revalidatePath(`${PATH}/${id}`);
    return { ok: true, message: `${after.name} updated.` };
  } catch (error) {
    return { error: describeFleetError(error, "Driver") };
  }
}

/** Drivers are deactivated, never deleted — their trip history outlives them. */
export async function setDriverActive(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("driver.delete");

    const id = String(formData.get("id") ?? "");
    const isActive = formData.get("isActive") === "true";
    if (!id) return { error: "Nothing selected." };

    const before = await prisma.driver.findUnique({ where: { id } });
    if (!before || before.deletedAt) {
      return { error: "That driver no longer exists." };
    }
    if (before.branchId && !coversBranch(actor, before.branchId)) {
      return { error: "That driver is outside your scope." };
    }

    if (!isActive && before.status === "ON_TRIP") {
      return {
        error:
          "This driver is on an open trip. Close the trip before deactivating them.",
      };
    }

    const after = await prisma.driver.update({
      where: { id },
      data: { isActive, status: isActive ? "AVAILABLE" : "INACTIVE" },
    });

    await recordAudit({
      user: actor,
      action: "STATUS_CHANGE",
      entity: "Driver",
      entityId: id,
      entityRef: after.code,
      branchId: after.branchId,
      before: { isActive: before.isActive, status: before.status },
      after: { isActive: after.isActive, status: after.status },
      reason: isActive ? "Reinstated" : "Deactivated",
    });

    revalidatePath(PATH);
    revalidatePath(`${PATH}/${id}`);
    return {
      ok: true,
      message: `${after.name} ${isActive ? "reinstated" : "deactivated"}.`,
    };
  } catch (error) {
    return { error: describeFleetError(error, "Driver") };
  }
}

// ────────────────────────────────────────────────────────────
// Documents
// ────────────────────────────────────────────────────────────

const documentSchema = z
  .object({
    driverId: z.string().min(1),
    kind: z.enum(DRIVER_DOCUMENT_KINDS, { message: "Choose a document" }),
    documentNumber: zOptionalText(80),
    issuedOn: zOptionalDate(),
    expiresOn: zOptionalDate(),
    isMandatory: zBool,
  })
  .refine(
    (value) =>
      !value.issuedOn ||
      !value.expiresOn ||
      value.expiresOn.getTime() >= value.issuedOn.getTime(),
    { path: ["expiresOn"], message: "Expiry cannot be before the issue date" },
  );

async function loadDriverForWrite(
  actor: Awaited<ReturnType<typeof authorize>>,
  driverId: string,
) {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { id: true, code: true, name: true, branchId: true, deletedAt: true },
  });
  if (!driver || driver.deletedAt) {
    return { error: "That driver no longer exists." } as const;
  }
  if (driver.branchId && !coversBranch(actor, driver.branchId)) {
    return { error: "That driver is outside your scope." } as const;
  }
  return { driver } as const;
}

export async function saveDriverDocument(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("driver.update");

    const parsed = documentSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const { driverId, ...data } = parsed.data;
    const loaded = await loadDriverForWrite(actor, driverId);
    if ("error" in loaded) return { error: loaded.error };

    const id = String(formData.get("id") ?? "");
    const label = DOCUMENT_LABELS[data.kind];

    if (id) {
      const before = await prisma.driverDocument.findUnique({ where: { id } });
      if (!before || before.driverId !== driverId) {
        return { error: "That document no longer exists." };
      }

      const after = await prisma.driverDocument.update({
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
          entity: "DriverDocument",
          entityId: id,
          entityRef: `${loaded.driver.code} · ${label}`,
          branchId: loaded.driver.branchId,
          before: diff.before,
          after: diff.after,
        });
      }

      revalidatePath(`${PATH}/${driverId}`);
      revalidatePath("/fleet/expiries");
      return { ok: true, message: `${label} updated.` };
    }

    const created = await prisma.driverDocument.create({
      data: { ...data, orgId: actor.orgId, driverId },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "DriverDocument",
      entityId: created.id,
      entityRef: `${loaded.driver.code} · ${label}`,
      branchId: loaded.driver.branchId,
      after: created,
    });

    revalidatePath(`${PATH}/${driverId}`);
    revalidatePath("/fleet/expiries");
    return { ok: true, message: `${label} recorded.` };
  } catch (error) {
    return { error: describeFleetError(error, "Driver document") };
  }
}

export async function deleteDriverDocument(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("driver.update");

    const id = String(formData.get("id") ?? "");
    const driverId = String(formData.get("driverId") ?? "");
    if (!id || !driverId) return { error: "Nothing selected." };

    const loaded = await loadDriverForWrite(actor, driverId);
    if ("error" in loaded) return { error: loaded.error };

    const before = await prisma.driverDocument.findUnique({ where: { id } });
    if (!before || before.driverId !== driverId) {
      return { error: "That document no longer exists." };
    }

    await prisma.driverDocument.delete({ where: { id } });

    const label = DOCUMENT_LABELS[before.kind];
    await recordAudit({
      user: actor,
      action: "DELETE",
      entity: "DriverDocument",
      entityId: id,
      entityRef: `${loaded.driver.code} · ${label}`,
      branchId: loaded.driver.branchId,
      before,
      reason: "Document removed from the driver",
    });

    revalidatePath(`${PATH}/${driverId}`);
    revalidatePath("/fleet/expiries");
    return { ok: true, message: `${label} removed.` };
  } catch (error) {
    return { error: describeFleetError(error, "Driver document") };
  }
}
