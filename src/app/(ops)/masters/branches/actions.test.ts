import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A branch is the one master that is also a boundary.
 *
 * `src/app/(ops)/masters` has thirty exported server actions across ten
 * files and no coverage of any kind — no unit test, and no verify script,
 * because a server action is not reachable over HTTP the way a page is.
 * Nine of those files edit lists that belong to the carrier as a whole. This
 * one edits the column every other scope check in the product points at.
 *
 * `guardBranchId` is the whole of the protection. Its own header spells out
 * what it stops: a branch-scoped role holding `branch.manage` — which
 * `/admin/roles` now makes possible — posting another branch's id to rename
 * it, move its address, or deactivate it, which "drops it out of every
 * picker, and the freight already routed to it stops having a destination
 * anybody can choose".
 *
 * ── The trap in testing this ────────────────────────────────────────────
 *
 * The guard deliberately *swallows* a permission failure and returns null,
 * so the CRUD answers it and every master screen words that refusal the
 * same way. It "can only ever add a refusal, never change an existing one".
 *
 * That means a test posting a foreign branch id as an actor who lacks
 * `branch.manage` sees a refusal — from the CRUD, about permissions, with
 * `guardBranchId` deleted just as much as with it present. Every scope test
 * below therefore holds `branch.manage`, and is paired with a control on a
 * branch the same actor *does* cover, which must reach the CRUD.
 */

const store = vi.hoisted(() => ({
  /** Branch ids the actor covers. `null` is network scope. */
  branchIds: null as string[] | null,
  /** Permissions the mocked `authorize` accepts. */
  held: new Set<string>(["branch.manage", "branch.read"]),
  /** Which CRUD entry points were reached, and with what. */
  reached: [] as Array<{ op: string; id: string | null }>,
}));

class PermissionError extends Error {
  constructor(public permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = "PermissionError";
  }
}

vi.mock("@/lib/auth/session", () => ({
  PermissionError,
  authorize: async (permission: string) => {
    if (!store.held.has(permission)) throw new PermissionError(permission);
    return {
      id: "usr-branch-admin",
      orgId: "org-1",
      name: "Branch Administrator",
      permissions: store.held,
      scope: store.branchIds === null ? "NETWORK" : "BRANCH",
      branchIds: store.branchIds,
    };
  },
}));

// The real one — three lines, and the thing under test depends on it being
// exactly those three lines.
vi.mock("@/server/repositories/scope", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/repositories/scope")
  >("@/server/repositories/scope");
  return actual;
});

vi.mock("@/server/services/master-crud", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/services/master-crud")
  >("@/server/services/master-crud");

  const record = (op: string) => async (_prev: unknown, formData: FormData) => {
    store.reached.push({ op, id: (formData.get("id") as string) ?? null });
    return { ok: true, message: `crud ${op}` };
  };

  return {
    ...actual,
    createMasterCrud: () => ({
      create: record("create"),
      update: record("update"),
      setActive: record("setActive"),
      remove: record("remove"),
    }),
  };
});

const { createBranch, updateBranch, setBranchActive } = await import("./actions");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

/** HO-DEL is the branch this administrator runs. HUB-JAI is not. */
const OWN = "br-ho-del";
const FOREIGN = "br-hub-jai";

beforeEach(() => {
  store.branchIds = [OWN];
  store.held = new Set(["branch.manage", "branch.read"]);
  store.reached = [];
});

// ── the boundary ────────────────────────────────────────────────────────

