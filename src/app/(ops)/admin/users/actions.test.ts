import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";
import { PERMISSION_CODES } from "@/lib/rbac/permissions";

/**
 * Assigning a role is granting every permission inside it.
 *
 * `roleIds` came off the form and were written verbatim, so somebody with
 * `user.manage` could put the Super Admin role — whose id the page renders
 * — on their own account and come back holding everything. The role editor
 * and this screen share one guard now; these tests drive the real actions
 * and assert that nothing was written, not merely that an error came back.
 */

type RoleRow = {
  id: string;
  name: string;
  isActive: boolean;
  scope?: string;
  permissions: string[];
  users: string[];
};

type UserRow = {
  id: string;
  name: string;
  mobile: string;
  primaryBranchId: string | null;
  roles: Array<{ roleId: string }>;
  branchScopes?: Array<{ branchId: string }>;
};

const store = vi.hoisted(() => ({
  roles: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
  branches: [] as Array<{ id: string; isActive: boolean; deletedAt: Date | null }>,
  /** Every `user.create` payload. */
  created: [] as Array<Record<string, unknown>>,
  /** Every `userRole.createMany` payload. */
  roleWrites: [] as Array<Record<string, unknown>>,
  /** Every `userBranchScope.createMany` payload. */
  scopeWrites: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

function roles(): RoleRow[] {
  return store.roles as unknown as RoleRow[];
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("bcryptjs", () => ({ default: { hash: async () => "hashed" } }));

vi.mock("@/lib/plan-limits", () => ({
  assertWithinLimit: async () => {},
  isPlanLimitError: () => false,
}));

vi.mock("@/lib/fleet/field-staff-service", () => ({
  deactivateFieldUser: async () => ({ ok: true, name: "unused" }),
  reactivateFieldUser: async () => ({ ok: true, name: "unused" }),
}));

vi.mock("@/server/services/audit", () => ({
  recordAudit: async (input: Record<string, unknown>) => {
    store.audits.push(input);
  },
  changedFields: () => ({ before: {}, after: {} }),
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    role: {
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

      count: async ({
        where,
      }: {
        where: { id?: { in: string[] }; scope?: string };
      }) =>
        roles().filter((role) => {
          if (where.id && !where.id.in.includes(role.id)) return false;
          if (where.scope && role.scope !== where.scope) return false;
          return true;
        }).length,
    },

    branch: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        store.branches
          .filter(
            (branch) =>
              where.id.in.includes(branch.id) &&
              branch.isActive &&
              branch.deletedAt === null,
          )
          .map((branch) => ({ id: branch.id })),
    },

    userBranchScope: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async (args: Record<string, unknown>) => {
        store.scopeWrites.push(args);
        return { count: 0 };
      },
    },

    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = (store.users as unknown as UserRow[]).find(
          (u) => u.id === where.id,
        );
        return row ? { branchScopes: [], ...row } : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        store.created.push(data);
        return { id: "u-new", mobile: data.mobile, name: data.name, primaryBranchId: data.primaryBranchId };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = (store.users as unknown as UserRow[]).find((u) => u.id === where.id);
        return { ...row, ...data };
      },
    },

    userRole: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async (args: Record<string, unknown>) => {
        store.roleWrites.push(args);
        return { count: 0 };
      },
    },
  };

  return {
    prisma: client,
    tenantTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
  };
});

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

function userForm(fields: Record<string, string>, roleIds: string[]): FormData {
  const data = new FormData();
  const base: Record<string, string> = {
    name: "Nikhil Sharma",
    mobile: "9810000123",
    email: "",
    employeeCode: "",
    primaryBranchId: "br-del",
    status: "ACTIVE",
    isFieldUser: "false",
    password: "supersecret",
    ...fields,
  };
  for (const [key, value] of Object.entries(base)) data.set(key, value);
  for (const roleId of roleIds) data.append("roleIds", roleId);
  return data;
}

