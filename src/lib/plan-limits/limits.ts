/**
 * Plan limits — the rule, with no database in it.
 *
 * Given a stored cap and a current count, may one more be created, and if
 * not, what is the carrier told. Counting needs a tenant and a connection;
 * deciding does not, which is why the two live in separate files.
 *
 * `TenantPlan` stores each cap as `Int?`, and all three states mean
 * something different:
 *
 *   null   the plan does not cap this — unlimited
 *   0      the feature is off — unavailable at any count
 *   n      a cap of n
 *
 * Null and zero are the pair that gets collapsed by accident, because
 * `if (!limit) return` reads as "no limit" and silently hands over a
 * feature nobody bought. They are answered by separate branches producing
 * separate sentences, and that difference is load-bearing: a carrier told
 * "you have reached your limit of 10" when the truth is "this is not on
 * your plan" will ring up asking to buy more of something the next plan up
 * already includes, and nobody on the call will understand each other.
 */

export const LIMIT_KEYS = [
  "users",
  "branches",
  "shipmentsThisMonth",
  "portalUsers",
] as const;

export type LimitKey = (typeof LIMIT_KEYS)[number];

type LimitWords = {
  /** Heading in the usage panel. */
  label: string;
  /** Reads after a number: "your limit of 10 <countable>". */
  countable: string;
  /**
   * Subject of the "not included" sentence. Always plural, so one template
   * covers all four without a verb lookup.
   */
  feature: string;
};

export const LIMIT_WORDS: Record<LimitKey, LimitWords> = {
  users: {
    label: "Staff users",
    countable: "staff users",
    feature: "Staff logins",
  },
  branches: {
    label: "Branches",
    countable: "branches",
    feature: "Branches",
  },
  shipmentsThisMonth: {
    label: "Shipments this month",
    countable: "shipments a month",
    feature: "Shipment bookings",
  },
  portalUsers: {
    label: "Portal logins",
    countable: "portal logins",
    feature: "Customer portal logins",
  },
};

export type LimitRefusal = "not-included" | "at-capacity";

export type LimitOutcome =
  | { allowed: true }
  | { allowed: false; reason: LimitRefusal };

/** May one more be created, given this cap and this count? */
export function limitOutcome(
  limit: number | null,
  current: number,
): LimitOutcome {
  if (limit === null) return { allowed: true };
  // A negative cap is not a state the plan editor can produce, but treating
  // it as "off" rather than as a number keeps a corrupted row from reading
  // as unlimited.
  if (limit <= 0) return { allowed: false, reason: "not-included" };
  if (current >= limit) return { allowed: false, reason: "at-capacity" };
  return { allowed: true };
}

/** Stands in for a plan name when the carrier has no plan row to name. */
export const UNNAMED_PLAN = "current";

function limitMessage(
  key: LimitKey,
  reason: LimitRefusal,
  limit: number,
  planName: string,
): string {
  const words = LIMIT_WORDS[key];

  if (reason === "not-included") {
    return `${words.feature} are not included in your ${planName} plan.`;
  }
  return `You have reached your limit of ${limit} ${words.countable} on the ${planName} plan.`;
}

/**
 * Thrown at the point of use, carrying the three facts a support call needs:
 * which cap, what it is, and where the carrier already stands.
 *
 * A typed error rather than a `Result`, because the assertion is bolted onto
 * creation paths that each already have their own return shape — server
 * actions returning `ActionState`, `createBooking` returning
 * `BookingResult`, the partner API returning an HTTP envelope. Threading a
 * new failure variant through all of them would be a far wider change than
 * the feature warrants, and a guard that is one line to add is a guard that
 * actually gets added to the next creation path somebody writes.
 */
export class PlanLimitError extends Error {
  constructor(
    readonly key: LimitKey,
    readonly limit: number,
    readonly current: number,
    readonly planName: string,
    readonly reason: LimitRefusal,
  ) {
    super(limitMessage(key, reason, limit, planName));
    this.name = "PlanLimitError";
  }
}

/**
 * `instanceof` with a name fallback: Next re-evaluates modules in
 * development, so the thrower and the catcher can hold two class identities
 * for the same source file.
 */
export function isPlanLimitError(error: unknown): error is PlanLimitError {
  return (
    error instanceof PlanLimitError ||
    (error instanceof Error && error.name === "PlanLimitError")
  );
}
