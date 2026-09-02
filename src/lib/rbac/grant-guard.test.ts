import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Nobody may grant what they do not hold.
 *
 * This module is the only thing standing between `role.manage` and `*`, and
 * between `user.manage` and `*`. Its own file header says so: tick
 * `settlement.approve` onto a role you already hold, or post the Super Admin
 * role id against your own account from the user screen, and the next
 * request is unrestricted. Both writes were audited, "which is how you find
 * out afterwards, not how you stop it".
 *
 * Nothing imported it from a test or a verify script. `admin/roles/actions.test.ts`
 * and `admin/users/actions.test.ts` both exist and both mock the guard away,
 * so what they prove is that the *call site* asks — not that the answer is
 * right.
 *
 * ── Three implementations of one rule ───────────────────────────────────
 *
 * The rule is written out three times in this file: `permissionsBeyondActor`
 * for the role editor, `rolesBeyondActor` for the user form's submit, and
 * `rolesBeyondArray` behind `grantableRoles` for the field-staff form's role
 * picker. The picker and the submit must agree exactly — a picker that
 * offers a role the submit refuses is the bug `grantableRoles` was added to
 * fix, and a picker that offers a role the submit *accepts* when it should
 * not is the escalation. So they are asserted against each other over the
 * same fixtures rather than separately.
 */

type RoleRow = {
  id: string;
  name: string;
  isActive: boolean;
  codes: string[];
};

const store = vi.hoisted(() => ({
  /** Every role in the organisation. */
  roles: [] as Array<{ id: string; name: string; isActive: boolean; codes: string[] }>,
  /** roleId -> user ids holding it. */
  holders: {} as Record<string, string[]>,
  /** Every `role.findMany` argument, so the queries can be asserted too. */
  queries: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    role: {
      findMany: async (args: {
        where?: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        store.queries.push(args ?? {});
        const where = args?.where ?? {};

        let rows = store.roles;
        if (where.isActive === true) rows = rows.filter((role) => role.isActive);

        const some = (where.users as { some?: { userId?: string } })?.some;
        if (some?.userId) {
          rows = rows.filter((role) => (store.holders[role.id] ?? []).includes(some.userId!));
        }

        const idIn = (where.id as { in?: string[] })?.in;
        if (idIn) rows = rows.filter((role) => idIn.includes(role.id));

        return rows.map((role) => ({
          id: role.id,
          name: role.name,
          permissions: role.codes.map((code) => ({ permission: { code } })),
        }));
      },
    },
  },
}));

const { permissionsBeyondActor, rolesBeyondActor, grantableRoles, escalationMessage } =
  await import("./grant-guard");

function actor(id: string): SessionUser {
  return {
    id,
    orgId: "org-1",
    name: "Administrator",
    mobile: "9999999999",
    email: null,
    isFieldUser: false,
    mustChangePassword: false,
    primaryBranch: null,
    roles: [],
    // Deliberately empty: the guard reads roles from the database rather
    // than trusting the session set, because the session set has already
    // been narrowed to the modules the carrier bought.
    permissions: new Set<string>(),
    scope: "NETWORK",
    branchIds: null,
  } as SessionUser;
}

function role(row: RoleRow) {
  store.roles.push(row);
  return row;
}

/** Gives `userId` the named roles. */
function holds(userId: string, ...roleIds: string[]) {
  for (const roleId of roleIds) {
    store.holders[roleId] = [...(store.holders[roleId] ?? []), userId];
  }
}

/**
 * The fixture is a real ladder, not four unrelated bags of codes: Super
 * Admin ⊃ Branch Administrator ⊃ Delivery Agent, with Accounts off to one
 * side holding the money codes nobody else has. Without the nesting,
 * "allows a role that confers strictly less" would be asserting against a
 * role that in fact confers something extra, and would pass or fail for
 * reasons that have nothing to do with the guard.
 */
const DELIVERY_AGENT: RoleRow = {
  id: "role-agent",
  name: "Delivery Agent",
  isActive: true,
  codes: ["shipment.read", "delivery.execute"],
};
const BRANCH_ADMIN: RoleRow = {
  id: "role-branch-admin",
  name: "Branch Administrator",
  isActive: true,
  codes: [
    "role.manage",
    "user.manage",
    "shipment.read",
    "delivery.assign",
    "delivery.execute",
  ],
};
const SUPER_ADMIN: RoleRow = {
  id: "role-super",
  name: "Super Admin",
  isActive: true,
  codes: [
    ...BRANCH_ADMIN.codes,
    "settlement.approve",
    "invoice.approve",
    "cod.reconcile",
  ],
};
const ACCOUNTS: RoleRow = {
  id: "role-accounts",
  name: "Accounts",
  isActive: true,
  codes: ["invoice.approve", "settlement.approve", "shipment.read"],
};