beforeEach(() => {
  store.roles.length = 0;
  store.users.length = 0;
  store.branches.length = 0;
  store.created.length = 0;
  store.roleWrites.length = 0;
  store.scopeWrites.length = 0;
  store.audits.length = 0;

  store.branches.push(
    { id: "br-del", isActive: true, deletedAt: null },
    { id: "br-ggn", isActive: true, deletedAt: null },
    { id: "br-jai", isActive: true, deletedAt: null },
  );

  store.roles.push({
    id: "r-useradmin",
    name: "User Administrator",
    isActive: true,
    scope: "NETWORK",
    permissions: ["user.manage", "user.read", "branch.read"],
    users: ["u-admin"],
  });

  store.roles.push({
    id: "r-super",
    name: "Super Admin",
    isActive: true,
    scope: "NETWORK",
    permissions: [...PERMISSION_CODES],
    users: ["u-owner"],
  });

  store.roles.push({
    id: "r-booking",
    name: "Booking Executive",
    isActive: true,
    scope: "BRANCH",
    permissions: ["user.read", "branch.read"],
    users: [],
  });

  store.roles.push({
    id: "r-dispatch",
    name: "Dispatch Manager",
    isActive: true,
    scope: "BRANCH_SET",
    permissions: ["user.read", "branch.read"],
    users: [],
  });

  store.users.push({
    id: "u-target",
    name: "Existing Person",
    mobile: "9810000999",
    primaryBranchId: "br-del",
    roles: [{ roleId: "r-booking" }],
  });

  actor = {
    id: "u-admin",
    orgId: "org-1",
    name: "User Admin",
    mobile: "9810000000",
    email: null,
    isFieldUser: false,
    mustChangePassword: false,
    primaryBranch: null,
    roles: [],
    permissions: new Set(["user.manage", "user.read", "branch.read"]),
    scope: "NETWORK",
    branchIds: null,
  };
});

