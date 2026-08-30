/**
 * Scopes an API key may carry.
 *
 * A deliberate subset of the permission catalogue: an integration books,
 * reads and tracks. Nothing here lets a key cancel a consignment, correct
 * a status, or touch money — those need a person, and the audit trail
 * should name one.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export
 * async functions.
 */
export const API_KEY_SCOPES = [
  { code: "shipment.create", label: "Book shipments" },
  { code: "shipment.read", label: "Read shipment status" },
  { code: "tracking.read", label: "Public tracking payload" },
  { code: "pickup.create", label: "Raise pickup requests" },
  { code: "pickup.read", label: "Read pickup requests" },
] as const;

export const ALLOWED_API_SCOPES = new Set<string>(
  API_KEY_SCOPES.map((scope) => scope.code),
);

/**
 * The scopes a submitted issue-key form asked for.
 *
 * `getAll`, and the reason it matters is the form: one checkbox per scope,
 * every one of them named `scopes`. `formData.get("scopes")` returns the
 * first ticked box and drops the rest silently — no error, no warning —
 * so every multi-scope key issued through that screen was stored with
 * exactly one scope, and the partner discovered it at their end.
 *
 * Separated from `actions.ts` so it can be tested: a `"use server"` module
 * may only export async functions, which makes a helper inside one
 * unreachable from a test.
 */
export function requestedScopes(formData: FormData): string[] {
  return formData
    .getAll("scopes")
    .flatMap((entry) => String(entry).split(/[\s,]+/))
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}
