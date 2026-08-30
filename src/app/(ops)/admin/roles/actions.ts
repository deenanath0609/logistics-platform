"use server";

import { revalidatePath } from "next/cache";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { recordAudit } from "@/server/services/audit";
import {
  permissionsBeyondActor,
  escalationMessage,
} from "@/lib/rbac/grant-guard";
import type { ActionState } from "@/server/services/master-crud";

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
