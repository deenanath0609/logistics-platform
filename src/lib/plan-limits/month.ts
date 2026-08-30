/**
 * "This month" is the carrier's month, not the server's.
 *
 * `maxShipmentsPerMonth` is a commercial term, so the window it is counted
 * over has to be the one on the carrier's own wall clock — `Organization.
 * timezone`, which defaults to Asia/Kolkata. Counting in UTC would put the
 * first five and a half hours of every Indian month into the previous
 * month's total, so a carrier on the 1st would be refused against a bill
 * they had already paid, and nothing in the product would explain why.
 *
 * Done with `Intl`, which is in the runtime, rather than by adding a
 * timezone library for two functions.
 */

/**
 * The offset of `timeZone` from UTC at a given instant, in milliseconds.
 *
 * Derived by asking `Intl` what the wall clock reads there and treating the
 * answer as if it were UTC: the difference between that and the real
 * instant is the offset actually in force, including any daylight saving.
 */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
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

  // Milliseconds are not in the parts list, so they have to come back from
  // the instant itself or every offset would be wrong by up to a second.
  return asIfUtc - (instant.getTime() - instant.getMilliseconds());
}

/** Midnight on the first of the local month, as a UTC instant. */
function monthStart(instant: Date, timeZone: string): Date {
  const local = new Date(instant.getTime() + offsetMs(instant, timeZone));
  const startAsIfUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    1,
    0,
    0,
    0,
    0,
  );

  // The offset at the start of the month may differ from the offset now —
  // a zone can cross a daylight-saving boundary mid-month. Convert with the
  // present offset to land near the answer, then re-convert with the offset
  // actually in force there.
  const near = new Date(startAsIfUtc - offsetMs(instant, timeZone));
  return new Date(startAsIfUtc - offsetMs(near, timeZone));
}

export type MonthWindow = {
  /** Inclusive. */
  start: Date;
  /** Exclusive — the same instant as the next month's start. */
  end: Date;
  /** `YYYY-MM` on the carrier's clock. Identifies the window in a cache. */
  key: string;
};

/**
 * The half-open window `[start, end)` covering the local month `instant`
 * falls in. Half-open rather than an inclusive end so a booking landing on
 * the final millisecond of the month is counted once, in one month.
 */
export function monthWindow(instant: Date, timeZone: string): MonthWindow {
  const start = monthStart(instant, timeZone);

  // Stepping from a point safely inside the next month, rather than adding
  // 31 days to `start`: the length of a month is not a constant, and a
  // daylight-saving shift makes it not even a whole number of days.
  const insideNext = new Date(start.getTime() + 45 * 24 * 60 * 60 * 1000);
  const end = monthStart(insideNext, timeZone);

  const local = new Date(start.getTime() + offsetMs(start, timeZone));
  const key = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;

  return { start, end, key };
}