beforeEach(() => {
  store.roles = [];
  store.holders = {};
  store.queries = [];
  role({ ...SUPER_ADMIN });
  role({ ...BRANCH_ADMIN });
  role({ ...DELIVERY_AGENT });
  role({ ...ACCOUNTS });
  // The branch administrator: holds `role.manage` and `user.manage`, and
  // nothing that spends money. This is the actor the whole module is about.
  holds("usr-branch-admin", BRANCH_ADMIN.id);
  holds("usr-super", SUPER_ADMIN.id);
});

// ── permissionsBeyondActor — the role editor's submit ───────────────────

describe("permissionsBeyondActor", () => {
  it("names the codes an administrator is trying to hand out and does not hold", async () => {
    const beyond = await permissionsBeyondActor(actor("usr-branch-admin"), [
      "shipment.read",
      "settlement.approve",
      "invoice.approve",
      "delivery.assign",
    ]);

    expect(beyond).toEqual(["invoice.approve", "settlement.approve"]);
  });

  it("returns nothing when every code is already held", async () => {
    const beyond = await permissionsBeyondActor(actor("usr-branch-admin"), [
      "role.manage",
      "user.manage",
      "shipment.read",
      "delivery.assign",
    ]);

    expect(beyond).toEqual([]);
  });

  it("lets a Super Admin re-save the Super Admin role", async () => {
    // The header calls this out: comparing against the *narrowed* session
    // set would leave a Super Admin at a carrier that has not bought every
    // module unable to save their own role at all.
    expect(
      await permissionsBeyondActor(actor("usr-super"), SUPER_ADMIN.codes),
    ).toEqual([]);
  });

  it("de-duplicates and sorts, so the refusal message reads once per code", async () => {
    const beyond = await permissionsBeyondActor(actor("usr-branch-admin"), [
      "settlement.approve",
      "settlement.approve",
      "cod.reconcile",
    ]);

    expect(beyond).toEqual(["cod.reconcile", "settlement.approve"]);
  });

  it("holds nothing at all for an actor with no roles", async () => {
    expect(
      await permissionsBeyondActor(actor("usr-nobody"), ["shipment.read"]),
    ).toEqual(["shipment.read"]);
  });

  it("counts only active roles, so a deactivated role stops conferring", async () => {
    store.roles = store.roles.map((row) =>
      row.id === BRANCH_ADMIN.id ? { ...row, isActive: false } : row,
    );

    expect(
      await permissionsBeyondActor(actor("usr-branch-admin"), ["shipment.read"]),
    ).toEqual(["shipment.read"]);
    expect(store.queries[0]).toMatchObject({ where: { isActive: true } });
  });

  it("reads what the actor holds from the database, not from the session", async () => {
    const inflated = {
      ...actor("usr-branch-admin"),
      permissions: new Set(["settlement.approve", "invoice.approve"]),
    } as SessionUser;

    // A session set is narrowed, cached and — for this question — the wrong
    // source. Trusting it would make the guard bypassable by anything that
    // can widen a session.
    expect(await permissionsBeyondActor(inflated, ["settlement.approve"])).toEqual([
      "settlement.approve",
    ]);
  });
});

// ── rolesBeyondActor — the user form's submit ───────────────────────────

describe("rolesBeyondActor", () => {
  it("refuses Super Admin without naming it, by what it confers", async () => {
    const beyond = await rolesBeyondActor(actor("usr-branch-admin"), [SUPER_ADMIN.id]);

    expect(beyond).toHaveLength(1);
    expect(beyond[0].name).toBe("Super Admin");
    expect(beyond[0].codes).toEqual([
      "cod.reconcile",
      "invoice.approve",
      "settlement.approve",
    ]);
    // Not by name: the three codes are the reason, and a role renamed
    // "Regional Head" with the same grants is refused identically.
    expect(JSON.stringify(beyond)).not.toContain("SUPER_ADMIN");
  });

  it("allows a role that confers strictly less than the actor holds", async () => {
    expect(await rolesBeyondActor(actor("usr-branch-admin"), [DELIVERY_AGENT.id])).toEqual(
      [],
    );
  });

  it("reports every offending role, not just the first", async () => {
    const beyond = await rolesBeyondActor(actor("usr-branch-admin"), [
      SUPER_ADMIN.id,
      ACCOUNTS.id,
      DELIVERY_AGENT.id,
    ]);

    expect(beyond.map((entry) => entry.name).sort()).toEqual(["Accounts", "Super Admin"]);
  });

  it("takes no query at all for an empty assignment", async () => {
    expect(await rolesBeyondActor(actor("usr-branch-admin"), [])).toEqual([]);
    expect(store.queries).toHaveLength(0);
  });

  it("lets an actor pass on the role they hold themselves", async () => {
    expect(await rolesBeyondActor(actor("usr-branch-admin"), [BRANCH_ADMIN.id])).toEqual(
      [],
    );
  });
});

