"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { authorize, PermissionError, type SessionUser } from "@/lib/auth/session";
import { assertWithinLimit, isPlanLimitError } from "@/lib/plan-limits";
import { coversBranch } from "@/server/repositories/scope";
import { recordAudit, changedFields } from "@/server/services/audit";
import { rolesBeyondActor, escalationMessage } from "@/lib/rbac/grant-guard";
import {
  deactivateFieldUser,
  reactivateFieldUser,
} from "@/lib/fleet/field-staff-service";
import type { ActionState } from "@/server/services/master-crud";

const PATH = "/admin/users";

/**
 * The field-staff roster is a second view of these same rows, so every
 * mutation here has to refresh it too — otherwise a delivery boy edited on
 * one screen still reads with his old branch on the other.
 */
const FIELD_STAFF_PATH = "/fleet/field-staff";

function revalidateUserViews(): void {
  revalidatePath(PATH);
  revalidatePath(FIELD_STAFF_PATH);
}

const base = {
  name: z.string().trim().min(2, "Required").max(120),
  mobile: z
    .string()
    .trim()
    .regex(/^\d{10}$/, "Ten digits, no country code"),
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().email("Enter a valid email").nullable(),
  ),
  employeeCode: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(30).nullable(),
  ),
  primaryBranchId: z.string().min(1, "Choose a home branch"),
  status: z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]),
  isFieldUser: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),
};

const createSchema = z
  .object({
    ...base,
    password: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    // Field staff sign in with mobile + OTP, so a password is optional for
    // them. Office staff need one to get in at all.
    if (!value.isFieldUser && (!value.password || value.password.length < 8)) {
      ctx.addIssue({
        code: "custom",
        path: ["password"],
        message: "At least 8 characters, required for office staff",
      });
    }
  });

const updateSchema = z.object(base);

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
    return "You do not have permission to manage users.";
  }
  // Already written for a carrier, naming their plan and the number.
  if (isPlanLimitError(error)) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unique constraint")) {
    return message.includes("email")
      ? "Another user already has that email."
      : "Another user already has that mobile number.";
  }
  console.error("[users]", error);
  return "Something went wrong. The change was not applied.";
}

/**
 * Refuses role assignments that would hand out more than the actor holds.
 *
 * `roleIds` come straight off the form and used to be written verbatim, so
 * `user.manage` on its own was equivalent to `*`: the Super Admin role id
 * is rendered on the page, and posting it against your own account gave you
 * every permission on your next request. Only roles being *added* are
 * checked — removing a role you could not grant is de-escalation and has to
 * stay possible.
 *
 * Returns the refusal to hand back, or `null` when the assignment is within
 * what the actor may pass on.
 */
async function ungrantableRoles(
  actor: SessionUser,
  roleIds: string[],
  alreadyHeld: string[] = [],
): Promise<ActionState | null> {
  const added = roleIds.filter((id) => !alreadyHeld.includes(id));
  const beyond = await rolesBeyondActor(actor, added);
  if (beyond.length === 0) return null;

  const worst = beyond[0];
  return {
    error: escalationMessage(`The role "${worst.name}"`, worst.codes),
    fieldErrors: { roleIds: "Beyond your own permissions" },
  };
}

