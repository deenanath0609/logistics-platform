import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "@/lib/modules/modules";
import {
  MODULE_KEYS,
  moduleForRoute,
  modulesForPlan,
  narrowToModules,
  type ModuleDefinition,
  type ModuleKey,
} from "@/lib/modules/registry";
import { NAV } from "@/components/shell/nav";
import { PERMISSION_CODES, PERMISSIONS } from "@/lib/rbac/permissions";

/**
 * The drift test matters more than the data it checks.
 *
 * `MODULES` will rot: someone adds a screen next month and does not think
 * about plans, because thinking about plans is not what they were doing.
 * A screen no module claims is a screen `moduleForRoute` returns null for,
 * and null means ungated — the new capability is quietly free on every plan.
 *
 * So the route inventory is walked off the filesystem rather than listed
 * here. A hard-coded list would keep passing while the app grew past it,
 * which is the one failure mode this file exists to prevent.
 */

const APP_DIR = path.resolve(import.meta.dirname, "../../app");

/** The route groups a tenant's users actually browse. */
const BROWSED_GROUPS = ["(ops)", "(portal)", "(field)"];

function pageFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...pageFilesUnder(full));
    else if (entry.name === "page.tsx") found.push(full);
  }
  return found;
}

/**
 * The URL a `page.tsx` answers on.
 *
 * Route groups vanish from the path — `(ops)/hub/page.tsx` is `/hub` — and
 * dynamic segments are left as written, since `[id]` still sits inside its
 * parent's prefix and that is all prefix matching cares about.
 */
function routeForPageFile(file: string): string {
  const segments = path
    .relative(APP_DIR, path.dirname(file))
    .split(path.sep)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")));
  return `/${segments.join("/")}`;
}

const ROUTES = BROWSED_GROUPS.flatMap((group) =>
  pageFilesUnder(path.join(APP_DIR, group)).map(routeForPageFile),
).sort();

/** Every module a key drags in with it, itself included. */
function withRequires(key: ModuleKey, seen = new Set<ModuleKey>()): Set<ModuleKey> {
  if (seen.has(key)) return seen;
  seen.add(key);
  for (const need of MODULES[key].requires ?? []) withRequires(need, seen);
  return seen;
}

const OWNER_OF_PERMISSION = new Map<string, ModuleKey>();
for (const key of MODULE_KEYS) {
  for (const code of MODULES[key].permissions) OWNER_OF_PERMISSION.set(code, key);
}

describe("the registry is complete", () => {
  it("defines every key exactly once, keyed by itself", () => {
    for (const key of MODULE_KEYS) {
      expect(MODULES[key]).toBeDefined();
      expect(MODULES[key].key).toBe(key);
    }
    expect(Object.keys(MODULES).sort()).toEqual([...MODULE_KEYS].sort());
  });

  it("gives every module a label and a description", () => {
    for (const key of MODULE_KEYS) {
      expect(MODULES[key].label.length).toBeGreaterThan(0);
      expect(MODULES[key].description.length).toBeGreaterThan(0);
    }
  });

  it("names only permissions that exist in the catalogue", () => {
    const unknown = [...OWNER_OF_PERMISSION.keys()].filter(
      (code) => !PERMISSION_CODES.includes(code),
    );
    expect(unknown).toEqual([]);
  });

  it("requires only modules that exist, and never itself", () => {
    for (const key of MODULE_KEYS) {
      for (const need of MODULES[key].requires ?? []) {
        expect(MODULE_KEYS).toContain(need);
        expect(need).not.toBe(key);
      }
    }
  });
});

describe("route coverage", () => {
  it("finds the screens on disk at all", () => {
    // A broken walk would make every other assertion here vacuously true.
    expect(ROUTES.length).toBeGreaterThan(50);
    expect(ROUTES).toContain("/delivery/cod");
    expect(ROUTES).toContain("/portal");
  });

  it("resolves every screen to a module", () => {
    const unclaimed = ROUTES.filter((route) => moduleForRoute(route, MODULES) === null);
    expect(unclaimed).toEqual([]);
  });

  it("claims no prefix that leads nowhere", () => {
    // A prefix with no screen under it is either a typo or a screen that was
    // deleted, and either way it is a gate on a door that is not there.
    const empty: string[] = [];
    for (const key of MODULE_KEYS) {
      for (const prefix of MODULES[key].routes) {
        const used = ROUTES.some(
          (route) => route === prefix || route.startsWith(`${prefix}/`),
        );
        if (!used) empty.push(`${key}: ${prefix}`);
      }
    }
    expect(empty).toEqual([]);
  });

  it("has no routes for e-commerce, which is a lens and not a section", () => {
    // Asserted rather than assumed: if someone builds a seller console they
    // should have to come here and say so.
    expect(MODULES.ecommerce.routes).toEqual([]);
  });
});

