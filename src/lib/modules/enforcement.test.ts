import { describe, it, expect, beforeEach, vi } from "vitest";
import { MODULES } from "@/lib/modules/modules";
import { modulesForPlan, type ModuleKey } from "@/lib/modules/registry";
import {
  moduleGateFor,
  notOnPlanHref,
  planRefusalCopy,
  NOT_ON_PLAN_PATH,
} from "@/lib/modules/refusal";

/**
 * Enforcement, end to end — the three places a module a carrier has not
 * bought has to be refused.
 *
 * The registry's own arithmetic is tested next door in `registry.test.ts`.
 * What this file asserts is the *wiring*: that the plan on the organisation
 * reaches the session's permission set, that the ops guard turns a path into
 * a refusal, and that the refusal a person sees is the one about money and
 * not the one about roles.
 */

// ── Test doubles for everything `getCurrentUser` reaches ─────────────────
//
// Three of them, and each stands for one real dependency: the tenant's plan
// (prisma-base), the tenant's staff (prisma), and the cookie (Auth.js).

/** The plan features on the organisation the request resolves to. */
let planFeatures: string[] | null = null;

/** The roles the signed-in user holds, as permission codes. */
let rolePermissions: string[] = [];

vi.mock("@/lib/prisma-base", () => ({
  basePrisma: {
    organization: {
      findUnique: async () => ({
        plan: planFeatures === null ? null : { features: planFeatures },
      }),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: async () => ({
        id: "u-1",
        orgId: "org-1",
        name: "Priya Nair",
        mobile: "9810000001",
        email: null,
        status: "ACTIVE",
        isFieldUser: false,
        mustChangePassword: false,
        deletedAt: null,
        primaryBranch: { id: "br-blr", code: "BLR", name: "Bengaluru" },
        branchScopes: [],
        roles: [
          {
            role: {
              code: "BRANCH_MANAGER",
              name: "Branch Manager",
              scope: "BRANCH",
              isActive: true,
              permissions: rolePermissions.map((code) => ({
                permission: { code },
              })),
            },
          },
        ],
      }),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u-1" } }) }));

vi.mock("@/lib/tenant/resolve", () => ({
  resolveTenant: async () => ({ source: "host", orgId: "org-1" }),
  requireTenantOrgId: async () => "org-1",
}));

vi.mock("@/lib/platform/impersonation-session", () => ({
  currentImpersonation: async () => null,
}));

/** The path the proxy stamped, or null for "the proxy is not running". */
let requestPath: string | null = "/dashboard";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(requestPath ? { "x-pathname": requestPath } : {}),
}));

/** Where `redirect()` was sent, so a refusal can be read rather than caught. */
let redirectedTo: string | null = null;

vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    redirectedTo = href;
    // The real one throws to abort the render. Throwing here too means a
    // test that expects an *allowed* route cannot pass by accident because
    // the layout carried on after a refusal.
    throw new Error(`NEXT_REDIRECT:${href}`);
  },
}));

beforeEach(() => {
  planFeatures = null;
  rolePermissions = [];
  requestPath = "/dashboard";
  redirectedTo = null;
});

/** Runs the ops layout's guard and reports what it did. */
async function guard(pathname: string): Promise<string | null> {
  const { requireModuleForPath } = await import("@/lib/modules/guard");
  requestPath = pathname;
  try {
    await requireModuleForPath();
    return null;
  } catch (error) {
    if (redirectedTo) return redirectedTo;
    throw error;
  }
}

// ── 1. The session ───────────────────────────────────────────────────────

describe("a session on a plan that does not include billing", () => {
  // The permissions a branch manager holds in the database. The role is
  // identical in both tests below; only the plan moves.
  const BRANCH_MANAGER = [
    "shipment.read",
    "shipment.create",
    "invoice.read",
    "invoice.create",
    "invoice.approve",
    "delivery.read",
  ];

  it("does not carry a billing permission, and still carries the core one", async () => {
    const { getCurrentUser } = await import("@/lib/auth/session");

    rolePermissions = BRANCH_MANAGER;
    planFeatures = ["lastmile", "dispatch"]; // no billing

    const user = await getCurrentUser();

    expect(user).not.toBeNull();
    // Withheld: `invoice.*` is owned by billing, which was not bought.
    expect(user!.permissions.has("invoice.create")).toBe(false);
    expect(user!.permissions.has("invoice.approve")).toBe(false);
    // Kept: booking is core, and core is on for every carrier on every plan.
    expect(user!.permissions.has("shipment.read")).toBe(true);
    expect(user!.permissions.has("shipment.create")).toBe(true);
  });

  it("carries the same billing permissions once billing is on the plan", async () => {
    const { getCurrentUser } = await import("@/lib/auth/session");

    rolePermissions = BRANCH_MANAGER;
    planFeatures = ["lastmile", "billing"];

    const user = await getCurrentUser();

    // The role was never edited between these two tests. Buying the module
    // restores the permission on the next request, which is the whole reason
    // narrowing is done by subtraction rather than by changing roles.
    expect(user!.permissions.has("invoice.approve")).toBe(true);
    expect(user!.permissions.has("shipment.read")).toBe(true);
  });

  it("gives a carrier with no plan at all the always-on modules only", async () => {
    const { getCurrentUser } = await import("@/lib/auth/session");

    rolePermissions = BRANCH_MANAGER;
    planFeatures = null;

    const user = await getCurrentUser();

    expect(user!.permissions.has("shipment.read")).toBe(true);
    expect(user!.permissions.has("invoice.read")).toBe(false);
    expect(user!.permissions.has("delivery.read")).toBe(false);
  });
});

