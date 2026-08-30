import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";

/**
 * The two halves of "removing" a field user.
 *
 * The first half is a refusal: a delivery boy holding an open run cannot
 * be stood down, because the run keeps its `agentId` whatever happens to
 * the user row and the only symptom would be parcels that never move.
 *
 * The second half is that the deactivation actually bites. `deletedAt` and
 * `status` are not read by any guard written for this feature — the whole
 * enforcement is that `getCurrentUser()` already refuses such a row on
 * every request. That is an assumption this feature is built on rather
 * than something it implements, so it is asserted here against the real
 * `getCurrentUser`.
 *
 * Prisma is replaced by a store that applies the `where` clauses it is
 * given. A stub returning fixed rows would keep passing if somebody
 * deleted the status check from `loadTenantUser`.
 */

type UserRow = {
  id: string;
  orgId: string;
  name: string;
  mobile: string;
  email: string | null;
  status: string;
  isFieldUser: boolean;
  mustChangePassword: boolean;
  deletedAt: Date | null;
  primaryBranchId: string | null;
  primaryBranch: { id: string; code: string; name: string } | null;
  branchScopes: Array<{ branchId: string }>;
  roles: Array<{
    role: {
      code: string;
      name: string;
      scope: string;
      isActive: boolean;
      permissions: Array<{ permission: { code: string } }>;
    };
  }>;
};

type RunRow = {
  number: string;
  status: string;
  agentId: string;
  /** Stops with no outcome yet — what `_count.tasks` resolves to. */
  stopsRemaining: number;
};

type AssignmentRow = {
  number: string;
  assignedToId: string;
  status: string;
  supersededAt: Date | null;
};

const store = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  assignments: [] as Array<Record<string, unknown>>,
  /** Every `user.update` payload, in order. */
  userUpdates: [] as Array<Record<string, unknown>>,
  /** Every `session.updateMany` payload, in order. */
  sessionUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.users.find((row) => row.id === where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = store.users.find((entry) => entry.id === where.id);
        if (!row) throw new Error("no such user");
        Object.assign(row, data);
        store.userUpdates.push({ id: where.id, ...data });
        return row;
      },
    },

    deliveryRun: {
      findMany: async ({
        where,
      }: {
        where: { agentId: string; status: { in: string[] } };
      }) =>
        (store.runs as unknown as RunRow[])
          .filter(
            (run) =>
              run.agentId === where.agentId &&
              where.status.in.includes(run.status),
          )
          .map((run) => ({
            number: run.number,
            status: run.status,
            _count: { tasks: run.stopsRemaining },
          })),
    },

    pickupAssignment: {
      findMany: async ({
        where,
      }: {
        where: {
          assignedToId: string;
          supersededAt: null;
          status: { in: string[] };
        };
      }) =>
        (store.assignments as unknown as AssignmentRow[])
          .filter(
            (assignment) =>
              assignment.assignedToId === where.assignedToId &&
              assignment.supersededAt === null &&
              where.status.in.includes(assignment.status),
          )
          .map((assignment) => ({ request: { number: assignment.number } })),
    },

    session: {
      updateMany: async (args: Record<string, unknown>) => {
        store.sessionUpdates.push(args);
        return { count: 1 };
      },
    },
  };

  return {
    prisma: client,
    tenantTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
  };
});

// `getCurrentUser` reaches Auth.js, the host resolver and the operator
// impersonation module. None of them is what this file is testing; each is
// pinned to the ordinary case — a signed-in staff cookie on a tenant host.
vi.mock("@/lib/auth", () => ({
  auth: async () => ({ user: { id: currentSubject } }),
}));

vi.mock("@/lib/tenant/resolve", () => ({
  resolveTenant: async () => ({ source: "host", orgId: "org-1" }),
  requireTenantOrgId: async () => "org-1",
}));

vi.mock("@/lib/platform/impersonation-session", () => ({
  currentImpersonation: async () => null,
}));

