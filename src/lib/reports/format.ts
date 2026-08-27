import { Decimal } from "decimal.js";
import { IST_OFFSET_MINUTES, toLocal } from "@/lib/sla/policy";
import type { Cell } from "./types";

/**
 * Turning database values into report cells.
 *
 * Money arrives from Prisma as its own Decimal type and leaves as a
 * number rounded to paise. That conversion is display, not arithmetic:
 * every sum in this library is done with decimal.js first and converted
 * once, at the end. Exporting money as text would be safer still, but it
 * would also make every exported sheet impossible to total in Excel,
 * which is the first thing anyone does with one.
 */

/** Anything Prisma hands back for a `Decimal` column. */
export type DecimalLike = { toString(): string } | number | string | null | undefined;

export function toDecimal(value: DecimalLike): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  return new Decimal(value.toString());
}

export function sumDecimal(values: readonly DecimalLike[]): Decimal {
  return values.reduce<Decimal>(
    (total, value) => total.plus(toDecimal(value)),
    new Decimal(0),
  );
}

/** Rupees, to paise. Null stays null — an absent amount is not zero. */
export function moneyCell(value: DecimalLike): number | null {
  if (value === null || value === undefined) return null;
  return toDecimal(value).toDecimalPlaces(2).toNumber();
}

/** Kilograms, to three places, matching the schema. */
export function weightCell(value: DecimalLike): number | null {
  if (value === null || value === undefined) return null;
  return toDecimal(value).toDecimalPlaces(3).toNumber();
}

/** "2026-08-27" in branch-local time. */
export function dateCell(at: Date | null | undefined): string | null {
  if (!at) return null;
  return toLocal(at, IST_OFFSET_MINUTES).ymd;
}

/** "2026-08-27 14:05" in branch-local time. */
export function dateTimeCell(at: Date | null | undefined): string | null {
  if (!at) return null;
  const local = toLocal(at, IST_OFFSET_MINUTES);
  const hours = Math.floor(local.msOfDay / 3_600_000);
  const minutes = Math.floor((local.msOfDay % 3_600_000) / 60_000);
  return `${local.ymd} ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Whole minutes between two instants, or null when either is missing. */
export function minutesBetween(
  from: Date | null | undefined,
  to: Date | null | undefined,
): number | null {
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

/** Minutes since an instant. The ageing column on half the library. */
export function ageMinutes(from: Date | null | undefined, now: Date): number | null {
  return minutesBetween(from, now);
}

/** Turns an enum into something a person reads. */
export function humanise(value: string | null | undefined): string | null {
  if (!value) return null;
  const words = value.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function percentCell(
  numerator: number,
  denominator: number,
): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

/** Renders a cell for CSV and XLSX. Nulls become blanks, never "null". */
export function exportValue(cell: Cell): string | number {
  if (cell === null || cell === undefined) return "";
  return cell;
}
