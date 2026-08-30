/**
 * What a carrier bought.
 *
 * Permissions answer "may this person do it". Modules answer a different
 * question — "did this company pay for it" — and the two are independent: a
 * branch manager holds `invoice.read` whether or not their carrier is on a
 * plan that includes billing. Conflating them would mean editing every
 * role on every tenant whenever a plan changed.
 *
 * A module is the unit a plan is sold in. It owns route prefixes, nav
 * entries and the permissions that only make sense inside it, so switching
 * one off removes a whole capability rather than leaving a half-lit screen.
 *
 * See docs/adr/001-multi-tenancy.md for the tenancy this sits on.
 */

export const MODULE_KEYS = [
  "core",
  "hub",
  "dispatch",
  "lastmile",
  "cod",
  "billing",
  "tracking",
  "sla",
  "portal",
  "ecommerce",
  "integrations",
  "insights",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export type ModuleDefinition = {
  key: ModuleKey;
  /** Shown in the plan editor and on a tenant's detail screen. */
  label: string;
  /** One line, written for whoever is choosing a plan — not for us. */
  description: string;
  /**
   * Always on, for every carrier, on every plan. Booking a consignment and
   * administering your own staff are not upsells; a plan that could switch
   * them off would be a plan that sells nothing.
   */
  alwaysOn?: boolean;
  /**
   * Route prefixes this module owns. Matched longest-first, so a more
   * specific prefix wins over a shorter one that would otherwise swallow it.
   */
  routes: string[];
  /**
   * Permissions that exist only inside this module. Used to narrow a role's
   * effective permissions when the module is off, so a server action that
   * checks a permission is also covered without naming the module itself.
   */
  permissions: string[];
  /** Modules that must be present for this one to make sense. */
  requires?: ModuleKey[];
};

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}

/**
 * Turns a plan's stored feature list into the modules it actually grants.
 *
 * Unknown strings are dropped rather than trusted — `features` is a free
 * `String[]` in the database and a typo must not silently grant something.
 * `alwaysOn` modules are added regardless of what the plan says, and a
 * tenant with **no plan at all** gets exactly those: a carrier mid-
 * provisioning can book and administer itself, and nothing more.
 */
export function modulesForPlan(
  features: readonly string[] | null | undefined,
  registry: Readonly<Record<ModuleKey, ModuleDefinition>>,
): Set<ModuleKey> {
  const granted = new Set<ModuleKey>();

  for (const key of MODULE_KEYS) {
    if (registry[key]?.alwaysOn) granted.add(key);
  }

  for (const feature of features ?? []) {
    if (isModuleKey(feature)) granted.add(feature);
  }

  // A module whose prerequisite is missing is not granted. Billing without
  // the last mile it bills for would render screens that cannot be filled.
  let settled = false;
  while (!settled) {
    settled = true;
    for (const key of [...granted]) {
      const needs = registry[key]?.requires ?? [];
      if (needs.some((need) => !granted.has(need))) {
        granted.delete(key);
        settled = false;
      }
    }
  }

  return granted;
}

/**
 * The module that owns a path, or null when no module claims it.
 *
 * Longest prefix wins: `/delivery/cod` belongs to COD even though
 * `/delivery` belongs to the last mile. A path no module claims is not
 * gated — that is deliberate, and the drift test in
 * `registry.test.ts` is what stops it becoming a hole.
 */
export function moduleForRoute(
  pathname: string,
  registry: Readonly<Record<ModuleKey, ModuleDefinition>>,
): ModuleKey | null {
  let best: { key: ModuleKey; length: number } | null = null;

  for (const key of MODULE_KEYS) {
    for (const prefix of registry[key]?.routes ?? []) {
      const matches = pathname === prefix || pathname.startsWith(`${prefix}/`);
      if (matches && (!best || prefix.length > best.length)) {
        best = { key, length: prefix.length };
      }
    }
  }

  return best?.key ?? null;
}

/**
 * The permissions a role keeps once the modules it does not have are
 * removed.
 *
 * This is the quiet half of enforcement. A server action asks "does the
 * actor hold `invoice.write`"; narrowing the permission set at the session
 * means every one of those checks becomes module-aware without a single
 * call site learning what a module is.
 */
export function narrowToModules(
  permissions: Iterable<string>,
  granted: ReadonlySet<ModuleKey>,
  registry: Readonly<Record<ModuleKey, ModuleDefinition>>,
): Set<string> {
  const withheld = new Set<string>();

  for (const key of MODULE_KEYS) {
    if (granted.has(key)) continue;
    for (const permission of registry[key]?.permissions ?? []) {
      withheld.add(permission);
    }
  }

  const kept = new Set<string>();
  for (const permission of permissions) {
    if (!withheld.has(permission)) kept.add(permission);
  }
  return kept;
}
