"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma, tenantTransaction } from "@/lib/prisma";
import {
  authorize,
  PermissionError,
  type SessionUser,
} from "@/lib/auth/session";
import { recordAudit, changedFields } from "@/server/services/audit";
import {
  permissionsBeyondActor,
  escalationMessage,
} from "@/lib/rbac/grant-guard";
import type { DataScope } from "@/generated/prisma/client";
import type { ActionState } from "@/server/services/master-crud";

const PATH = "/admin/roles";

/**
 * ── Roles were readable, and half-editable ───────────────────────────────
 *
 * `/admin/roles` listed the roles and let their permission matrix be
 * ticked, and that was the whole of it: no way to create one, rename one,
 * write a description, change what a role's scope reaches, or retire one
 * that is no longer used. A carrier whose structure does not match the
 * eleven seeded roles — a regional supervisor over four branches, a
 * night-shift desk that books but does not cancel — had no move except to
 * overload a shipped role, which then means something different at every
 * carrier and lies to everyone reading `/admin/roles`.
 *
 * Two things are deliberately *not* offered:
 *
 *  - **Deleting a role.** `AuditLog` rows name roles by code and
 *    `UserRole` points at them; a deleted role turns "who could do this in
 *    March" into an unanswerable question. Retiring is `isActive = false`,
 *    which drops it out of `loadTenantUser`'s permission union on the next
 *    request and off the assignment form, while the history keeps it.
 *  - **Editing a code.** It is the stable identifier the seed, the audit
 *    trail and `SUPER_ADMIN`'s own special case all key on. It is chosen
 *    once at creation and then left alone.
 */

const SCOPE_VALUES = ["OWN", "BRANCH", "BRANCH_SET", "NETWORK"] as const;

const SCOPE_RANK: Record<DataScope, number> = {
  OWN: 0,
  BRANCH: 1,
  BRANCH_SET: 2,
  NETWORK: 3,
};

const baseSchema = {
  name: z.string().trim().min(2, "Required").max(80),
  description: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(200).nullable(),
  ),
  scope: z.enum(SCOPE_VALUES, { message: "Choose a data scope" }),
  isActive: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),
};

const createSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "At least 2 characters")
    .max(40)
    .regex(/^[A-Za-z0-9_]+$/, "Letters, digits and underscore only")
    .transform((v) => v.toUpperCase()),
  ...baseSchema,
});

const updateSchema = z.object({ ...baseSchema });

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

function describeRoleError(error: unknown, fallback: string): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to change roles.";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unique constraint")) {
    return "Another role already uses that code.";
  }
  console.error("[roles]", error);
  return fallback;
}

/**
 * A scope is reach, and reach is granted the same way a permission is.
 *
 * Without this a branch-scoped holder of `role.manage` could mint a role
 * with `scope: NETWORK`, put a single read permission on it, assign it to
 * themselves — which `rolesBeyondActor` allows, because they hold that
 * permission already — and come back seeing every branch in the company.
 * The permission guard cannot catch it: nothing in the grant is a
 * permission they lack.
 */
function scopeBeyondActor(actor: SessionUser, scope: DataScope): boolean {
  return SCOPE_RANK[scope] > SCOPE_RANK[actor.scope];
}

const SCOPE_REFUSAL: ActionState = {
  error:
    "That data scope reaches further than your own roles do. A role cannot be given more reach than the person creating it has.",
  fieldErrors: { scope: "Wider than your own scope" },
};

export async function createRole(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("role.manage");

    const parsed = createSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    if (scopeBeyondActor(actor, parsed.data.scope)) return SCOPE_REFUSAL;

    // Created empty. Permissions are ticked on the role's own page, which
    // is where `permissionsBeyondActor` already stands guard — so there is
    // exactly one place in the product where a permission is handed to a
    // role, rather than two that have to agree.
    const created = await prisma.role.create({
      data: {
        ...parsed.data,
        orgId: actor.orgId,
        isSystem: false,
      },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Role",
      entityId: created.id,
      entityRef: created.code,
      after: created,
    });

    revalidatePath(PATH);
    return {
      ok: true,
      message: `${created.name} created with no permissions. Open it to choose what it may do.`,
    };
  } catch (error) {
    return {
      error: describeRoleError(error, "Something went wrong. No role was created."),
    };
  }
}

