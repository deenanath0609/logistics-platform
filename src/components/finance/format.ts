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

/**
 * The business day these screens work on.
 *
 * `Organization.timezone` is the authority and defaults to this; a
 * per-tenant value cannot be threaded through here, because `isoDate` is
 * called from client components where reading the environment or the
 * database is not available. Every carrier on the product today runs on
 * IST, and being right for them beats being wrong for everybody.
 */
const BUSINESS_TIMEZONE = "Asia/Kolkata";

/**
 * `yyyy-mm-dd` on the business calendar, for date inputs and query
 * strings.
 *
 * ── Not `toISOString()` ──────────────────────────────────────────────────
 *
 * This was `date.toISOString().slice(0, 10)`, which is the **UTC** day.
 * Nothing pins `process.env.TZ`, so on a UTC container every one of these
 * pre-filled fields — Bill date, Effective from, Paid on — read
 * *yesterday* between 00:00 and 05:30 IST. Those columns are `@db.Date`,
 * a bare calendar day with no zone to correct it later, so a bill raised
 * at one in the morning was dated to the previous day, took its
 * `dueDate` back with it, and landed in the previous day's
 * `VENDOR_BILL` number-series bucket. Nobody would ever see why.
 *
 * Assembled from `formatToParts` rather than an `en-CA` pattern, for the
 * reason spelled out in `src/components/documents/format.ts`: a Node
 * build with small ICU carries every time zone but only `en-US` locale
 * data, so a locale chosen for its ordering can silently give a different
 * one. The parts are the same in any locale.
 * ────────────────────────────────────────────────────────────────────────
 */
export function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}
