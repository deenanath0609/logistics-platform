import { describe, expect, it } from "vitest";
import {
  addDays,
  businessDay,
  businessDayString,
  endOfBusinessDay,
  startOfBusinessDay,
} from "./business-day";

/**
 * The five and a half hours.
 *
 * Every assertion here is written against an *instant*, not a local time,
 * because the bug this module exists to stop only appears when the server's
 * zone is not the carrier's — and the CI box, the dev laptop and the
 * production container are three different answers. Pinning the instants in
 * UTC makes the test say the same thing wherever it runs, which is the
 * property the code is supposed to have.
 *
 * 18:30 UTC is midnight IST. Anything from 18:30 on the 31st to 18:29 on
 * the 1st is the 1st of September in Delhi, and that is the day a `@db.Date`
 * column has to end up holding.
 */

/** 01:00 IST on 1 September 2026 — the hour that broke everything. */
const EARLY_MORNING_IST = new Date("2026-08-31T19:30:00.000Z");
/** 23:00 IST on 31 August 2026. */
const LATE_NIGHT_IST = new Date("2026-08-31T17:30:00.000Z");
/** Midday, where UTC and IST agree on the date. */
const MIDDAY_IST = new Date("2026-09-01T06:30:00.000Z");

describe("businessDay", () => {
  it("gives the Indian calendar day, not the UTC one", () => {
    // The whole defect in one line: `toISOString()` on this instant says
    // 2026-08-31, and a `@db.Date` column would have stored that.
    expect(EARLY_MORNING_IST.toISOString().slice(0, 10)).toBe("2026-08-31");
    expect(businessDayString(EARLY_MORNING_IST)).toBe("2026-09-01");
  });

  it("keeps the previous day for an instant still in it", () => {
    expect(businessDayString(LATE_NIGHT_IST)).toBe("2026-08-31");
  });

  it("agrees with UTC when the two are on the same day", () => {
    expect(businessDayString(MIDDAY_IST)).toBe("2026-09-01");
  });

  it("returns UTC midnight, which is what a @db.Date column reads back", () => {
    expect(businessDay(EARLY_MORNING_IST).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  /**
   * The property that lets this be applied at every call site without
   * checking first: a value that already came out of a `@db.Date` column is
   * UTC midnight, which is 05:30 on the same Indian day, so it maps to
   * itself. Applying it twice cannot walk a date backwards.
   */
  it("is idempotent on a value that came out of a date column", () => {
    const stored = new Date("2026-04-01T00:00:00.000Z");
    expect(businessDay(stored).getTime()).toBe(stored.getTime());
    expect(businessDay(businessDay(stored)).getTime()).toBe(stored.getTime());
  });

  it("puts 1 April in the new financial year, not the one that just closed", () => {
    // 01:00 IST on 1 April. `financialYear()` reads this off the value it is
    // given, so getting the day wrong here renumbers the invoice into the
    // year that ended the night before — in a document number that cannot
    // be corrected afterwards.
    const dawnOfTheFinancialYear = new Date("2026-03-31T19:30:00.000Z");
    expect(businessDayString(dawnOfTheFinancialYear)).toBe("2026-04-01");
    expect(businessDay(dawnOfTheFinancialYear).getUTCMonth()).toBe(3);
  });
});

describe("addDays", () => {
  it("adds credit days without touching the time of day", () => {
    const invoiceDate = businessDay(EARLY_MORNING_IST);
    expect(addDays(invoiceDate, 30).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("crosses a month end", () => {
    expect(addDays(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
  });

  it("takes zero credit days as the same day", () => {
    const day = businessDay(MIDDAY_IST);
    expect(addDays(day, 0).getTime()).toBe(day.getTime());
  });
});

describe("the bounds of a business day", () => {
  it("starts at 18:30 UTC the evening before", () => {
    expect(startOfBusinessDay(MIDDAY_IST).toISOString()).toBe(
      "2026-08-31T18:30:00.000Z",
    );
  });

  it("ends one millisecond before the next one starts", () => {
    expect(endOfBusinessDay(MIDDAY_IST).toISOString()).toBe(
      "2026-09-01T18:29:59.999Z",
    );
  });

  /**
   * The billing-window property. A consignment booked at 23:00 IST on
   * 31 August belongs to August's bill run and a consignment booked at
   * 02:00 IST on 1 September does not — which a UTC-truncated window got
   * backwards in both directions.
   */
  it("covers a consignment booked at 23:00 and excludes one booked at 02:00", () => {
    const august = {
      from: startOfBusinessDay(new Date("2026-08-01")),
      to: endOfBusinessDay(new Date("2026-08-31")),
    };

    const lateOnTheThirtyFirst = LATE_NIGHT_IST;
    const earlyOnTheFirst = EARLY_MORNING_IST;

    expect(lateOnTheThirtyFirst >= august.from && lateOnTheThirtyFirst <= august.to).toBe(
      true,
    );
    expect(earlyOnTheFirst > august.to).toBe(true);
  });

  it("leaves no gap between one day's end and the next one's start", () => {
    const end = endOfBusinessDay(new Date("2026-08-31"));
    const next = startOfBusinessDay(new Date("2026-09-01"));
    expect(next.getTime() - end.getTime()).toBe(1);
  });
});
