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
