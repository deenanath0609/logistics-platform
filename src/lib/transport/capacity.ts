/**
 * Vehicle capacity utilisation.
 *
 * BRD §A.7 asks for one specific thing: "shows capacity utilisation
 * against the vehicle so a dispatcher can see they are sending out a
 * half-empty truck before it leaves". A number alone does not do that —
 * 62% reads as fine until you know the lane usually runs at 90 — so this
 * returns a band as well, and the manifest screen colours the bar with it.
 *
 * Pure and unit-free beyond kilograms; no Prisma types here so the
 * dispatch screens can call it on plain numbers.
 */

export type UtilisationBand = "EMPTY" | "LIGHT" | "HEALTHY" | "FULL" | "OVERLOADED";

export type Utilisation = {
  weightKg: number;
  capacityKg: number | null;
  /** Null when the vehicle type carries no declared capacity. */
  percent: number | null;
  band: UtilisationBand;
  /** Remaining payload. Negative when overloaded. */
  headroomKg: number | null;
  /** Semantic colour tokens for the bar and the label. */
  tone: "ok" | "warn" | "bad" | "muted";
  label: string;
};

/**
 * Bands are deliberately blunt. A dispatcher glancing at a screen needs
 * "this truck is half empty" and "this truck is illegal", not a gradient.
 */
export function utilisationBand(percent: number): UtilisationBand {
  if (percent > 100) return "OVERLOADED";
  if (percent >= 85) return "FULL";
  if (percent >= 60) return "HEALTHY";
  if (percent > 0) return "LIGHT";
  return "EMPTY";
}

const TONE: Record<UtilisationBand, Utilisation["tone"]> = {
  EMPTY: "muted",
  // Light is warn, not muted: a truck about to leave at 30% is the thing
  // this screen exists to catch.
  LIGHT: "warn",
  HEALTHY: "ok",
  FULL: "ok",
  OVERLOADED: "bad",
};

export function utilisation(
  weightKg: number,
  capacityKg: number | null | undefined,
): Utilisation {
  const weight = Number.isFinite(weightKg) ? Math.max(0, weightKg) : 0;

  if (!capacityKg || capacityKg <= 0) {
    return {
      weightKg: weight,
      capacityKg: null,
      percent: null,
      band: weight > 0 ? "LIGHT" : "EMPTY",
      headroomKg: null,
      tone: "muted",
      label: "No capacity on file for this vehicle type",
    };
  }

  const percent = Math.round((weight / capacityKg) * 1000) / 10;
  const band = utilisationBand(percent);
  const headroomKg = Math.round((capacityKg - weight) * 1000) / 1000;

  return {
    weightKg: weight,
    capacityKg,
    percent,
    band,
    headroomKg,
    tone: TONE[band],
    label: LABEL[band],
  };
}

const LABEL: Record<UtilisationBand, string> = {
  EMPTY: "Nothing loaded",
  LIGHT: "Running light — worth holding for more freight",
  HEALTHY: "Reasonably loaded",
  FULL: "Well loaded",
  OVERLOADED: "Over the vehicle's rated payload",
};
