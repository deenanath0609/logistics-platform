import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";
import { PERMISSION_CODES } from "@/lib/rbac/permissions";

/**
 * The role editor, as an escalation route.
 *
 * `role.manage` used to be the only thing checked: whatever permission
 * codes the form posted were written, so the one person allowed to edit
 * roles could tick `settlement.approve` onto the role they hold and approve
 * their own payouts on the next request. These tests drive the real action
 * against a store that records every write, so a refusal that still wrote
 * would fail here rather than pass on the strength of its error message.
 */

type RoleRow = {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  /** Permission codes granted to this role. */
  permissions: string[];
  /** Ids of users holding it. */
  users: string[];
};

const store = vi.hoisted(() => ({
  roles: [] as Array<Record<string, unknown>>,
  /** Every `rolePermission.createMany` payload, in order. */
  grants: [] as Array<Record<string, unknown>>,
  /** Every `rolePermission.deleteMany` payload, in order. */
  revokes: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

function roles(): RoleRow[] {
  return store.roles as unknown as RoleRow[];
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/server/services/audit", () => ({
  recordAudit: async (input: Record<string, unknown>) => {
    store.audits.push(input);
  },
  changedFields: () => ({ before: {}, after: {} }),
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    role: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const role = roles().find((r) => r.id === where.id);
        if (!role) return null;
        return {
          ...role,
          permissions: role.permissions.map((code) => ({ permission: { code } })),
        };
      },

      // Two shapes reach this: the guard asking what the actor holds, and
      // the guard asking what a set of roles carries.
      findMany: async ({
        where,
      }: {
        where: {
          isActive?: boolean;
          users?: { some: { userId: string } };
          id?: { in: string[] };
        };
      }) =>
        roles()
          .filter((role) => {
            if (where.isActive !== undefined && role.isActive !== where.isActive) {
              return false;
            }
            if (where.users && !role.users.includes(where.users.some.userId)) {
              return false;
            }
            if (where.id && !where.id.in.includes(role.id)) return false;
            return true;
          })
          .map((role) => ({
            name: role.name,
            permissions: role.permissions.map((code) => ({ permission: { code } })),
          })),
    },

    permission: {
      count: async () => PERMISSION_CODES.length,
      findMany: async ({ where }: { where: { code: { in: string[] } } }) =>
        where.code.in
          .filter((code) => PERMISSION_CODES.includes(code))
          .map((code) => ({ id: `perm-${code}`, code })),
    },

    rolePermission: {
      deleteMany: async (args: Record<string, unknown>) => {
        store.revokes.push(args);
        return { count: 0 };
      },
      createMany: async (args: Record<string, unknown>) => {
        store.grants.push(args);
        return { count: 0 };
      },
    },
  };

  return {
    prisma: client,
    tenantTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
  };
});

/** Whoever the action is running as. */
let actor: SessionUser;

vi.mock("@/lib/auth/session", () => {
  class PermissionError extends Error {
    constructor(public permission: string) {
      super(`Missing permission: ${permission}`);
      this.name = "PermissionError";
    }
  }
  return {
    PermissionError,
    authorize: async (permission: string) => {
      if (!actor.permissions.has(permission)) throw new PermissionError(permission);
      return actor;
    },
    can: (user: SessionUser, permission: string) => user.permissions.has(permission),
  };
});

function sessionUser(permissions: string[]): SessionUser {
  return {
    id: "u-admin",
    orgId: "org-1",
    name: "Role Admin",
    mobile: "9810000000",
    email: null,
    isFieldUser: false,
    mustChangePassword: false,
    primaryBranch: null,
    roles: [],
    permissions: new Set(permissions),
    scope: "NETWORK",
    branchIds: null,
  };
}

function form(roleId: string, codes: string[]): FormData {
  const data = new FormData();
  data.set("roleId", roleId);
  for (const code of codes) data.append("permissionCodes", code);
  return data;
}

beforeEach(() => {
  store.roles.length = 0;
  store.grants.length = 0;
  store.revokes.length = 0;
  store.audits.length = 0;

  // The actor's own role: it may edit roles and nothing else that matters.
  store.roles.push({
    id: "r-admin",
    code: "ROLE_ADMIN",
    name: "Role Administrator",
    isActive: true,
    permissions: ["role.manage", "user.read", "user.manage"],
    users: ["u-admin"],
  });

  store.roles.push({
    id: "r-accounts",
    code: "ACCOUNTS",
    name: "Accounts",
    isActive: true,
    permissions: ["invoice.read", "cod.reconcile"],
    users: ["u-accounts"],
  });

  actor = sessionUser(["role.manage", "user.read", "user.manage"]);
});

describe("updateRolePermissions", () => {
  it("refuses to grant a permission the actor does not hold, and writes nothing", async () => {
    const { updateRolePermissions } = await import("./actions");

    // The whole attack in one form post: add payout approval to the role
    // the actor already holds.
    const result = await updateRolePermissions(
      {},
      form("r-admin", [
        "role.manage",
        "user.read",
        "user.manage",
        "settlement.approve",
        "invoice.approve",
      ]),
    );

    expect(result.ok).toBeUndefined();
    expect(result.error).toContain("settlement.approve");
    expect(result.error).toContain("invoice.approve");

    // A refusal that still wrote would be no refusal at all.
    expect(store.grants).toHaveLength(0);
    expect(store.revokes).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it("refuses to hand another role a permission the actor does not hold", async () => {
    const { updateRolePermissions } = await import("./actions");

    const result = await updateRolePermissions(
      {},
      form("r-accounts", ["invoice.read", "cod.reconcile", "shipment.cancel"]),
    );

    expect(result.error).toContain("shipment.cancel");
    expect(store.grants).toHaveLength(0);
  });

  it("still saves a grant of something the actor holds", async () => {
    const { updateRolePermissions } = await import("./actions");

    const result = await updateRolePermissions(
      {},
      form("r-accounts", ["invoice.read", "cod.reconcile", "user.read"]),
    );

    expect(result.ok).toBe(true);
    expect(store.grants).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
  });

  it("lets an actor revoke a permission they do not hold themselves", async () => {
    const { updateRolePermissions } = await import("./actions");

    // Stripping `cod.reconcile` off Accounts is the first thing anyone does
    // to a role that has been abused. Checking removals as well as
    // additions would have blocked exactly that.
    const result = await updateRolePermissions({}, form("r-accounts", ["invoice.read"]));

    expect(result.ok).toBe(true);
    expect(store.grants).toHaveLength(1);
  });

  it("refuses a Super Admin save by someone who does not hold everything", async () => {
    const { updateRolePermissions } = await import("./actions");

    store.roles.push({
      id: "r-super",
      code: "SUPER_ADMIN",
      name: "Super Admin",
      isActive: true,
      // One short of the full set, so the save is a real change rather than
      // a no-op — restoring `settlement.approve` to the most powerful role
      // in the product.
      permissions: PERMISSION_CODES.filter((code) => code !== "settlement.approve"),
      users: ["u-owner"],
    });

    const result = await updateRolePermissions(
      {},
      form("r-super", [...PERMISSION_CODES]),
    );

    expect(result.error).toContain("settlement.approve");
    expect(store.grants).toHaveLength(0);
  });
});
