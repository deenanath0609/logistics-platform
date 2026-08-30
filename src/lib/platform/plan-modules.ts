import { MODULES } from "@/lib/modules/modules";
import {
  MODULE_KEYS,
  isModuleKey,
  modulesForPlan,
  type ModuleDefinition,
  type ModuleKey,
} from "@/lib/modules/registry";

/**
 * The registry, read the way a plan screen needs to read it.
 *
 * `TenantPlan.features` is a bare `String[]` in the database, so three
 * different things can be sitting in that column at once: keys that name a
 * real module, keys that name a real module the plan cannot actually grant
 * because a prerequisite is absent, and strings left over from when the
 * column was free text. The console has to show all three differently —
 * one is fine, one is a mis-sold plan, one is a data fix — and both the
 * editor and the two read-only screens need the same answer, so the answer
 * is computed once, here, rather than three times in JSX.
 *
 * Nothing in this file writes. It is presentation logic that happens to be
 * pure, which is also what makes it testable without a database.
 */

export type ModuleGroup = {
  title: string;
  /** Why these belong together, for the operator choosing between them. */
  description: string;
  keys: ModuleKey[];
};

/**
 * How the editor lays the catalogue out.
 *
 * Grouping is a selling decision, not a property of a module, which is why
 * it lives in the console and not in the registry: the registry describes
 * what a module *is*, and this describes the order somebody walks through
 * them in a sales conversation — move the freight, get paid for it, show
 * the customer, then plug it into whatever else they run.
 */
export const MODULE_GROUPS: ModuleGroup[] = [
  {
    title: "Moving freight",
    description:
      "The operational spine. Each one adds a stage of the journey the carrier can run inside the platform.",
    keys: ["hub", "dispatch", "lastmile"],
  },
  {
    title: "Getting paid",
    description:
      "Money that moves with the consignment, and money invoiced after it.",
    keys: ["cod", "billing"],
  },
  {
    title: "What the customer sees",
    description:
      "Everything the carrier's own customers touch, rather than the carrier's staff.",
    keys: ["tracking", "sla", "portal"],
  },
  {
    title: "Other systems",
    description: "Where the platform stops being the only thing in the room.",
    keys: ["ecommerce", "integrations", "insights"],
  },
];

/** Modules on every plan, in registry order. */
export function alwaysOnModules(): ModuleKey[] {
  return MODULE_KEYS.filter((key) => MODULES[key]?.alwaysOn);
}

/**
 * Keys the registry has that `MODULE_GROUPS` above does not mention.
 *
 * A module added to the registry by somebody who did not know this file
 * exists must not silently become unsellable. It surfaces in the editor
 * under its own heading instead — visibly unplaced, which is a nudge to
 * place it, rather than invisible.
 */
export function ungroupedModules(): ModuleKey[] {
  const placed = new Set(MODULE_GROUPS.flatMap((group) => group.keys));
  return MODULE_KEYS.filter(
    (key) => !placed.has(key) && !MODULES[key]?.alwaysOn,
  );
}

export function moduleDefinition(key: ModuleKey): ModuleDefinition {
  return MODULES[key];
}

/** Strings stored in `features` that name no module at all. */
export function unrecognisedFeatures(
  features: readonly string[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const feature of features ?? []) {
    if (isModuleKey(feature) || seen.has(feature)) continue;
    seen.add(feature);
    out.push(feature);
  }
  return out;
}

/**
 * What actually gets stored when a plan is saved.
 *
 * Deduplicated, put back into registry order so a diff of the column reads
 * the same way twice, and with the `alwaysOn` modules forced in. Forcing
 * them is deliberate: `modulesForPlan` grants them regardless, so a stored
 * list that omits core would describe a plan that does not exist. The
 * column should say what the plan is, not what somebody happened to tick.
 */
export function canonicalPlanFeatures(
  features: readonly string[] | null | undefined,
): ModuleKey[] {
  const chosen = new Set<ModuleKey>(alwaysOnModules());
  for (const feature of features ?? []) {
    if (isModuleKey(feature)) chosen.add(feature);
  }
  return MODULE_KEYS.filter((key) => chosen.has(key));
}

export type BlockedModule = {
  key: ModuleKey;
  /** Prerequisites not present, so the message can name them. */
  missing: ModuleKey[];
};

export type ModuleAudit = {
  /** What the carrier actually has — `modulesForPlan`, not the raw column. */
  granted: ModuleKey[];
  /** Listed on the plan, but dropped for want of a prerequisite. */
  blocked: BlockedModule[];
  /** Stored strings that name nothing. Shown, never silently dropped. */
  unrecognised: string[];
};

/**
 * The three-way split, for one stored feature list.
 *
 * `granted` is deliberately taken from `modulesForPlan` rather than
 * recomputed here. A tenant screen that re-derived the rule would drift
 * from the rule the session and the nav actually enforce, and would then
 * confidently show an operator a module the carrier cannot open.
 */
export function auditPlanModules(
  features: readonly string[] | null | undefined,
): ModuleAudit {
  const granted = modulesForPlan(features ?? [], MODULES);

  const listed = new Set<ModuleKey>(alwaysOnModules());
  for (const feature of features ?? []) {
    if (isModuleKey(feature)) listed.add(feature);
  }

  const blocked: BlockedModule[] = [];
  for (const key of MODULE_KEYS) {
    if (!listed.has(key) || granted.has(key)) continue;
    blocked.push({
      key,
      missing: (MODULES[key]?.requires ?? []).filter(
        (need) => !granted.has(need),
      ),
    });
  }

  return {
    granted: MODULE_KEYS.filter((key) => granted.has(key)),
    blocked,
    unrecognised: unrecognisedFeatures(features),
  };
}

/**
 * Why one module is not granted, in a sentence an operator can act on.
 *
 * Named after the labels rather than the keys — the person reading it is
 * choosing what to sell, and "needs Last mile" is a thing they can fix by
 * ticking a box, where "needs `lastmile`" is a thing they have to decode.
 */
export function blockedReason(blocked: BlockedModule): string {
  const label = MODULES[blocked.key]?.label ?? blocked.key;
  if (blocked.missing.length === 0) {
    // Nothing directly missing means the prerequisite itself fell out for
    // want of its own prerequisite. Saying so beats naming a module the
    // operator can see is already ticked.
    return `${label} needs a module that is itself unavailable.`;
  }
  const needs = blocked.missing
    .map((key) => MODULES[key]?.label ?? key)
    .join(" and ");
  return `${label} needs ${needs}.`;
}

/**
 * The message a save is refused with when the list contains a non-key.
 *
 * Refusing rather than filtering is the point of the whole change: typing
 * `bilingg` used to store `bilingg` and grant nothing, and the plan looked
 * fine on every screen until a carrier asked why they had no invoices.
 */
export function unknownModuleProblem(
  features: readonly string[] | null | undefined,
): string | null {
  const unknown = unrecognisedFeatures(features);
  if (unknown.length === 0) return null;
  return `${unknown.join(", ")} ${unknown.length === 1 ? "is not a module" : "are not modules"}. Plans are sold in modules — pick from the list rather than typing a key.`;
}