export async function updateRole(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("role.manage");

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

    const before = await prisma.role.findUnique({ where: { id } });
    if (!before) return { error: "That role no longer exists." };

    const data = parsed.data;

    // Only checked when it moves. Otherwise a branch-scoped administrator
    // could not so much as fix a typo in the name of the network-wide role
    // that already exists.
    if (data.scope !== before.scope && scopeBeyondActor(actor, data.scope)) {
      return SCOPE_REFUSAL;
    }

    // A shipped role's scope is not a preference. `DISPATCH_MANAGER` is
    // BRANCH_SET because the dispatch screens and the branch-reach writer on
    // `/admin/users` are built around it; `SUPER_ADMIN` is NETWORK because
    // every "somebody must be able to fix this" path in the product assumes
    // one role that can see everything. Rename them, describe them, retire
    // them — but their reach is part of what they are.
    if (before.isSystem && data.scope !== before.scope) {
      return {
        error:
          "A system role's data scope is fixed. Create a role of your own with the scope you need.",
        fieldErrors: { scope: "Fixed for system roles" },
      };
    }

    // Deactivating this one locks every account out of the parts of the
    // product only it reaches — including this screen, which is how you
    // would put it back.
    if (before.code === "SUPER_ADMIN" && !data.isActive) {
      return {
        error:
          "Super Admin cannot be deactivated. It is the role that can undo every other change on this page.",
        fieldErrors: { isActive: "Cannot be deactivated" },
      };
    }

    const after = await prisma.role.update({ where: { id }, data });
    const diff = changedFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );

    if (Object.keys(diff.after).length === 0) {
      return { ok: true, message: "No changes to save." };
    }

    // Scope decides how much data every permission in the role reaches, so
    // moving it is a permission change however few characters it took.
    await recordAudit({
      user: actor,
      action:
        data.scope !== before.scope || data.isActive !== before.isActive
          ? "PERMISSION_CHANGE"
          : "UPDATE",
      entity: "Role",
      entityId: id,
      entityRef: after.code,
      before: diff.before,
      after: diff.after,
    });

    revalidatePath(PATH);
    revalidatePath(`${PATH}/${id}`);
    return {
      ok: true,
      message:
        data.scope !== before.scope
          ? `${after.name} saved. Everyone holding it sees the new scope on their next request.`
          : `${after.name} saved.`,
    };
  } catch (error) {
    return {
      error: describeRoleError(error, "Something went wrong. The role was not changed."),
    };
  }
}

export async function updateRolePermissions(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("role.manage");

    const roleId = String(formData.get("roleId") ?? "");
    if (!roleId) return { error: "No role selected." };

    const role = await prisma.role.findUnique({
      where: { id: roleId },
      include: { permissions: { select: { permission: { select: { code: true } } } } },
    });
    if (!role) return { error: "That role no longer exists." };

    const submitted = new Set(
      formData.getAll("permissionCodes").map(String).filter(Boolean),
    );

    // A Super Admin with permissions removed locks everyone out of the parts
    // of the system only they can reach. Refuse rather than let it happen.
    if (role.code === "SUPER_ADMIN") {
      const total = await prisma.permission.count();
      if (submitted.size < total) {
        return {
          error:
            "Super Admin must keep every permission. Create a separate role if you need a narrower one.",
        };
      }
    }

    const permissions = await prisma.permission.findMany({
      where: { code: { in: [...submitted] } },
      select: { id: true, code: true },
    });

    const before = role.permissions.map((p) => p.permission.code).sort();
    const after = permissions.map((p) => p.code).sort();

    if (JSON.stringify(before) === JSON.stringify(after)) {
      return { ok: true, message: "No changes to save." };
    }

    const granted = after.filter((code) => !before.includes(code));
    const revoked = before.filter((code) => !after.includes(code));

    // The only guard here used to be the Super Admin rule above, so
    // `role.manage` on its own was `*`: tick `settlement.approve` on the
    // role you already hold and approve your own payouts on the next
    // request. Only additions are checked — revoking stays open, because
    // removing a permission is not an escalation and is the first thing
    // anyone does to a role that has been abused.
    const beyond = await permissionsBeyondActor(actor, granted);
    if (beyond.length > 0) {
      return { error: escalationMessage(`Saving ${role.name}`, beyond) };
    }

    await tenantTransaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.rolePermission.createMany({
        data: permissions.map((p) => ({
          orgId: actor.orgId,
          roleId,
          permissionId: p.id,
        })),
      });
    });

    await recordAudit({
      user: actor,
      action: "PERMISSION_CHANGE",
      entity: "Role",
      entityId: roleId,
      entityRef: role.code,
      before: { permissions: before },
      after: { permissions: after, granted, revoked },
    });

    revalidatePath("/admin/roles");
    revalidatePath(`/admin/roles/${roleId}`);

    return {
      ok: true,
      message:
        `${role.name}: ` +
        [
          granted.length ? `${granted.length} granted` : null,
          revoked.length ? `${revoked.length} revoked` : null,
        ]
          .filter(Boolean)
          .join(", ") +
        ". Takes effect on each user's next request.",
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to change roles." };
    }
    console.error("[roles]", error);
    return { error: "Something went wrong. Permissions were not changed." };
  }
}
