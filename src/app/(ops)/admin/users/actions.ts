"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { recordAudit, changedFields } from "@/server/services/audit";
import type { ActionState } from "@/server/services/master-crud";

const PATH = "/admin/users";

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
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unique constraint")) {
    return message.includes("email")
      ? "Another user already has that email."
      : "Another user already has that mobile number.";
  }
  console.error("[users]", error);
  return "Something went wrong. The change was not applied.";
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

    const org = await prisma.organization.findFirstOrThrow({
      select: { id: true },
    });

    const created = await prisma.user.create({
      data: {
        ...data,
        orgId: org.id,
        createdById: actor.id,
        passwordHash: password ? await bcrypt.hash(password, 10) : null,
        mustChangePassword: Boolean(password),
        roles: { create: roleIds.map((roleId) => ({ roleId, assignedBy: actor.id })) },
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

    revalidatePath(PATH);
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

    const after = await prisma.user.update({
      where: { id },
      data: parsed.data,
    });

    const beforeRoles = before.roles.map((r) => r.roleId).sort();
    const rolesChanged =
      JSON.stringify(beforeRoles) !== JSON.stringify([...roleIds].sort());

    if (rolesChanged) {
      await prisma.$transaction([
        prisma.userRole.deleteMany({ where: { userId: id } }),
        prisma.userRole.createMany({
          data: roleIds.map((roleId) => ({ userId: id, roleId, assignedBy: actor.id })),
        }),
      ]);

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

    revalidatePath(PATH);
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

    revalidatePath(PATH);
    return {
      ok: true,
      message: `Password reset for ${target.name}. They must change it at next sign-in.`,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}
