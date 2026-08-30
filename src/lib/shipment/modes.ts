// A **type-only** import, and it matters. Importing the enum as a value
// pulls the Prisma client runtime into every bundle that reaches this file
// — and this file is reached by client components (the report filter bar,
// the booking forms), which then try to load `pg` and `node:dns` in a
// browser. The `Record<ShipmentMode, …>` maps below give the same
// exhaustiveness check without the runtime.
import type { ShipmentMode } from "@/generated/prisma/client";

/**
 * The service modes, in one place.
 *
 * They used to be written out as `"FTL" | "PTL" | "COURIER"` in twelve
 * files — two form types, four dropdowns, three zod schemas, a badge palette
 * and a report filter. Adding `ECOMMERCE` to the enum broke exactly two of
 * them at compile time and left the other ten silently wrong: a mode the
 * database accepts that no dropdown offers and no validator admits.
 *
 * So the list is derived from the generated enum and everything else hangs
 * off it. Adding the next mode is a change here, and TypeScript finds every
 * consumer that has to follow.
 */

/**
 * Ordered for a human choosing one, not alphabetically: full loads, part
 * loads, parcels, then e-commerce, which is the newest and the most
 * specialised.
 */
export const SHIPMENT_MODES = [
  "FTL",
  "PTL",
  "COURIER",
  "ECOMMERCE",
] as const satisfies readonly ShipmentMode[];

/**
 * A tuple for `z.enum`, which needs a non-empty literal array rather than a
 * readonly one. Kept here so a schema cannot drift from the list above.
 */
export const SHIPMENT_MODE_VALUES: [ShipmentMode, ...ShipmentMode[]] = [
  "FTL",
  "PTL",
  "COURIER",
  "ECOMMERCE",
];

/** What an operator or a customer is shown. */
export const SHIPMENT_MODE_LABEL: Record<ShipmentMode, string> = {
  FTL: "Full truck load",
  PTL: "Part load",
  COURIER: "Courier / parcel",
  ECOMMERCE: "E-commerce",
};

/** The shorter form, for dropdowns and filters where the row is already narrow. */
export const SHIPMENT_MODE_SHORT: Record<ShipmentMode, string> = {
  FTL: "FTL",
  PTL: "PTL",
  COURIER: "Courier",
  ECOMMERCE: "E-commerce",
};

/**
 * Badge tones. Deliberately not the status palette — a mode is a fact about
 * what was sold, never a warning, so these stay in the neutral and accent
 * range rather than borrowing `--warn` or `--bad`.
 */
export const SHIPMENT_MODE_TONE: Record<ShipmentMode, string> = {
  FTL: "bg-accent text-accent-foreground",
  PTL: "bg-info-muted text-info",
  COURIER: "bg-muted text-muted-foreground",
  ECOMMERCE: "bg-ok-muted text-ok",
};

/** `{ value, label }` for a `<select>`, in the order above. */
export const SHIPMENT_MODE_OPTIONS = SHIPMENT_MODES.map((mode) => ({
  value: mode,
  label: SHIPMENT_MODE_LABEL[mode],
}));
