import type { DocumentKind } from "@/generated/prisma/client";

/**
 * The paperwork that keeps a vehicle and a driver legal.
 *
 * Which documents belong to a vehicle and which to a person is fixed by the
 * regulator, not by configuration, so it lives in code. Whether a given copy
 * is *mandatory* is per-record — an attached vehicle running intra-state
 * does not need a national permit — so that stays a column.
 */

export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  RC: "Registration certificate",
  INSURANCE: "Insurance",
  FITNESS: "Fitness certificate",
  PERMIT_NATIONAL: "National permit",
  PERMIT_STATE: "State permit",
  PUC: "Pollution certificate",
  ROAD_TAX: "Road tax",
  DRIVING_LICENCE: "Driving licence",
  ID_PROOF: "ID proof",
  ADDRESS_PROOF: "Address proof",
  POLICE_VERIFICATION: "Police verification",
  OTHER: "Other",
};

/** Short form for table cells, where the full label will not fit. */
export const DOCUMENT_SHORT: Record<DocumentKind, string> = {
  RC: "RC",
  INSURANCE: "Insurance",
  FITNESS: "Fitness",
  PERMIT_NATIONAL: "Permit (Nat.)",
  PERMIT_STATE: "Permit (State)",
  PUC: "PUC",
  ROAD_TAX: "Road tax",
  DRIVING_LICENCE: "Licence",
  ID_PROOF: "ID proof",
  ADDRESS_PROOF: "Address",
  POLICE_VERIFICATION: "Police verif.",
  OTHER: "Other",
};

/**
 * Declared as literal tuples rather than `DocumentKind[]` so both the `select`
 * options and the Zod enum that validates the posted value derive from the
 * same list — a kind added here cannot be offered without being accepted.
 */
export const VEHICLE_DOCUMENT_KINDS = [
  "RC",
  "INSURANCE",
  "FITNESS",
  "PERMIT_NATIONAL",
  "PERMIT_STATE",
  "PUC",
  "ROAD_TAX",
  "OTHER",
] as const satisfies readonly DocumentKind[];

export const DRIVER_DOCUMENT_KINDS = [
  "DRIVING_LICENCE",
  "ID_PROOF",
  "ADDRESS_PROOF",
  "POLICE_VERIFICATION",
  "OTHER",
] as const satisfies readonly DocumentKind[];

/**
 * What the form ticks "mandatory" by default when a document is added.
 *
 * These are the ones a checkpoint asks for. The user can untick — a vehicle
 * that never leaves one state genuinely does not need a national permit —
 * which is why this is a default and not a rule.
 */
export const MANDATORY_BY_DEFAULT: ReadonlySet<DocumentKind> = new Set<DocumentKind>([
  "RC",
  "INSURANCE",
  "FITNESS",
  "PUC",
  "DRIVING_LICENCE",
]);

export function documentLabel(kind: DocumentKind): string {
  return DOCUMENT_LABELS[kind] ?? kind;
}

/** Human list: "insurance, fitness and PUC". */
export function listDocumentLabels(kinds: readonly DocumentKind[]): string {
  const labels = kinds.map((kind) => DOCUMENT_SHORT[kind] ?? kind);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
