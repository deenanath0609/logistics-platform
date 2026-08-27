import { z } from "zod";
import { normaliseRegistration, isPlausibleRegistration } from "./registration";

/**
 * Zod helpers for the fleet forms.
 *
 * `FormData` hands everything over as a string, and the two shapes the fleet
 * screens need — a calendar date and a registration number — both need
 * work before they reach Prisma. Keeping that here means the vehicle form,
 * the driver form and any future importer normalise identically.
 */

/**
 * A `<input type="date">` value into a `@db.Date`.
 *
 * The browser posts `yyyy-MM-dd`, which `new Date()` reads as UTC midnight —
 * exactly what a date-only column wants, and what `daysUntilExpiry` expects
 * to receive back. Constructing it any other way reintroduces the timezone
 * drift the availability module exists to avoid.
 */
export function zOptionalDate() {
  return z.preprocess((value) => {
    if (typeof value !== "string" || value.trim() === "") return null;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? value : parsed;
  }, z.date({ message: "Use a valid date" }).nullable());
}

/**
 * Registration numbers are stored stripped and uppercased so the unique
 * constraint and the search box both work regardless of how the clerk
 * spaced it out. Display puts the spaces back — see `formatRegistration`.
 */
export function zRegistration() {
  return z
    .string()
    .trim()
    .min(1, "Registration number is required")
    .transform(normaliseRegistration)
    .refine(isPlausibleRegistration, {
      message: "That does not look like a registration number",
    });
}

/** Ten digits, no country code — the same rule the user master applies. */
export function zMobile() {
  return z
    .string()
    .trim()
    .regex(/^\d{10}$/, "Ten digits, no country code");
}

export function zOptionalMobile() {
  return z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z
      .string()
      .trim()
      .regex(/^\d{10}$/, "Ten digits, no country code")
      .nullable(),
  );
}