describe("a branch-scoped administrator holding branch.manage", () => {
  it("cannot rename a branch they do not cover, and the CRUD is never reached", async () => {
    const result = await updateBranch({}, form({ id: FOREIGN, name: "Renamed" }));

    expect(result.error).toMatch(/outside the branches you cover/i);
    expect(store.reached).toEqual([]);
  });

  it("cannot deactivate a branch they do not cover, and the CRUD is never reached", async () => {
    const result = await setBranchActive({}, form({ id: FOREIGN, isActive: "false" }));

    expect(result.error).toMatch(/outside the branches you cover/i);
    expect(store.reached).toEqual([]);
  });

  /**
   * The control. Same actor, same permissions, same form, different branch.
   * Without it, both refusals above would read identically if the guard were
   * refusing everything — or if the permission check were doing the work.
   */
  it("can edit and deactivate the branch they do cover", async () => {
    await updateBranch({}, form({ id: OWN, name: "Delhi Head Office" }));
    await setBranchActive({}, form({ id: OWN, isActive: "false" }));

    expect(store.reached).toEqual([
      { op: "update", id: OWN },
      { op: "setActive", id: OWN },
    ]);
  });

  it("covers every branch when the role is network-scoped", async () => {
    store.branchIds = null;

    await updateBranch({}, form({ id: FOREIGN, name: "Jaipur Hub" }));
    await setBranchActive({}, form({ id: FOREIGN, isActive: "false" }));

    expect(store.reached.map((row) => row.op)).toEqual(["update", "setActive"]);
  });

  it("covers exactly the listed branches and nothing adjacent to them", async () => {
    store.branchIds = [OWN, "br-br-ggn"];

    for (const id of [OWN, "br-br-ggn"]) {
      store.reached = [];
      await updateBranch({}, form({ id, name: "Edited" }));
      expect(store.reached, id).toHaveLength(1);
    }

    for (const id of [FOREIGN, `${OWN}-2`, OWN.toUpperCase(), ""]) {
      store.reached = [];
      const result = await updateBranch({}, form({ id, name: "Edited" }));
      if (id === "") {
        // An empty id is the CRUD's refusal to word, not this guard's.
        expect(store.reached, "empty").toHaveLength(1);
      } else {
        expect(result.error, id).toMatch(/outside the branches you cover/i);
        expect(store.reached, id).toHaveLength(0);
      }
    }
  });
});

// ── the guard only ever *adds* a refusal ────────────────────────────────

describe("what the guard deliberately does not answer", () => {
  it("defers a missing permission to the CRUD, rather than blaming scope", async () => {
    // A person without `branch.manage` must be told they lack permission,
    // in the same words every other master screen uses — not told that a
    // branch they were never going to reach is outside their scope.
    store.held = new Set(["branch.read"]);

    const result = await updateBranch({}, form({ id: FOREIGN, name: "Renamed" }));

    // The guard raises nothing of its own and hands the call straight on;
    // the CRUD authorises again and words the refusal. (The CRUD is stubbed
    // here, so what is asserted is the handover, not its answer.)
    expect(result.error ?? "").not.toMatch(/outside the branches you cover/i);
    expect(store.reached).toEqual([{ op: "update", id: FOREIGN }]);
  });

  it("defers a post with no id at all to the CRUD", async () => {
    const result = await updateBranch({}, form({ name: "No id here" }));

    expect(result.error).toBeUndefined();
    expect(store.reached).toEqual([{ op: "update", id: null }]);
  });

  /**
   * Creation is not scope-guarded, and that is written down as a decision:
   * "A new branch has no id to be outside anyone's scope, and the plan cap
   * is what limits it." Pinned so that the asymmetry stays a decision rather
   * than becoming something somebody notices and quietly changes.
   */
  it("does not scope-guard creation, which has no branch to be outside of", async () => {
    const result = await createBranch({}, form({ code: "BR-NEW", name: "New Branch" }));

    expect(result.error).toBeUndefined();
    expect(store.reached).toEqual([{ op: "create", id: null }]);
  });

  it("does not scope-guard creation even when a stray id is posted with it", async () => {
    await createBranch({}, form({ id: FOREIGN, code: "BR-NEW", name: "New Branch" }));

    // `crud.create` ignores the id; the point is that this action is a
    // direct passthrough and gains no guard by accident.
    expect(store.reached).toEqual([{ op: "create", id: FOREIGN }]);
  });
});

describe("the branch CRUD is declared against the branch permissions", () => {
  it("reaches the CRUD for both writes rather than duplicating its checks", async () => {
    // `updateBranch` and `setBranchActive` are wrappers: everything they
    // allow must still pass through the CRUD, which authorises again on
    // both `branch.read` and `branch.manage`.
    await updateBranch({}, form({ id: OWN }));
    await setBranchActive({}, form({ id: OWN }));

    expect(store.reached.map((row) => row.op)).toEqual(["update", "setActive"]);
  });
});
