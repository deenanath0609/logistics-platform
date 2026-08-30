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
  permissions: string[];
  users: string[];
};

type UserRow = {
  id: string;
  name: string;
  mobile: string;
  primaryBranchId: string | null;
  roles: Array<{ roleId: string }>;
};

const store = vi.hoisted(() => ({
  roles: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
  /** Every `user.create` payload. */
  created: [] as Array<Record<string, unknown>>,
  /** Every `userRole.createMany` payload. */
  roleWrites: [] as Array<Record<string, unknown>>,
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
    },

    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        (store.users as unknown as UserRow[]).find((u) => u.id === where.id) ?? null,
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
  store.created.length = 0;
  store.roleWrites.length = 0;
  store.audits.length = 0;

  store.roles.push({
    id: "r-useradmin",
    name: "User Administrator",
    isActive: true,
    permissions: ["user.manage", "user.read", "branch.read"],
    users: ["u-admin"],
  });

  store.roles.push({
    id: "r-super",
    name: "Super Admin",
    isActive: true,
    permissions: [...PERMISSION_CODES],
    users: ["u-owner"],
  });

  store.roles.push({
    id: "r-booking",
    name: "Booking Executive",
    isActive: true,
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
