/**
 * Money on screen.
 *
 * Everything arrives as a string from the server — Prisma `Decimal` and
 * decimal.js instances cannot cross the RSC boundary, and converting to a
 * number to format it is exactly the float round-trip the rest of this
 * phase avoids.
 */

const INR = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INR_WHOLE = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export type Moneyish = string | number | null | undefined;

/** Lakh-and-crore grouping, two places, with the rupee sign. */
export function formatMoney(value: Moneyish): string {
  if (value === null || value === undefined || value === "") return "₹0.00";
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "₹0.00";
  return `₹${INR.format(numeric)}`;
}

/** For dense tables and headline tiles where paise are noise. */
export function formatMoneyShort(value: Moneyish): string {
  if (value === null || value === undefined || value === "") return "₹0";
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "₹0";
  return `₹${INR_WHOLE.format(numeric)}`;
}

export function formatWeight(value: Moneyish): string {
  if (value === null || value === undefined || value === "") return "0.000 kg";
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "0.000 kg";
  return `${numeric.toFixed(3)} kg`;
}

export function formatPercent(value: Moneyish, places = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric.toFixed(places)}%`;
}

/** A negative balance is money we hold, not money we are owed. */
export function balanceTone(value: Moneyish): string {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric === 0) return "text-muted-foreground";
  return numeric < 0 ? "text-ok" : "text-foreground";
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** `yyyy-mm-dd`, for date inputs and query strings. */
export function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}
