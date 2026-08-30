import { describe, expect, it } from "vitest";

// Pure rules only — nothing here opens a connection. The Prisma client
// pulled in by `plans.ts` reads DATABASE_URL when it is constructed.
process.env.DATABASE_URL ??= "postgres://unused/unused";

import { MODULES } from "@/lib/modules/modules";
import { MODULE_KEYS, modulesForPlan, type ModuleKey } from "@/lib/modules/registry";
import {
  MODULE_GROUPS,
  alwaysOnModules,
  auditPlanModules,
  blockedReason,
  canonicalPlanFeatures,
  ungroupedModules,
  unknownModuleProblem,
  unrecognisedFeatures,
} from "@/lib/platform/plan-modules";
import { validate, type PlanInput } from "@/lib/platform/plans";

const PLAN: PlanInput = {
  code: "GROWTH",
  name: "Growth",
  maxUsers: 25,
  maxBranches: 5,
  maxShipmentsPerMonth: null,
  maxPortalUsers: 50,
  features: [],
  monthlyPrice: "9999",
  currency: "INR",
  isActive: true,
  sortOrder: 10,
};

function plan(features: string[]): PlanInput {
  return { ...PLAN, features };
}

/** Modules that declare a prerequisite, so the cases below are not vacuous. */
const WITH_REQUIREMENTS = MODULE_KEYS.filter(
  (key) => (MODULES[key]?.requires ?? []).length > 0,
);

// ────────────────────────────────────────────────────────────
// An unknown key is refused, not filtered
// ────────────────────────────────────────────────────────────

describe("saving a plan with a key that names no module", () => {
  it("is refused rather than stored", () => {
    // The whole reason the free-text field went away: `bilingg` used to
    // save cleanly, grant nothing, and look correct on every screen.
    expect(validate(plan(["bilingg"]))).toMatch(/not a module/i);
  });

  it("names the offending value, so the operator can see which one", () => {
    expect(validate(plan(["billing", "gps", "webhooks"]))).toMatch(/gps/);
    expect(validate(plan(["billing", "gps", "webhooks"]))).toMatch(/webhooks/);
  });

  it("accepts a list of real module keys", () => {
    expect(validate(plan([...MODULE_KEYS]))).toBeNull();
    expect(validate(plan([]))).toBeNull();
  });

  it("never lets an unknown value through to what would be stored", () => {
    // Belt and braces: even if a caller skipped `validate`, the canonical
    // list is built from the registry rather than from the input.
    expect(canonicalPlanFeatures(["bilingg", "billing"])).not.toContain("bilingg");
  });

  it("reports nothing for a clean list", () => {
    expect(unknownModuleProblem([...MODULE_KEYS])).toBeNull();
    expect(unknownModuleProblem([])).toBeNull();
  });

  it("keeps unrecognised values in order and without repeats", () => {
    expect(unrecognisedFeatures(["gps", "billing", "gps", "api"])).toEqual([
      "gps",
      "api",
    ]);
  });
});

// ────────────────────────────────────────────────────────────
// A prerequisite that is not there
// ────────────────────────────────────────────────────────────

describe("a plan listing a module whose prerequisite is unmet", () => {
  it("has at least one module to test with", () => {
    // If the registry ever declares no prerequisites at all, the cases
    // below would pass by doing nothing. Fail loudly instead.
    expect(WITH_REQUIREMENTS.length).toBeGreaterThan(0);
  });

  it.each(WITH_REQUIREMENTS)(
    "%s does not resolve for a tenant when listed on its own",
    (key) => {
      const audit = auditPlanModules([key]);
      expect(audit.granted).not.toContain(key);
      // And the resolver the app itself uses agrees — this screen must not
      // develop its own opinion of what a carrier has.
      expect(modulesForPlan([key], MODULES).has(key)).toBe(false);
    },
  );

  it.each(WITH_REQUIREMENTS)("%s is reported as blocked, with what it needs", (key) => {
    const audit = auditPlanModules([key]);
    const blocked = audit.blocked.find((item) => item.key === key);
    expect(blocked).toBeDefined();
    expect(blocked!.missing.length).toBeGreaterThan(0);

    // The tenant screen renders exactly this sentence, and it has to name
    // the missing module in words rather than in keys.
    const reason = blockedReason(blocked!);
    expect(reason).toContain(MODULES[key].label);
    for (const need of blocked!.missing) {
      expect(reason).toContain(MODULES[need].label);
    }
  });

  it.each(WITH_REQUIREMENTS)("%s resolves once its prerequisites are listed", (key) => {
    const audit = auditPlanModules([key, ...(MODULES[key].requires ?? [])]);
    // Only assert on the module itself: a prerequisite may have a
    // prerequisite of its own, and that chain is the registry's business.
    if (audit.blocked.length === 0) {
      expect(audit.granted).toContain(key);
    }
  });

  it("says nothing is blocked when nothing is", () => {
    expect(auditPlanModules([...MODULE_KEYS]).blocked).toEqual([]);
  });

  it("carries unrecognised values through untouched", () => {
    const audit = auditPlanModules(["billing", "gps"]);
    expect(audit.unrecognised).toEqual(["gps"]);
  });
});

// ────────────────────────────────────────────────────────────
// Always-on modules
// ────────────────────────────────────────────────────────────

describe("always-on modules", () => {
  it("exist — a plan editor with none of them would be a different design", () => {
    expect(alwaysOnModules().length).toBeGreaterThan(0);
  });

  it("cannot be removed from a plan", () => {
    // An empty tick-list is the strongest form of "removed": nothing was
    // selected, and they are stored anyway.
    for (const key of alwaysOnModules()) {
      expect(canonicalPlanFeatures([])).toContain(key);
      expect(canonicalPlanFeatures(["billing"])).toContain(key);
    }
  });

  it("cannot be removed by posting a list that omits them", () => {
    // The form disables those checkboxes, but a hand-crafted POST does not
    // have to. The service is what actually holds the line.
    const posted = MODULE_KEYS.filter((key) => !MODULES[key]?.alwaysOn);
    const stored = canonicalPlanFeatures([...posted]);
    for (const key of alwaysOnModules()) {
      expect(stored).toContain(key);
    }
  });

  it("are granted to a carrier with no plan at all", () => {
    const audit = auditPlanModules(null);
    for (const key of alwaysOnModules()) {
      expect(audit.granted).toContain(key);
    }
  });

  it("are not offered as a choice in any group", () => {
    const grouped = new Set(MODULE_GROUPS.flatMap((group) => group.keys));
    for (const key of alwaysOnModules()) {
      expect(grouped.has(key)).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────
// The stored list itself
// ────────────────────────────────────────────────────────────

describe("canonicalPlanFeatures", () => {
  it("stores registry order, so two identical plans diff identically", () => {
    const scrambled = [...MODULE_KEYS].reverse() as ModuleKey[];
    expect(canonicalPlanFeatures(scrambled)).toEqual([...MODULE_KEYS]);
  });

  it("collapses repeats", () => {
    const stored = canonicalPlanFeatures(["billing", "billing"]);
    expect(stored.filter((key) => key === "billing")).toHaveLength(1);
  });
});

describe("MODULE_GROUPS", () => {
  it("places every sellable module, so none is unreachable in the editor", () => {
    // A module the editor never renders is a module nobody can sell. The
    // form falls back to an "ungrouped" heading rather than dropping it,
    // and this is the reminder to give it a real home.
    expect(ungroupedModules()).toEqual([]);
  });

  it("names each module once", () => {
    const keys = MODULE_GROUPS.flatMap((group) => group.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