describe("moduleForRoute prefers the longest prefix", () => {
  it("gives COD its own carve-out inside the last mile", () => {
    expect(moduleForRoute("/delivery/cod", MODULES)).toBe("cod");
    expect(moduleForRoute("/delivery/runs", MODULES)).toBe("lastmile");
    expect(moduleForRoute("/delivery", MODULES)).toBe("lastmile");
  });

  it("gives SLA policies their own carve-out inside masters", () => {
    expect(moduleForRoute("/masters/sla-policies", MODULES)).toBe("sla");
    expect(moduleForRoute("/masters/sla-policies/escalations", MODULES)).toBe("sla");
    expect(moduleForRoute("/masters/cities", MODULES)).toBe("core");
  });

  it("matches on a segment boundary, not on a string prefix", () => {
    // `/tracking-beta` must not fall into `/tracking`.
    expect(moduleForRoute("/tracking-beta", MODULES)).toBeNull();
  });

  it("returns null for a path nobody claims", () => {
    expect(moduleForRoute("/nowhere", MODULES)).toBeNull();
  });
});

describe("navigation agrees with the registry", () => {
  const items = NAV.flatMap((group) => group.items);
  const moduleOfRoute = new Map(
    ROUTES.map((route) => [route, moduleForRoute(route, MODULES)] as const),
  );

  it("has items to check", () => {
    expect(items.length).toBeGreaterThan(40);
  });

  it("points every item at a screen that exists", () => {
    const dangling = items.filter((item) => !moduleOfRoute.has(item.href));
    expect(dangling.map((item) => item.href)).toEqual([]);
  });

  it("resolves every item to the same module as the page it opens", () => {
    for (const item of items) {
      const fromHref = moduleForRoute(item.href, MODULES);
      expect(fromHref, item.href).not.toBeNull();
      expect(fromHref, item.href).toBe(moduleOfRoute.get(item.href));
    }
  });

  it("guards each item with a permission its own module can hold", () => {
    // Route gating and permission gating have to agree. An item whose
    // permission belongs to some other module would either vanish for a
    // carrier who bought the section it sits in, or survive for one who did
    // not — the two halves of enforcement disagreeing in the nav is the
    // cheapest place to catch that.
    const mismatched: string[] = [];
    for (const item of items) {
      // Every code that opens the entry, not just the primary one: an
      // alternative belonging to another module would let the link survive
      // for a carrier who did not buy the section it sits in, which is the
      // same disagreement this test exists to catch.
      const codes = [item.permission, ...(item.orPermissions ?? [])].filter(
        (code): code is string => Boolean(code),
      );
      for (const code of codes) {
        // A null permission is an entry shown to everybody — Help — and
        // there is nothing for a module to own.
        const owner = OWNER_OF_PERMISSION.get(code);
        if (!owner) continue; // Unowned permissions are core's, and core is universal.
        const key = moduleForRoute(item.href, MODULES);
        if (!key || !withRequires(key).has(owner)) {
          mismatched.push(`${item.href} needs ${code} (${owner}), sits in ${key}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });
});

describe("permission ownership", () => {
  it("gives no permission to two modules", () => {
    const claims = new Map<string, ModuleKey[]>();
    for (const key of MODULE_KEYS) {
      for (const code of MODULES[key].permissions) {
        claims.set(code, [...(claims.get(code) ?? []), key]);
      }
    }
    const shared = [...claims.entries()].filter(([, keys]) => keys.length > 1);
    expect(shared).toEqual([]);
  });

  it("leaves the permissions behind always-on capability unowned", () => {
    // Booking and self-administration are core, and core is on for everyone.
    // Listing them under an `alwaysOn` module would read as a claim that
    // something could withhold them.
    for (const code of ["shipment.read", "shipment.create", "user.manage", "master.read"]) {
      expect(OWNER_OF_PERMISSION.get(code)).toBeUndefined();
    }
    expect(MODULES.core.permissions).toEqual([]);
  });

  /**
   * The drift that actually happened.
   *
   * `settlement.prepare` was added to the catalogue under `finance` and
   * never added here, so no module owned it — and a permission no module
   * owns is never narrowed out of a session. `prepareSettlementAction`
   * checks it, server actions do not pass the layout's URL guard, and a
   * carrier who had not bought billing could draft a driver payout.
   *
   * Checked by walking the catalogue rather than by naming the code, so the
   * next finance permission somebody adds fails here instead of shipping.
   */
  it("claims every finance permission in the catalogue for billing", () => {
    const unowned = PERMISSIONS.filter(
      (permission) =>
        permission.module === "finance" &&
        OWNER_OF_PERMISSION.get(permission.code) !== "billing",
    ).map((permission) => permission.code);

    expect(unowned).toEqual([]);
  });

  it("owns the permissions that are meaningless without the module", () => {
    expect(OWNER_OF_PERMISSION.get("invoice.approve")).toBe("billing");
    expect(OWNER_OF_PERMISSION.get("cod.reconcile")).toBe("cod");
    expect(OWNER_OF_PERMISSION.get("geofence.manage")).toBe("tracking");
    expect(OWNER_OF_PERMISSION.get("apikey.manage")).toBe("integrations");
  });
});

describe("modulesForPlan", () => {
  it("grants the always-on modules to a tenant with no plan at all", () => {
    const alwaysOn = MODULE_KEYS.filter((key) => MODULES[key].alwaysOn);
    expect([...modulesForPlan(null, MODULES)]).toEqual(alwaysOn);
    expect([...modulesForPlan([], MODULES)]).toEqual(alwaysOn);
    expect(alwaysOn).toContain("core");
  });

  it("drops a feature string that is not a module", () => {
    // `features` is a free `String[]` typed into a form. "gps" was the old
    // spelling and must not silently grant tracking.
    const granted = modulesForPlan(["gps", "hub", ""], MODULES);
    expect(granted.has("hub")).toBe(true);
    expect(granted.has("tracking")).toBe(false);
    expect(granted.size).toBe(2); // hub plus core
  });

  it("keeps a module whose prerequisite is present", () => {
    const granted = modulesForPlan(["lastmile", "cod", "billing"], MODULES);
    expect([...granted].sort()).toEqual(["billing", "cod", "core", "lastmile"]);
  });

  it("drops a module whose prerequisite is missing", () => {
    const granted = modulesForPlan(["cod", "billing", "tracking"], MODULES);
    expect(granted.has("cod")).toBe(false);
    expect(granted.has("billing")).toBe(false);
    expect(granted.has("tracking")).toBe(false);
  });

  it("drops e-commerce without the last mile and the cash handling it assumes", () => {
    expect(modulesForPlan(["ecommerce", "lastmile"], MODULES).has("ecommerce")).toBe(false);
    expect(
      modulesForPlan(["ecommerce", "lastmile", "cod"], MODULES).has("ecommerce"),
    ).toBe(true);
  });

  it("drops a module transitively, through a prerequisite it never named", () => {
    // Proved on a fixture rather than on live data: the settling loop has to
    // hold whatever shape the dependencies take next quarter. `insights`
    // here knows nothing of `integrations` — it loses `portal`, and goes
    // with it.
    const chained: Record<ModuleKey, ModuleDefinition> = {
      ...MODULES,
      portal: { ...MODULES.portal, requires: ["integrations"] },
      insights: { ...MODULES.insights, requires: ["portal"] },
    };

    expect([...modulesForPlan(["insights", "portal"], chained)]).toEqual(["core"]);
    expect(
      [...modulesForPlan(["insights", "portal", "integrations"], chained)].sort(),
    ).toEqual(["core", "insights", "integrations", "portal"]);
  });
});

describe("narrowToModules", () => {
  const accountsRole = [
    "shipment.read",
    "invoice.read",
    "invoice.approve",
    "cod.reconcile",
    "report.export",
  ];

  it("keeps everything a full plan bought", () => {
    const granted = modulesForPlan(
      ["lastmile", "cod", "billing", "insights"],
      MODULES,
    );
    expect([...narrowToModules(accountsRole, granted, MODULES)].sort()).toEqual(
      [...accountsRole].sort(),
    );
  });

  it("withholds the permissions behind a module the carrier never bought", () => {
    const granted = modulesForPlan(["lastmile"], MODULES);
    const kept = narrowToModules(accountsRole, granted, MODULES);

    // Booking survives on the barest plan there is; billing, COD and
    // analytics do not, and the server action checking `invoice.approve`
    // never learns why.
    expect([...kept]).toEqual(["shipment.read"]);
  });
});

/**
 * The drift that a URL guard cannot catch.
 *
 * `requireModuleForPath()` runs in the ops layout, and a layout is rendered
 * for pages. A **server action** and a **route handler** render no layout:
 * they are addressed directly and they answer directly. What gates those is
 * the other half of enforcement — the session's permission set has already
 * had the unbought modules subtracted — and that half only works when the
 * permission the action checks is one some module actually owns.
 *
 * A permission no module owns is never withheld from anybody. So an action
 * sitting inside a module's routes and guarded by an unowned permission is
 * ungated, however carefully the screen above it was gated. That is not a
 * hypothetical: `settlement.prepare` shipped that way, and `testLane` on the
 * SLA policy screen was found the same week.
 *
 * This walks the app directory rather than listing the files, for the same
 * reason the route inventory above does: the next one will be written by
 * somebody who was not thinking about plans.
 */
describe("doors that run no layout", () => {
  const ACTION_DIRS = ["(ops)", "(field)"];

  /**
   * Actions whose permission is core *and correctly so*, inside a module's
   * routes. Each is a core capability that happens to be administered from a
   * module's screen — not a module capability reached by the wrong door.
   */
  const CORE_WORK_ON_A_MODULE_SCREEN: Record<string, string> = {
    // Setting a customer's credit limit and terms is a party capability: it
    // governs whether a booking may go out on credit, which every carrier
    // does whether or not they invoice through us. It is edited from the
    // receivables screen because that is where somebody thinks about it, and
    // `/finance` is the only screen that offers it — worth revisiting, but
    // gating it on billing would take a core capability away.
    "(ops)/finance/receivables/actions.ts": "customer.manage_credit",
  };

  function sourceFilesUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...sourceFilesUnder(full));
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
        found.push(full);
      }
    }
    return found;
  }

  function routeOf(file: string): string {
    const segments = path
      .relative(APP_DIR, path.dirname(file))
      .split(path.sep)
      .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")));
    return `/${segments.join("/")}`;
  }

  const files = ACTION_DIRS.flatMap((group) =>
    sourceFilesUnder(path.join(APP_DIR, group)),
  );

  it("finds the action files on disk at all", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("gates every action inside a module on that module", () => {
    const holes: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const isServerAction = /["']use server["']/.test(source);
      const isRouteHandler = path.basename(file) === "route.ts";
      if (!isServerAction && !isRouteHandler) continue;

      const key = moduleForRoute(routeOf(file), MODULES);
      // No module, or an always-on one: nothing is withheld either way.
      if (!key || MODULES[key].alwaysOn) continue;

      // An explicit `hasModule("x")` is the other correct answer, and the
      // one `testLane` uses: the action names the module itself rather than
      // relying on a permission to stand for it.
      if (source.includes("hasModule(")) continue;

      const allowed = withRequires(key);
      const relative = path.relative(APP_DIR, file).split(path.sep).join("/");

      const codes = new Set(
        [...source.matchAll(/\b(?:authorize|requirePermission)\(\s*["']([^"']+)["']/g)].map(
          (match) => match[1],
        ),
      );

      for (const code of codes) {
        if (CORE_WORK_ON_A_MODULE_SCREEN[relative] === code) continue;
        const owner = OWNER_OF_PERMISSION.get(code);
        if (owner && allowed.has(owner)) continue;
        holes.push(
          `${relative} is inside "${key}" but is gated on "${code}", which ` +
            `${owner ? `belongs to "${owner}"` : "no module owns"}`,
        );
      }
    }

    expect(holes).toEqual([]);
  });

  /**
   * Route handlers under `/api` sit outside every module's route prefixes,
   * so the walk above cannot reach them and `moduleForRoute` answers null —
   * which means "ungated", correctly, only when the door really is core.
   *
   * Listed rather than inferred, because there is nothing in the path to
   * infer from. A new handler here has to be classified by whoever adds it.
   */
  it("classifies every handler under /api as core or module-gated", () => {
    const CORE_APIS = [
      "api/auth", // Signing in is not an upsell.
      "api/health", // Liveness, no tenant data.
      "api/pincodes", // Serviceability lookup for the booking form.
      "api/v1", // Gated inside `_lib/guard.ts`, for every endpoint at once.
    ];

    const unclassified: string[] = [];

    for (const file of sourceFilesUnder(path.join(APP_DIR, "api"))) {
      if (path.basename(file) !== "route.ts") continue;
      const relative = path.relative(APP_DIR, file).split(path.sep).join("/");
      if (CORE_APIS.some((prefix) => relative.startsWith(prefix))) continue;

      const source = readFileSync(file, "utf8");
      if (/modulesForOrg\(|hasModule\(/.test(source)) continue;

      unclassified.push(relative);
    }

    expect(unclassified).toEqual([]);
  });
});
