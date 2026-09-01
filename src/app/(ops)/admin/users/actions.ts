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

/**
 * ── The branches a BRANCH_SET role actually reaches ──────────────────────
 *
 * `UserBranchScope` is read in two places — `loadTenantUser` and the
 * partner-API guard — and until now was written in none. There was no
 * screen, no action and no seed row, so the table was permanently empty and
 * the `BRANCH_SET` arm of `loadTenantUser` collapsed to
 * `[primaryBranch.id]`: exactly what plain `BRANCH` produces.
 *
 * That made one shipped role a lie. Dispatch Manager is the product's only
 * `BRANCH_SET` role, `/admin/roles` prints its scope as "Assigned
 * branches", the user dialog says "sees assigned branches" beside its
 * checkbox, and every one of those sentences described a reach the person
 * did not have. A dispatch manager covering Delhi and Gurugram could build
 * a manifest for one of them.
 *
 * The two honest endings were to write the table or to delete the scope.
 * Deleting it throws away the only mechanism the product has for the ordinary
 * case of somebody responsible for two or three branches, and would have to
 * demote Dispatch Manager to `BRANCH` — so: a writer.
 *
 * Three rules, all enforced here rather than in the form:
 *
 *  - Extra branches are only recorded for somebody who holds a `BRANCH_SET`
 *    role. Rows against a `BRANCH` user would sit in the table doing
 *    nothing, ready to widen that person silently the day somebody ticks a
 *    dispatch role onto them.
 *  - Every branch must be one the *actor* covers. Otherwise `user.manage`
 *    plus a `BRANCH_SET` role is a self-service route to the whole network:
 *    grant yourself the role, list every branch, sign in again.
 *  - The primary branch is dropped. `loadTenantUser` unions it in already,
 *    and a duplicate row would only be a second place to keep in step.
 */
async function resolveBranchScopes(
  actor: SessionUser,
  formData: FormData,
  roleIds: string[],
  primaryBranchId: string,
  /** What the person already has, for the form that does not ask. */
  current: string[] = [],
): Promise<
  { ok: true; branchIds: string[] } | { ok: false; refusal: ActionState }
> {
  const holdsBranchSet = await prisma.role.count({
    where: { id: { in: roleIds }, scope: "BRANCH_SET" },
  });

  // Not an error: unticking the last dispatch role is a de-escalation, and
  // dropping the rows with it is what that should mean. Rows left behind
  // would widen this person again the day somebody ticks the role back on.
  if (holdsBranchSet === 0) return { ok: true, branchIds: [] };

  // The field-staff roster opens the same dialog and never renders the
  // branch list, so an empty answer from it is silence rather than "none".
  // The marker is how the two are told apart — without it, editing a
  // dispatch manager's phone number from another screen would quietly strip
  // every branch they cover.
  if (formData.get("branchScopesEdited") !== "true") {
    return { ok: true, branchIds: current.filter((id) => id !== primaryBranchId) };
  }

  const submitted = [
    ...new Set(formData.getAll("branchScopeIds").map(String).filter(Boolean)),
  ].filter((id) => id !== primaryBranchId);

  if (submitted.length === 0) return { ok: true, branchIds: [] };

  const outside = submitted.filter((id) => !coversBranch(actor, id));
  if (outside.length > 0) {
    return {
      ok: false,
      refusal: {
        error:
          "You can only extend someone's reach to branches you cover yourself.",
        fieldErrors: { branchScopeIds: "Outside your own scope" },
      },
    };
  }

  // A branch that has been closed or removed must not silently widen
  // somebody: the id would still satisfy `coversBranch` for a network actor.
  const live = await prisma.branch.findMany({
    where: { id: { in: submitted }, isActive: true, deletedAt: null },
    select: { id: true },
  });
  if (live.length !== submitted.length) {
    return {
      ok: false,
      refusal: {
        error: "One of those branches is no longer active.",
        fieldErrors: { branchScopeIds: "Not an active branch" },
      },
    };
  }

  return { ok: true, branchIds: submitted };
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

    const scopes = await resolveBranchScopes(
      actor,
      formData,
      roleIds,
      data.primaryBranchId,
    );
    if (!scopes.ok) return scopes.refusal;

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
        branchScopes: {
          create: scopes.branchIds.map((branchId) => ({
            orgId: actor.orgId,
            branchId,
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
      after: { ...created, roleIds, branchScopeIds: scopes.branchIds },
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
      include: {
        roles: { select: { roleId: true } },
        branchScopes: { select: { branchId: true } },
      },
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

    const scopes = await resolveBranchScopes(
      actor,
      formData,
      roleIds,
      parsed.data.primaryBranchId,
      before.branchScopes.map((s) => s.branchId),
    );
    if (!scopes.ok) return scopes.refusal;

    // Refused before anything is written, so a rejected widening does not
    // leave a half-applied edit behind — the person's name and branch would
    // have been saved while the reach they were being given was not.
    const after = await prisma.user.update({
      where: { id },
      data: parsed.data,
    });

    const beforeRoles = before.roles.map((r) => r.roleId).sort();
    const rolesChanged =
      JSON.stringify(beforeRoles) !== JSON.stringify([...roleIds].sort());

    const beforeScopes = before.branchScopes.map((s) => s.branchId).sort();
    const nextScopes = [...scopes.branchIds].sort();
    const scopesChanged =
      JSON.stringify(beforeScopes) !== JSON.stringify(nextScopes);

    if (rolesChanged || scopesChanged) {
      await tenantTransaction(async (tx) => {
        if (rolesChanged) {
          await tx.userRole.deleteMany({ where: { userId: id } });
          await tx.userRole.createMany({
            data: roleIds.map((roleId) => ({
              orgId: actor.orgId,
              userId: id,
              roleId,
              assignedBy: actor.id,
            })),
          });
        }
        if (scopesChanged) {
          await tx.userBranchScope.deleteMany({ where: { userId: id } });
          if (nextScopes.length > 0) {
            await tx.userBranchScope.createMany({
              data: nextScopes.map((branchId) => ({
                orgId: actor.orgId,
                userId: id,
                branchId,
              })),
            });
          }
        }
      });

      // Role changes get their own audit row: a permission grant is a
      // different kind of event from a phone-number correction. Widening
      // somebody's branch reach is the same kind of event — it changes what
      // they can see, not what they are called — so it goes in the same row.
      await recordAudit({
        user: actor,
        action: "PERMISSION_CHANGE",
        entity: "User",
        entityId: id,
        entityRef: after.mobile,
        before: { roleIds: beforeRoles, branchScopeIds: beforeScopes },
        after: { roleIds, branchScopeIds: nextScopes },
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
