/**
 * Money and dates as they appear on a printed document.
 *
 * The app formats both for whoever is looking at the screen. A document is
 * not the app: it belongs to the carrier whose letterhead is on it, so
 * these take the tenant's `currency` and `timezone` rather than the
 * server's locale and the process clock. An LR booked at 23:10 in Delhi
 * must not print as the previous day because the container runs on UTC.
 *
 * Deliberately not folded into `src/components/finance/format.ts`: that
 * module formats for the signed-in operator and is read by every screen in
 * the product, and widening it to take a tenant would change ~every call
 * site in the app for the sake of four printed pages.
 */

/**
 * Glyphs for the currencies a carrier on this platform is plausibly
 * billing in. Anything else prints its ISO code — "AED 1,200.00" is
 * unambiguous, where a guessed symbol on a tax document is not.
 */
const CURRENCY_PREFIX: Record<string, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/** Lakh-and-crore grouping is a fact about the rupee, not about the reader. */
function groupingLocale(currency: string): string {
  return currency === "INR" ? "en-IN" : "en-US";
}

export type Moneyish = { toString(): string } | number | null | undefined;

/**
 * An amount with the tenant's currency in front of it.
 *
 * `decimals` drops to 0 only where the space genuinely will not take them —
 * a package label. Everywhere a figure is part of the money on the
 * document, paise stay.
 */
export function documentMoney(
  value: Moneyish,
  currency: string,
  decimals = 2,
): string {
  const code = (currency || "INR").toUpperCase();
  const numeric =
    value === null || value === undefined ? NaN : Number(value.toString());
  const amount = Number.isFinite(numeric) ? numeric : 0;

  const formatted = new Intl.NumberFormat(groupingLocale(code), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);

  return `${CURRENCY_PREFIX[code] ?? `${code} `}${formatted}`;
}

/**
 * Assembled from `formatToParts` rather than handed to a locale pattern.
 *
 * A Node build with small ICU carries the full time-zone database but only
 * `en-US` locale data, so asking `en-GB` for its own ordering would
 * silently produce a different one — the same class of trap
 * `src/lib/bulk/parse.ts` already had to work around for text decoding.
 * The parts themselves are identical either way.
 */
function zoned(value: Date, timezone: string, withTime: boolean): string {
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const }
      : {}),
  };

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      ...options,
      timeZone: timezone,
    }).formatToParts(value);
  } catch {
    // An unusable IANA name is a bad row in one tenant's settings, and it
    // must not take that tenant's whole consignment note down with it.
    // Server-local is what these pages printed before tenancy, so this
    // degrades to the old behaviour rather than to a blank.
    parts = new Intl.DateTimeFormat("en-GB", options).formatToParts(value);
  }

  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  const date = `${pick("day")} ${pick("month")} ${pick("year")}`;
  return withTime ? `${date} ${pick("hour")}:${pick("minute")}` : date;
}

/** `28 Aug 2026`, on the tenant's calendar. */
export function documentDate(value: Date, timezone: string): string {
  return zoned(value, timezone, false);
}

/** `28 Aug 2026 23:10`, on the tenant's wall clock. */
export function documentDateTime(value: Date, timezone: string): string {
  return zoned(value, timezone, true);
}
