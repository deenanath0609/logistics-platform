import { db, step, done } from "./client";
import { PERMISSIONS, SYSTEM_ROLES } from "../../src/lib/rbac/permissions";

export async function seedPermissions() {
  step("permissions");

  for (const perm of PERMISSIONS) {
    await db.permission.upsert({
      where: { code: perm.code },
      create: {
        code: perm.code,
        resource: perm.resource,
        action: perm.action,
        module: perm.module,
        description: perm.description,
        isSensitive: perm.sensitive ?? false,
      },
      update: {
        resource: perm.resource,
        action: perm.action,
        module: perm.module,
        description: perm.description,
        isSensitive: perm.sensitive ?? false,
      },
    });
  }

  done(PERMISSIONS.length);
}

export async function seedRoles(orgId: string) {
  step("system roles");

  const all = await db.permission.findMany({ select: { id: true, code: true } });
  const idByCode = new Map(all.map((p) => [p.code, p.id]));

  for (const def of SYSTEM_ROLES) {
    const role = await db.role.upsert({
      where: { orgId_code: { orgId, code: def.code } },
      create: {
        orgId,
        code: def.code,
        name: def.name,
        description: def.description,
        scope: def.scope,
        isSystem: true,
      },
      update: {
        name: def.name,
        description: def.description,
        scope: def.scope,
      },
    });

    const codes =
      def.permissions === "*"
        ? [...idByCode.keys()]
        : // De-duplicate: several role definitions spread `allReads` and
          // then name individual reads again.
          [...new Set(def.permissions)];

    const permissionIds = codes
      .map((code) => {
        const id = idByCode.get(code);
        if (!id) console.warn(`\n    ! unknown permission "${code}" in role ${def.code}`);
        return id;
      })
      .filter((id): id is string => Boolean(id));

    // Replace the grant set so removing a permission from the catalogue
    // actually revokes it on re-seed.
    await db.rolePermission.deleteMany({ where: { roleId: role.id } });
    await db.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({
        orgId,
        roleId: role.id,
        permissionId,
      })),
      skipDuplicates: true,
    });
  }

  done(SYSTEM_ROLES.length);
}