// `getCurrentUser` also narrows the session to the tenant's modules, which
// reads the plan off the organisation through the unextended client. This
// file is about deactivation, not about what the carrier bought, so the plan
// is pinned to "everything" and the permission set comes out untouched.
vi.mock("@/lib/prisma-base", async () => {
  const { MODULE_KEYS } = await import("@/lib/modules/registry");
  return {
    basePrisma: {
      organization: {
        findUnique: async () => ({ plan: { features: [...MODULE_KEYS] } }),
      },
    },
  };
});

/** Whose cookie the next `getCurrentUser()` call is carrying. */
let currentSubject = "";

const DRIVER_ROLE = {
  role: {
    code: "DELIVERY_AGENT",
    name: "Delivery Agent",
    scope: "OWN",
    isActive: true,
    permissions: [{ permission: { code: "delivery.execute" } }],
  },
};

function fieldUser(overrides: Partial<UserRow> & { id: string }): UserRow {
  return {
    orgId: "org-1",
    name: "Rahul Verma",
    mobile: "9810000001",
    email: null,
    status: "ACTIVE",
    isFieldUser: true,
    mustChangePassword: false,
    deletedAt: null,
    primaryBranchId: "br-del",
    primaryBranch: { id: "br-del", code: "DEL", name: "Delhi" },
    branchScopes: [],
    roles: [DRIVER_ROLE],
    ...overrides,
  };
}

const ADMIN: SessionUser = {
  id: "u-admin",
  orgId: "org-1",
  name: "Admin",
  mobile: "9810000000",
  email: null,
  isFieldUser: false,
  mustChangePassword: false,
  primaryBranch: null,
  roles: [],
  permissions: new Set(["user.manage"]),
  scope: "NETWORK",
  // Network scope, so `coversBranch` never gets in the way of what these
  // tests are actually about.
  branchIds: null,
};

beforeEach(() => {
  store.users.length = 0;
  store.runs.length = 0;
  store.assignments.length = 0;
  store.userUpdates.length = 0;
  store.sessionUpdates.length = 0;
  currentSubject = "";
});

describe("deactivateFieldUser", () => {
  it("refuses somebody holding an open delivery run, and names it", async () => {
    const { deactivateFieldUser } = await import("./field-staff-service");

    store.users.push(fieldUser({ id: "u-busy", name: "Rahul Verma" }));
    store.runs.push({
      number: "DR-DEL-0042",
      status: "STARTED",
      agentId: "u-busy",
      stopsRemaining: 6,
    });

    const result = await deactivateFieldUser("u-busy", ADMIN);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("DR-DEL-0042");
    expect(result.error).toContain("6 stops open");

    // The refusal must be a refusal, not a warning followed by the write.
    expect(store.userUpdates).toHaveLength(0);
    expect(store.users[0].deletedAt).toBeNull();
    expect(store.users[0].status).toBe("ACTIVE");
  });

  it("refuses somebody holding an unfinished pickup", async () => {
    const { deactivateFieldUser } = await import("./field-staff-service");

    store.users.push(fieldUser({ id: "u-pick", name: "Sunita Rao" }));
    store.assignments.push({
      number: "PU-DEL-0117",
      assignedToId: "u-pick",
      status: "IN_PROGRESS",
      supersededAt: null,
    });

    const result = await deactivateFieldUser("u-pick", ADMIN);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("PU-DEL-0117");
    expect(store.userUpdates).toHaveLength(0);
  });

  it("ignores work that is already closed or has been handed on", async () => {
    const { deactivateFieldUser } = await import("./field-staff-service");

    store.users.push(fieldUser({ id: "u-idle" }));
    store.runs.push({
      number: "DR-DEL-0031",
      status: "COMPLETED",
      agentId: "u-idle",
      stopsRemaining: 0,
    });
    // Reassigned away yesterday: superseded rows are history, not a hold.
    store.assignments.push({
      number: "PU-DEL-0009",
      assignedToId: "u-idle",
      status: "ASSIGNED",
      supersededAt: new Date("2026-08-29T10:00:00.000Z"),
    });

    const result = await deactivateFieldUser("u-idle", ADMIN);

    expect(result.ok).toBe(true);
  });

  it("deactivates an idle field user and revokes their sessions", async () => {
    const { deactivateFieldUser } = await import("./field-staff-service");

    store.users.push(fieldUser({ id: "u-idle", name: "Imran Sheikh" }));

    const result = await deactivateFieldUser("u-idle", ADMIN);

    expect(result).toEqual({ ok: true, name: "Imran Sheikh" });
    expect(store.users[0].status).toBe("INACTIVE");
    expect(store.users[0].deletedAt).toBeInstanceOf(Date);
    expect(store.sessionUpdates).toHaveLength(1);
  });

  it("refuses to let an administrator lock themselves out", async () => {
    const { deactivateFieldUser } = await import("./field-staff-service");

    store.users.push(fieldUser({ id: ADMIN.id, isFieldUser: false }));

    const result = await deactivateFieldUser(ADMIN.id, ADMIN);

    expect(result.ok).toBe(false);
    expect(store.userUpdates).toHaveLength(0);
  });

  it("refuses an actor without user.manage", async () => {
    const { deactivateFieldUser } = await import("./field-staff-service");

    store.users.push(fieldUser({ id: "u-idle" }));

    const result = await deactivateFieldUser("u-idle", {
      ...ADMIN,
      id: "u-clerk",
      permissions: new Set(["user.read"]),
    });

    expect(result.ok).toBe(false);
    expect(store.userUpdates).toHaveLength(0);
  });
});