describe("createUser", () => {
  it("refuses to create a Super Admin, and creates nobody", async () => {
    const { createUser } = await import("./actions");

    const result = await createUser({}, userForm({}, ["r-super"]));

    expect(result.error).toContain("Super Admin");
    expect(result.fieldErrors?.roleIds).toBeDefined();
    expect(store.created).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it("creates a user whose role stays inside what the actor holds", async () => {
    const { createUser } = await import("./actions");

    const result = await createUser({}, userForm({}, ["r-booking"]));

    expect(result.ok).toBe(true);
    expect(store.created).toHaveLength(1);
  });
});

describe("updateUser", () => {
  it("refuses to add a role carrying permissions the actor lacks", async () => {
    const { updateUser } = await import("./actions");

    const result = await updateUser(
      {},
      userForm({ id: "u-target" }, ["r-booking", "r-super"]),
    );

    expect(result.error).toContain("Super Admin");
    expect(store.roleWrites).toHaveLength(0);
    // No permission-change audit either: the write never happened.
    expect(store.audits).toHaveLength(0);
  });

  it("leaves a role the user already holds alone", async () => {
    const { updateUser } = await import("./actions");

    // The actor cannot grant Super Admin, but a user who already holds it
    // must still be editable — otherwise correcting the phone number of the
    // one person who has it becomes impossible.
    store.users.push({
      id: "u-owner",
      name: "Owner",
      mobile: "9810000001",
      primaryBranchId: "br-del",
      roles: [{ roleId: "r-super" }],
    });

    const result = await updateUser({}, userForm({ id: "u-owner" }, ["r-super"]));

    expect(result.ok).toBe(true);
    expect(store.roleWrites).toHaveLength(0);
  });
});

/**
 * `UserBranchScope` is what makes a BRANCH_SET role mean more than one
 * branch. It had no writer at all, so the scope collapsed to the home
 * branch and the role's own description was false. These drive the writer.
 */
describe("branch reach for a BRANCH_SET role", () => {
  function withScopes(
    fields: Record<string, string>,
    roleIds: string[],
    branchIds: string[],
  ): FormData {
    const data = userForm(fields, roleIds);
    data.set("branchScopesEdited", "true");
    for (const branchId of branchIds) data.append("branchScopeIds", branchId);
    return data;
  }

  it("records the extra branches a dispatch role is given", async () => {
    const { createUser } = await import("./actions");

    const result = await createUser(
      {},
      withScopes({}, ["r-dispatch"], ["br-ggn", "br-jai"]),
    );

    expect(result.ok).toBe(true);
    expect(store.created).toHaveLength(1);
    expect(store.created[0].branchScopes).toEqual({
      create: [
        { orgId: "org-1", branchId: "br-ggn" },
        { orgId: "org-1", branchId: "br-jai" },
      ],
    });
  });

  it("drops the home branch, which the session already unions in", async () => {
    const { createUser } = await import("./actions");

    await createUser({}, withScopes({}, ["r-dispatch"], ["br-del", "br-ggn"]));

    expect(store.created[0].branchScopes).toEqual({
      create: [{ orgId: "org-1", branchId: "br-ggn" }],
    });
  });

  it("ignores them for a role that is not BRANCH_SET", async () => {
    const { createUser } = await import("./actions");

    await createUser({}, withScopes({}, ["r-booking"], ["br-ggn"]));

    expect(store.created[0].branchScopes).toEqual({ create: [] });
  });

  it("refuses a branch the actor does not cover, and creates nobody", async () => {
    const { createUser } = await import("./actions");

    actor.scope = "BRANCH";
    actor.branchIds = ["br-del"];

    const result = await createUser({}, withScopes({}, ["r-dispatch"], ["br-jai"]));

    expect(result.fieldErrors?.branchScopeIds).toBeDefined();
    expect(store.created).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it("refuses a branch that is no longer active, and creates nobody", async () => {
    const { createUser } = await import("./actions");

    store.branches.push({ id: "br-closed", isActive: false, deletedAt: null });

    const result = await createUser(
      {},
      withScopes({}, ["r-dispatch"], ["br-closed"]),
    );

    expect(result.fieldErrors?.branchScopeIds).toBeDefined();
    expect(store.created).toHaveLength(0);
  });

  it("leaves existing reach alone when the form never asked", async () => {
    const { updateUser } = await import("./actions");

    store.users.push({
      id: "u-dispatch",
      name: "Dispatch Person",
      mobile: "9810000777",
      primaryBranchId: "br-del",
      roles: [{ roleId: "r-dispatch" }],
      branchScopes: [{ branchId: "br-ggn" }],
    });

    // The field-staff roster opens the same dialog without the branch list,
    // so an absent answer must not read as "none".
    const result = await updateUser(
      {},
      userForm({ id: "u-dispatch" }, ["r-dispatch"]),
    );

    expect(result.ok).toBe(true);
    expect(store.scopeWrites).toHaveLength(0);
  });

  it("clears the reach when the last BRANCH_SET role is taken away", async () => {
    const { updateUser } = await import("./actions");

    store.users.push({
      id: "u-demoted",
      name: "Demoted Person",
      mobile: "9810000778",
      primaryBranchId: "br-del",
      roles: [{ roleId: "r-dispatch" }],
      branchScopes: [{ branchId: "br-ggn" }],
    });

    const result = await updateUser(
      {},
      userForm({ id: "u-demoted" }, ["r-booking"]),
    );

    expect(result.ok).toBe(true);
    // Deleted, not rewritten — `createMany` is skipped for an empty list.
    expect(store.scopeWrites).toHaveLength(0);
    const permissionChange = store.audits.find(
      (row) => row.action === "PERMISSION_CHANGE",
    );
    expect(permissionChange?.after).toMatchObject({ branchScopeIds: [] });
  });
});
