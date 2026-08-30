import { MODULES } from "@/lib/modules/modules";
import {
  isModuleKey,
  moduleForRoute,
  type ModuleKey,
} from "@/lib/modules/registry";

/**
 * Deciding, and explaining, that a screen was not bought.
 *
 * Kept free of `next/headers` and `next/navigation` so the decision and the
 * words are testable on their own, and so the client-side nav can import the
 * same predicate the server guard uses rather than a second copy of it.
 */

/**
 * Its own page, not `/forbidden`.
 *
 * The two refusals look identical to a router and are opposite to a human.
 * "You do not have access to this — ask your branch manager" sends someone
 * to a person who cannot help: no role change, no permission grant and no
 * administrator at that carrier can produce a module the company has not
 * bought. Reusing the 403 would cost a support call every time.
 */
export const NOT_ON_PLAN_PATH = "/not-on-plan";

export type ModuleGate =
  | { allowed: true }
  | { allowed: false; module: ModuleKey };

/**
 * Whether a path may be rendered by a tenant holding `granted`.
 *
 * A path no module claims is allowed. That is the registry's rule, not a
 * fallback invented here — see `moduleForRoute`.
 */
export function moduleGateFor(
  pathname: string,
  granted: ReadonlySet<ModuleKey>,
): ModuleGate {
  const key = moduleForRoute(pathname, MODULES);
  if (!key || granted.has(key)) return { allowed: true };
  return { allowed: false, module: key };
}

export function notOnPlanHref(module: ModuleKey): string {
  return `${NOT_ON_PLAN_PATH}?module=${encodeURIComponent(module)}`;
}

export type PlanRefusal = {
  /** Null when the URL named a module the registry does not know. */
  moduleLabel: string | null;
  /** What the module does, in the words the plan is sold in. */
  moduleDescription: string | null;
  title: string;
  body: string;
  /** Who can actually fix it — the whole point of a separate page. */
  remedy: string;
};

/**
 * The words on the refusal page.
 *
 * Names the capability, because "Live tracking is not on your plan" tells
 * someone what they were reaching for and "Access denied" does not. The
 * remedy line names a subscription owner and explicitly rules out the people
 * a 403 would have sent them to, so nobody spends a morning asking an
 * administrator for a permission that would change nothing.
 */
export function planRefusalCopy(module: string | null | undefined): PlanRefusal {
  const definition =
    module && isModuleKey(module) ? MODULES[module] : undefined;

  const remedy =
    "Only whoever manages your company's subscription with us can add it. " +
    "A branch manager or an administrator here cannot grant it — there is " +
    "no permission to turn on.";

  if (!definition) {
    return {
      moduleLabel: null,
      moduleDescription: null,
      title: "That is not on your plan",
      body: "This part of the product is sold separately, and your company's plan does not include it.",
      remedy,
    };
  }

  return {
    moduleLabel: definition.label,
    moduleDescription: definition.description,
    title: `${definition.label} is not on your plan`,
    body: `${definition.label} is sold separately, and your company's plan does not include it.`,
    remedy,
  };
}
