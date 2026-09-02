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
  // ⚠ `tracking.read` means two different things in this product, and the
  // two have now met. Here it is "the thin public payload a website widget
  // may show anyone"; in the permission catalogue it is "View live vehicle
  // tracking", and `src/lib/modules/modules.ts` gives it to the GPS
  // `tracking` module. Since `withApiKey` narrows a key's actor to the
  // modules the carrier bought — as every other door into the product is
  // narrowed — a carrier on a plan with `integrations` but without
  // `tracking` would lose `GET /api/v1/track` even though consignment
  // tracking has nothing to do with a vehicle map.
  //
  // Unreachable on the seeded plans (only ENTERPRISE sells `integrations`,
  // and it includes `tracking`), so this is a trap rather than a live bug.
  // The fix is a core permission of its own — `shipment.track` — offered
  // here instead; it is not made here because it needs a catalogue entry, a
  // seed run and a grant on every role that should hold it, and a key whose
  // owner does not hold the scope stops working the moment it lands.
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
