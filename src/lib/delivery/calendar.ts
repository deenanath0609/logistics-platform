/**
 * Calendar days, as a `date` column actually stores them.
 *
 * `DeliveryRun.runDate` and `CodDeposit.depositDate` are `@db.Date`.
 * Postgres keeps the **UTC** calendar day, so handing either of them a
 * local midnight throws the day away at any positive offset — IST is +5:30,
 * so local midnight on the 1st is `18:30Z on the 31st`, and the column
 * stores the 31st.
 *
 * Read and write were both wrong in the same direction, which is why the
 * screens looked right: they agreed with each other. Nothing else did. The
 * COD shortfall detector in `lib/sla/detector-scan.ts` matches
 * `depositDate` at UTC midnight for the local day — correctly — so it never
 * saw a deposit at all and would open a shortfall exception against an
 * agent who had handed every rupee in. `lib/reports/financial.ts` printed
 * the deposit a day early, and the run header on `/delivery/runs/[id]`
 * showed the day before the one the dispatcher picked.
 *
 * This is the fifth time the offset has bitten this repository. The same
 * trick, for the same reason, as `asStoredDate` in `lib/pickup/execute.ts`
 * and `storedToday` in `lib/shipment/booking.ts`.
 *
 * The rule this module exists to enforce:
 *
 *   · a `@db.Date` value is written and queried at **UTC** midnight;
 *   · it is turned back into a local `Date` before it is ever formatted.
 */

/** A local `Date` (or any instant), as the calendar day it falls on. */
export function storedDate(day: Date): Date {
  return new Date(
    Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0),
  );
}

/** Today's calendar day, ready for a `date` column. */
export function storedToday(): Date {
  return storedDate(new Date());
}

/** `"2026-09-01"` from a date picker or a query string. */
export function storedDayFromYmd(ymd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [year, month, day] = ymd.split("-").map(Number);
  const stored = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  return Number.isNaN(stored.getTime()) ? null : stored;
}

/** `"2026-09-01"` back out of a stored value, for links and hidden inputs. */
export function storedIsoDay(stored: Date): string {
  const month = String(stored.getUTCMonth() + 1).padStart(2, "0");
  const day = String(stored.getUTCDate()).padStart(2, "0");
  return `${stored.getUTCFullYear()}-${month}-${day}`;
}

/** The day before / after, still at UTC midnight. */
export function shiftStoredDay(stored: Date, days: number): Date {
  const moved = new Date(stored);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved;
}

/**
 * A stored day as a local `Date`, so `date-fns` prints the day it means.
 *
 * `format(runDate, "EEE dd MMM")` on the raw value renders it in the
 * viewer's zone, which is the same day in IST and the day before in
 * Honolulu. Rebuilding it locally makes the label independent of where the
 * browser is.
 */
export function fromStoredDate(stored: Date): Date {
  return new Date(
    stored.getUTCFullYear(),
    stored.getUTCMonth(),
    stored.getUTCDate(),
  );
}