describe("reactivateFieldUser", () => {
  it("clears both the status and the soft delete", async () => {
    const { reactivateFieldUser } = await import("./field-staff-service");

    store.users.push(
      fieldUser({
        id: "u-back",
        name: "Imran Sheikh",
        status: "INACTIVE",
        deletedAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );

    const result = await reactivateFieldUser("u-back", ADMIN);

    expect(result).toEqual({ ok: true, name: "Imran Sheikh" });
    expect(store.users[0].status).toBe("ACTIVE");
    expect(store.users[0].deletedAt).toBeNull();
  });

  it("refuses somebody who is not deactivated", async () => {
    const { reactivateFieldUser } = await import("./field-staff-service");

    store.users.push(fieldUser({ id: "u-idle" }));

    const result = await reactivateFieldUser("u-idle", ADMIN);
    expect(result.ok).toBe(false);
    expect(store.userUpdates).toHaveLength(0);
  });
});

describe("getCurrentUser, against a deactivated row", () => {
  it("resolves an active field user", async () => {
    const { getCurrentUser } = await import("@/lib/auth/session");

    store.users.push(fieldUser({ id: "u-idle", name: "Imran Sheikh" }));
    currentSubject = "u-idle";

    const session = await getCurrentUser();
    expect(session?.name).toBe("Imran Sheikh");
  });

  it("resolves nobody once the account has been deactivated", async () => {
    const { getCurrentUser } = await import("@/lib/auth/session");
    const { deactivateFieldUser } = await import("./field-staff-service");

    store.users.push(fieldUser({ id: "u-idle" }));
    currentSubject = "u-idle";

    expect(await getCurrentUser()).not.toBeNull();

    await deactivateFieldUser("u-idle", ADMIN);

    // Same valid cookie, same subject. The login dies on the next request
    // because the row is re-read every time, which is why no second check
    // was added anywhere for deactivation.
    expect(await getCurrentUser()).toBeNull();
  });

  it("resolves nobody for a row that is merely not ACTIVE", async () => {
    const { getCurrentUser } = await import("@/lib/auth/session");

    store.users.push(fieldUser({ id: "u-susp", status: "SUSPENDED" }));
    currentSubject = "u-susp";

    expect(await getCurrentUser()).toBeNull();
  });
});