// ── 2. The route ─────────────────────────────────────────────────────────

describe("the ops layout guard", () => {
  it("refuses a route whose module is absent", async () => {
    planFeatures = ["lastmile"]; // no tracking, no dispatch

    const outcome = await guard("/tracking");

    expect(outcome).toBe(notOnPlanHref("tracking"));
  });

  it("allows the same route once the module is present", async () => {
    planFeatures = ["dispatch", "tracking"];

    expect(await guard("/tracking")).toBeNull();
  });

  it("refuses a nested path, not just the module's root", async () => {
    planFeatures = ["dispatch"];

    expect(await guard("/tracking/trip/trip-9/replay")).toBe(
      notOnPlanHref("tracking"),
    );
  });

  it("refuses a screen whose permission core owns but whose route a module does", async () => {
    // The case the permission layer cannot see: `/masters/sla-policies` is
    // read with `master.read`, which belongs to no module and is therefore
    // never narrowed away. Only the URL says this screen is part of SLA.
    planFeatures = ["lastmile"];

    expect(await guard("/masters/sla-policies")).toBe(notOnPlanHref("sla"));
    // The masters section around it stays open.
    expect(await guard("/masters/zones")).toBeNull();
  });

  it("lets a route no module claims through", async () => {
    planFeatures = null;

    expect(await guard("/dashboard")).toBeNull();
  });

  it("refuses to guess when the request path is missing", async () => {
    const { requireModuleForPath } = await import("@/lib/modules/guard");
    requestPath = null;

    // A deleted proxy must break the app loudly rather than unlock every
    // gated screen quietly.
    await expect(requireModuleForPath()).rejects.toThrow(/x-pathname/);
  });
});

// ── 3. Which refusal ─────────────────────────────────────────────────────

describe("the refusal a person actually reads", () => {
  it("is a different page from the permission 403", async () => {
    planFeatures = ["lastmile"];

    const outcome = await guard("/tracking");

    expect(outcome).toContain(NOT_ON_PLAN_PATH);
    expect(outcome).not.toContain("/forbidden");
  });

  it("names the capability rather than saying access denied", () => {
    const refusal = planRefusalCopy("tracking");

    expect(refusal.moduleLabel).toBe(MODULES.tracking.label);
    expect(refusal.title).toBe("GPS tracking is not on your plan");
  });

  it("says it is a plan matter and rules out the people a 403 sends you to", () => {
    const refusal = planRefusalCopy("billing");

    expect(refusal.body).toMatch(/plan/i);
    expect(refusal.remedy).toMatch(/subscription/i);
    // `/forbidden` tells the reader to ask a branch manager or an
    // administrator, because for a permission they can help. Here they
    // cannot, and the copy must not send anyone to them.
    expect(refusal.remedy).toMatch(/cannot grant it/i);
    expect(refusal.body).not.toMatch(/branch manager|administrator/i);
  });

  it("falls back to a generic sentence for a module the registry does not know", () => {
    // `?module=` arrives from a URL, so it is a hint and never a claim.
    const refusal = planRefusalCopy("<script>alert(1)</script>");

    expect(refusal.moduleLabel).toBeNull();
    expect(refusal.title).toBe("That is not on your plan");
    expect(refusal.body).not.toContain("script");
  });
});

// ── The nav, against the same module set ─────────────────────────────────

describe("nav filtering", () => {
  function granted(features: string[]): ReadonlySet<ModuleKey> {
    return modulesForPlan(features, MODULES);
  }

  it("hides the two links the permission narrowing cannot reach", () => {
    // Both are drawn by permissions that survive narrowing: `delivery.read`
    // is owned by the last mile the carrier *does* have, and `master.read`
    // by no module at all.
    const plan = granted(["lastmile"]);

    expect(moduleGateFor("/delivery/cod", plan).allowed).toBe(false);
    expect(moduleGateFor("/masters/sla-policies", plan).allowed).toBe(false);
    expect(moduleGateFor("/delivery/runs", plan).allowed).toBe(true);
  });

  it("shows them once the modules are bought", () => {
    const plan = granted(["lastmile", "cod", "sla"]);

    expect(moduleGateFor("/delivery/cod", plan).allowed).toBe(true);
    expect(moduleGateFor("/masters/sla-policies", plan).allowed).toBe(true);
  });
});
