import type { ShipmentMode } from "@/generated/prisma/client";
import { IST_OFFSET_MINUTES, fromLocal, toLocal } from "@/lib/sla/policy";
import type { FilterKey, ReportFilters } from "./types";

/**
 * Report filters, parsed from and rendered back to the query string.
 *
 * Pure, so the parsing rules can be tested without a request. The query
 * string is the source of truth for a report's state rather than component
 * state, which is what makes a filtered report shareable by pasting the
 * URL — and pasting the URL is how these actually get passed around an
 * operations floor.
 */

const DAY_MS = 86_400_000;

/** Reports default to the last month rather than to everything. */
export const DEFAULT_RANGE_DAYS = 30;

/** A hard ceiling. A five-year range is a mistake, not a request. */
export const MAX_RANGE_DAYS = 400;

const MODES: ShipmentMode[] = ["FTL", "PTL", "COURIER"];

export type RawParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/** "YYYY-MM-DD", or null when it is not a date. */
function parseDay(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(at.getTime()) ? null : value;
}

/** The local calendar date of an instant, "YYYY-MM-DD". */
export function toDayString(at: Date): string {
  return toLocal(at, IST_OFFSET_MINUTES).ymd;
}

/**
 * Parses a report's filters.
 *
 * Dates are read as branch-local calendar days and widened to cover the
 * whole of both: a report "for the 27th" that silently stops at midnight
 * UTC would drop the last five and a half hours of an Indian working day,
 * which is most of an evening dispatch.
 */
export function parseFilters(params: RawParams, now: Date = new Date()): ReportFilters {
  const todayYmd = toDayString(now);

  const requestedFrom = parseDay(one(params.from));
  const requestedTo = parseDay(one(params.to));

  let fromYmd =
    requestedFrom ?? toDayString(new Date(now.getTime() - DEFAULT_RANGE_DAYS * DAY_MS));
  let toYmd = requestedTo ?? todayYmd;

  // A reversed range is a slip of the calendar picker, not an empty
  // report. Swapping is what the person meant.
  if (fromYmd > toYmd) [fromYmd, toYmd] = [toYmd, fromYmd];

  const from = fromLocal(fromYmd, 0, IST_OFFSET_MINUTES);
  let to = fromLocal(toYmd, DAY_MS - 1, IST_OFFSET_MINUTES);

  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    to = new Date(from.getTime() + MAX_RANGE_DAYS * DAY_MS);
  }

  const mode = one(params.mode);

  return {
    from,
    to,
    branchId: one(params.branchId),
    customerId: one(params.customerId),
    originBranchId: one(params.originBranchId),
    destinationBranchId: one(params.destinationBranchId),
    serviceTypeId: one(params.serviceTypeId),
    mode: mode && MODES.includes(mode as ShipmentMode) ? (mode as ShipmentMode) : null,
    q: one(params.q),
  };
}

/** Back to a query string, so links and exports carry the same view. */
export function filtersToParams(
  filters: ReportFilters,
): Record<string, string> {
  const params: Record<string, string> = {
    from: toDayString(filters.from),
    to: toDayString(filters.to),
  };

  const optional: Array<[string, string | null]> = [
    ["branchId", filters.branchId],
    ["customerId", filters.customerId],
    ["originBranchId", filters.originBranchId],
    ["destinationBranchId", filters.destinationBranchId],
    ["serviceTypeId", filters.serviceTypeId],
    ["mode", filters.mode],
    ["q", filters.q],
  ];

  for (const [key, value] of optional) if (value) params[key] = value;

  return params;
}

/** The filters, in words, for the report header and the export sheet. */
export function describeFilters(
  filters: ReportFilters,
  names: {
    branch?: string | null;
    customer?: string | null;
    origin?: string | null;
    destination?: string | null;
    serviceType?: string | null;
  } = {},
): string {
  const parts: string[] = [
    `${toDayString(filters.from)} to ${toDayString(filters.to)}`,
  ];

  if (names.branch) parts.push(`Branch ${names.branch}`);
  if (names.customer) parts.push(names.customer);
  if (names.origin || names.destination) {
    parts.push(`${names.origin ?? "anywhere"} → ${names.destination ?? "anywhere"}`);
  }
  if (names.serviceType) parts.push(names.serviceType);
  if (filters.mode) parts.push(filters.mode);
  if (filters.q) parts.push(`"${filters.q}"`);

  return parts.join(" · ");
}

/** Days covered, inclusive. Used to size trend buckets. */
export function rangeDays(filters: ReportFilters): number {
  return Math.max(
    1,
    Math.round((filters.to.getTime() - filters.from.getTime()) / DAY_MS),
  );
}

/**
 * Day buckets across the range, for trend charts.
 *
 * Capped at one bucket per day: a 400-day trend rendered daily is 400
 * unreadable pixels, so anything longer than three months groups by week.
 */
export function trendBuckets(
  filters: ReportFilters,
): Array<{ key: string; label: string; from: Date; to: Date }> {
  const days = rangeDays(filters);
  const step = days > 92 ? 7 : 1;
  const buckets: Array<{ key: string; label: string; from: Date; to: Date }> = [];

  for (let offset = 0; offset < days; offset += step) {
    const from = new Date(filters.from.getTime() + offset * DAY_MS);
    const to = new Date(
      Math.min(from.getTime() + step * DAY_MS - 1, filters.to.getTime()),
    );
    const key = toDayString(from);
    buckets.push({
      key,
      label: step === 1 ? key.slice(5) : `${key.slice(5)}+`,
      from,
      to,
    });
  }

  return buckets;
}

export const FILTER_LABEL: Record<FilterKey, string> = {
  dates: "Date range",
  branch: "Branch",
  customer: "Customer",
  lane: "Lane",
  serviceType: "Service type",
  mode: "Mode",
  search: "Search",
};