// ── grantableRoles — the field-staff form's picker ──────────────────────

describe("grantableRoles", () => {
  it("offers exactly the roles the submit would accept", async () => {
    // The two are separate implementations of one rule. This is the
    // assertion that stops them drifting: a picker offering a role the
    // submit refuses is a trap, and a picker offering one the submit should
    // refuse is the escalation itself.
    const all = store.roles.map((row) => ({ id: row.id, name: row.name }));
    const who = actor("usr-branch-admin");

    const offered = await grantableRoles(who, all);
    const refused = await rolesBeyondActor(
      who,
      all.map((row) => row.id),
    );

    expect(offered.map((row) => row.id).sort()).toEqual(
      all
        .filter((row) => !refused.some((entry) => entry.name === row.name))
        .map((row) => row.id)
        .sort(),
    );
    expect(offered.map((row) => row.name).sort()).toEqual([
      "Branch Administrator",
      "Delivery Agent",
    ]);
  });

  it("offers everything to a Super Admin", async () => {
    const all = store.roles.map((row) => ({ id: row.id, name: row.name }));

    expect((await grantableRoles(actor("usr-super"), all)).map((row) => row.id).sort()).toEqual(
      all.map((row) => row.id).sort(),
    );
  });

  it("offers nothing but the empty list to somebody with no roles", async () => {
    const all = store.roles.map((row) => ({ id: row.id, name: row.name }));

    // Every role confers something, and this actor holds nothing.
    expect(await grantableRoles(actor("usr-nobody"), all)).toEqual([]);
  });

  it("preserves the caller's own row shape and order", async () => {
    const all = [
      { id: DELIVERY_AGENT.id, name: "Delivery Agent", scope: "OWN" as const },
      { id: SUPER_ADMIN.id, name: "Super Admin", scope: "NETWORK" as const },
      { id: BRANCH_ADMIN.id, name: "Branch Administrator", scope: "BRANCH" as const },
    ];

    const offered = await grantableRoles(actor("usr-branch-admin"), all);

    expect(offered).toEqual([all[0], all[2]]);
  });

  it("takes no query for an empty list", async () => {
    expect(await grantableRoles(actor("usr-branch-admin"), [])).toEqual([]);
    expect(store.queries).toHaveLength(0);
  });
});

// ── revocation is deliberately not guarded ──────────────────────────────

describe("revocation stays open", () => {
  /**
   * The header is explicit that taking a permission away is not an
   * escalation, and that an administrator must be able to strip a role of
   * something they do not hold themselves — "otherwise the first response
   * to a compromised role would be blocked by this very guard".
   *
   * The guard has no revoke path to test, so this asserts the shape the
   * call sites rely on: both of them diff and pass only the *additions*, and
   * an empty addition set is always allowed.
   */
  it("allows a save that only removes codes the actor does not hold", async () => {
    const before = ["shipment.read", "settlement.approve"];
    const after = ["shipment.read"];
    const added = after.filter((code) => !before.includes(code));

    expect(await permissionsBeyondActor(actor("usr-branch-admin"), added)).toEqual([]);
  });

  it("allows removing a role the actor could never have granted", async () => {
    const held = [SUPER_ADMIN.id, DELIVERY_AGENT.id];
    const wanted = [DELIVERY_AGENT.id];
    const added = wanted.filter((id) => !held.includes(id));

    expect(await rolesBeyondActor(actor("usr-branch-admin"), added)).toEqual([]);
  });
});

// ── the refusal a person reads ──────────────────────────────────────────

describe("escalationMessage", () => {
  it("names the codes so the administrator knows what to ask for", () => {
    const message = escalationMessage("The role \"Accounts\"", [
      "invoice.approve",
      "settlement.approve",
    ]);

    expect(message).toContain("invoice.approve");
    expect(message).toContain("settlement.approve");
    expect(message).toMatch(/Ask someone who holds them/i);
  });

  it("names four and counts the rest, rather than printing a wall", () => {
    const message = escalationMessage("Saving Super Admin", [
      "a.one",
      "b.two",
      "c.three",
      "d.four",
      "e.five",
      "f.six",
    ]);

    expect(message).toContain("a.one, b.two, c.three, d.four");
    expect(message).toContain("and 2 more");
    expect(message).not.toContain("e.five");
  });

  it("says nothing about a remainder when there is none", () => {
    expect(escalationMessage("Saving X", ["a.one"])).not.toMatch(/more/);
    expect(escalationMessage("Saving X", ["a.one", "b.two", "c.three", "d.four"])).not.toMatch(
      /and \d+ more/,
    );
  });
});
