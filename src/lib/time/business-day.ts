/**
 * The carrier's calendar day, server-side.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * A `@db.Date` column stores a bare calendar day. Prisma takes that day
 * from the **UTC** part of whatever `Date` it is handed, so `new Date()`
 * written into `invoice.invoiceDate` is the UTC day — and nothing in this
 * repo pins `process.env.TZ`. On a UTC container, every document raised
 * between 00:00 and 05:30 IST is therefore dated *yesterday*: the invoice
 * date, the due date derived from it, and the `{FY}`/`{MM}` bucket its
 * number is drawn from all go back a day with it. On the 1st of April that
 * is the wrong financial year in the invoice number, which is not a thing
 * anybody can correct afterwards.
 *
 * `isoDate` in `src/components/finance/format.ts` is the same correction
 * for the *string* a date input is pre-filled with. This is the correction
 * for the `Date` a column is written from — the two have to agree, or a
 * screen shows one day and saves another.
 *
 * The day is resolved with `Intl`, which is in the runtime, rather than by
 * adding a date library for three functions. Parts rather than an `en-CA`
 * pattern, for the reason `src/components/documents/format.ts` gives: a
 * Node build with small ICU carries every zone but only `en-US` locale
 * data, so a locale chosen for its ordering can quietly give a different
 * one. The parts are the same in any locale.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * Every carrier on the product today runs on IST. `Organization.timezone`
 * is the authority and defaults to this; threading a per-tenant value
 * through the pricing engine — a pure function with no database — would
 * cost more than it buys while the answer is the same for everyone.
 */
export const BUSINESS_TIMEZONE = "Asia/Kolkata";

/** `{ year, month, day }` of an instant, on the business calendar. */
function partsOf(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return { year: pick("year"), month: pick("month"), day: pick("day") };
}

/**
 * The business day an instant falls on, as the UTC midnight a `@db.Date`
 * column will read back.
 *
 * Idempotent on a value that already came out of such a column: UTC
 * midnight is 05:30 on the same IST day, so it maps to itself.
 */
export function businessDay(instant: Date = new Date()): Date {
  if (Number.isNaN(instant.getTime())) return instant;
  const { year, month, day } = partsOf(instant, BUSINESS_TIMEZONE);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

/** `yyyy-mm-dd` on the business calendar. Matches `isoDate` exactly. */
export function businessDayString(instant: Date = new Date()): string {
  const { year, month, day } = partsOf(instant, BUSINESS_TIMEZONE);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * `days` after a business day, still at UTC midnight.
 *
 * Done in UTC rather than with `setDate`, which moves the *local* day and
 * so lands on the wrong side of midnight whenever the server's zone is not
 * the carrier's — the bug this file exists to stop, reintroduced one
 * function later.
 */
export function addDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The first instant of a business day, for a `>=` bound on a `DateTime`
 * column. Midnight IST is 18:30 UTC the day before, which is exactly the
 * five and a half hours a UTC-truncated window loses.
 */
export function startOfBusinessDay(dayOrInstant: Date): Date {
  const day = businessDay(dayOrInstant);
  return new Date(day.getTime() - offsetMs(day));
}

/** The last instant of a business day, for a `<=` bound. */
export function endOfBusinessDay(dayOrInstant: Date): Date {
  return new Date(startOfBusinessDay(addDays(businessDay(dayOrInstant), 1)).getTime() - 1);
}

/**
 * The zone's offset from UTC at an instant, in milliseconds.
 *
 * Asked of `Intl` rather than hard-coded to +5:30, so the one function that
 * would need editing if a carrier ever runs somewhere with daylight saving
 * is already right.
 */
function offsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const asIfUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );

  return asIfUtc - (instant.getTime() - instant.getMilliseconds());
}