export async function createUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("user.manage");

    const parsed = createSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const { password, ...data } = parsed.data;

    // An admin scoped to two branches must not be able to plant a user in a
    // third. The form only offers permitted branches; this enforces it.
    if (!coversBranch(actor, data.primaryBranchId)) {
      return { error: "That branch is outside your scope." };
    }

    const roleIds = formData.getAll("roleIds").map(String).filter(Boolean);
    if (roleIds.length === 0) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: { roleIds: "Assign at least one role" },
      };
    }

    const refusal = await ungrantableRoles(actor, roleIds);
    if (refusal) return refusal;

    // The seat is checked here, after the form has been found valid and
    // before anything is written: the eleventh user on a ten-user plan is
    // refused at creation, told which plan and which number, rather than
    // created now and reconciled on an invoice a month later.
    await assertWithinLimit("users");

    // The new user joins the organisation of whoever created them.
    // `Organization` is global (ADR 001 §4), so the extension does not
    // filter it and a `where`-less read of it was picking an arbitrary
    // tenant to plant staff accounts in. Naming the actor's org also lets
    // the extension refuse the write outright if the signed-in user and
    // the host's tenant ever disagree.
    const created = await prisma.user.create({
      data: {
        ...data,
        orgId: actor.orgId,
        createdById: actor.id,
        passwordHash: password ? await bcrypt.hash(password, 10) : null,
        mustChangePassword: Boolean(password),
        roles: {
          create: roleIds.map((roleId) => ({
            orgId: actor.orgId,
            roleId,
            assignedBy: actor.id,
          })),
        },
      },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "User",
      entityId: created.id,
      entityRef: created.mobile,
      branchId: created.primaryBranchId,
      after: { ...created, roleIds },
    });

    revalidateUserViews();
    return {
      ok: true,
      message: parsed.data.isFieldUser
        ? `${created.name} created. They sign in with mobile ${created.mobile} and a one-time code.`
        : `${created.name} created and must change their password at first sign-in.`,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function updateUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("user.manage");

    const id = String(formData.get("id") ?? "");
    if (!id) return { error: "Nothing selected to update." };

    const parsed = updateSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    if (!coversBranch(actor, parsed.data.primaryBranchId)) {
      return { error: "That branch is outside your scope." };
    }

    const before = await prisma.user.findUnique({
      where: { id },
      include: { roles: { select: { roleId: true } } },
    });
    if (!before) return { error: "That user no longer exists." };
    if (!coversBranch(actor, before.primaryBranchId ?? "")) {
      return { error: "That user is outside your scope." };
    }

    const roleIds = formData.getAll("roleIds").map(String).filter(Boolean);
    if (roleIds.length === 0) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: { roleIds: "Assign at least one role" },
      };
    }

    const refusal = await ungrantableRoles(
      actor,
      roleIds,
      before.roles.map((r) => r.roleId),
    );
    if (refusal) return refusal;

    const after = await prisma.user.update({
      where: { id },
      data: parsed.data,
    });

    const beforeRoles = before.roles.map((r) => r.roleId).sort();
    const rolesChanged =
      JSON.stringify(beforeRoles) !== JSON.stringify([...roleIds].sort());

    if (rolesChanged) {
      await tenantTransaction(async (tx) => {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({
          data: roleIds.map((roleId) => ({
            orgId: actor.orgId,
            userId: id,
            roleId,
            assignedBy: actor.id,
          })),
        });
      });

      // Role changes get their own audit row: a permission grant is a
      // different kind of event from a phone-number correction.
      await recordAudit({
        user: actor,
        action: "PERMISSION_CHANGE",
        entity: "User",
        entityId: id,
        entityRef: after.mobile,
        before: { roleIds: beforeRoles },
        after: { roleIds },
      });
    }

    const diff = changedFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );
    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        user: actor,
        action: "UPDATE",
        entity: "User",
        entityId: id,
        entityRef: after.mobile,
        branchId: after.primaryBranchId,
        before: diff.before,
        after: diff.after,
      });
    }

    revalidateUserViews();
    return { ok: true, message: `${after.name} updated.` };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function resetPassword(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("user.manage");

    const id = String(formData.get("id") ?? "");
    const password = String(formData.get("password") ?? "");

    if (password.length < 8) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: { password: "At least 8 characters" },
      };
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, mobile: true, primaryBranchId: true },
    });
    if (!target) return { error: "That user no longer exists." };
    if (!coversBranch(actor, target.primaryBranchId ?? "")) {
      return { error: "That user is outside your scope." };
    }

    await prisma.user.update({
      where: { id },
      data: {
        passwordHash: await bcrypt.hash(password, 10),
        mustChangePassword: true,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    // Every session the user has open is now stale; revoking them here means
    // a compromised account cannot outlive the reset.
    await prisma.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "User",
      entityId: id,
      entityRef: target.mobile,
      reason: "Password reset by administrator",
      after: { passwordChangedAt: new Date().toISOString() },
    });

    revalidateUserViews();
    return {
      ok: true,
      message: `Password reset for ${target.name}. They must change it at next sign-in.`,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

/**
 * ── "Delete" means deactivate plus soft delete. Never a row deletion. ────
 *
 * This is a settled product decision, written here because the obvious
 * "simplification" — a real `prisma.user.delete()` — destroys evidence.
 *
 * A delivery boy's `User` row is pointed at by records that are proof, not
 * convenience: `DeliveryRun.agentId`, `DeliveryAttempt.agentId`,
 * `Pod.agentId`, `ScanRecord.userId`, `CodCollection.agentId`,
 * `PickupAssignment.assignedToId`, and every `AuditLog` row the person
 * ever caused. Those are read months later — in a consignee dispute, in a
 * COD shortfall investigation, in a proof of delivery that has to stand up
 * outside this company. Remove the row and a six-month-old delivery can no
 * longer say who carried the goods.
 *
 * The foreign keys would not even let it happen quietly: the delete either
 * fails on every person who has ever worked a day, or cascades and takes
 * the delivery history with it. Neither is a behaviour anyone asked for.
 *
 * So removal is `status = INACTIVE` plus `deletedAt`. The person leaves
 * every picker, every roster and every assignment screen; the history
 * keeps their name. `reactivateUser` is the other half — seasonal staff
 * come back, and re-creating them would fork one person into two.
 * ────────────────────────────────────────────────────────────────────────
 */
export async function deactivateUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("user.manage");

    const id = String(formData.get("id") ?? "");
    if (!id) return { error: "Nothing selected." };

    // The refusal rules and the writes both live in the service; this stays
    // a permission gate and a form parse.
    const result = await deactivateFieldUser(id, actor);
    if (!result.ok) return { error: result.error };

    await recordAudit({
      user: actor,
      action: "STATUS_CHANGE",
      entity: "User",
      entityId: id,
      entityRef: result.name,
      reason: "Deactivated by administrator",
      before: { status: "ACTIVE", deletedAt: null },
      after: { status: "INACTIVE", deletedAt: new Date().toISOString() },
    });

    revalidateUserViews();
    return {
      ok: true,
      message: `${result.name} deactivated. Their next request is refused — they are already signed out.`,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

/** Undoes the above. Seasonal staff come back to the same record. */
export async function reactivateUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("user.manage");

    const id = String(formData.get("id") ?? "");
    if (!id) return { error: "Nothing selected." };

    // Bringing somebody back takes a seat, so it is a creation as far as
    // the plan is concerned. Without this, a carrier sitting at their cap
    // could stand one person down, hire a replacement, and then reactivate
    // the first to end up one over.
    await assertWithinLimit("users");

    const result = await reactivateFieldUser(id, actor);
    if (!result.ok) return { error: result.error };

    await recordAudit({
      user: actor,
      action: "STATUS_CHANGE",
      entity: "User",
      entityId: id,
      entityRef: result.name,
      reason: "Reactivated by administrator",
      before: { status: "INACTIVE" },
      after: { status: "ACTIVE", deletedAt: null },
    });

    revalidateUserViews();
    return {
      ok: true,
      message: `${result.name} is active again and can sign in.`,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}
