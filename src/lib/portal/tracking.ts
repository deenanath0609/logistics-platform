import { prisma } from "@/lib/prisma";
import { toPublicTracking, type PublicTracking } from "./visibility";
import {
  checkRateLimit,
  clientKey,
  TRACKING_RULE,
  type RateLimitResult,
} from "./rate-limit";

/**
 * Public tracking lookup — no login, per docs/BRD.html §A.14.
 *
 * The only two things standing between this and a scraper are the rate
 * limiter and the projection in visibility.ts. Both live outside this file
 * so both can be tested without a database.
 */

/** More than this in one lookup is a script, not a despatch clerk. */
export const MAX_LOOKUP = 10;

/**
 * Splits what someone typed into consignment numbers.
 *
 * Accepts commas, spaces and newlines alike — people paste a column out of
 * a spreadsheet. Pure, so the parsing rules are testable on their own.
 */
export function parseTrackingQuery(raw: string): string[] {
  const tokens = raw
    .split(/[\s,;]+/)
    .map((token) => token.trim().toUpperCase())
    .filter((token) => token.length >= 3 && token.length <= 40);

  return [...new Set(tokens)].slice(0, MAX_LOOKUP);
}

/** A shareable link for one consignment, or a multi-LR lookup. */
export function trackingHref(numbers: string[]): string {
  if (numbers.length === 1) return `/track/${encodeURIComponent(numbers[0])}`;
  return `/track?lr=${encodeURIComponent(numbers.join(","))}`;
}

export type TrackingLookup =
  | {
      ok: true;
      found: PublicTracking[];
      /** Numbers that matched nothing — shown back so a typo is visible. */
      notFound: string[];
      truncated: boolean;
    }
  | { ok: false; reason: "RATE_LIMITED"; retryAfterSeconds: number }
  | { ok: false; reason: "EMPTY" };

/**
 * Resolves consignment numbers to the public view.
 *
 * Matches on the LR number or the customer's own reference, both of which
 * §A.14 says a tracking page accepts. A number that does not exist and a
 * number belonging to someone else are answered identically — "not found" —
 * so the endpoint cannot be used to confirm that an LR exists.
 */
export async function lookupTracking(
  raw: string,
  headers: Headers,
): Promise<TrackingLookup> {
  const numbers = parseTrackingQuery(raw);
  if (numbers.length === 0) return { ok: false, reason: "EMPTY" };

  const limit: RateLimitResult = checkRateLimit(
    clientKey(headers, "track"),
    TRACKING_RULE,
  );

  if (!limit.ok) {
    return {
      ok: false,
      reason: "RATE_LIMITED",
      retryAfterSeconds: limit.retryAfterSeconds,
    };
  }

  const rows = await prisma.shipment.findMany({
    where: {
      deletedAt: null,
      OR: [
        { lrNumber: { in: numbers } },
        { customerReference: { in: numbers } },
      ],
    },
    take: MAX_LOOKUP,
    orderBy: { bookedAt: "desc" },
    // Columns are picked, not spread. Adding one to the schema must be a
    // deliberate act here before it can reach a public page.
    select: {
      lrNumber: true,
      currentStatus: true,
      statusUpdatedAt: true,
      packageCount: true,
      bookedAt: true,
      expectedDeliveryAt: true,
      deliveredAt: true,
      customerReference: true,
      consignorCity: { select: { name: true } },
      consigneeCity: { select: { name: true } },
      events: {
        orderBy: [{ occurredAt: "asc" }, { recordedAt: "asc" }],
        select: {
          eventType: true,
          occurredAt: true,
          resultingStatus: true,
          // The branch's CITY, never the branch. A city is public
          // geography; a branch code is the shape of the network.
          branch: { select: { city: { select: { name: true } } } },
        },
      },
    },
  });

  const found = rows.map((row) =>
    toPublicTracking(
      {
        lrNumber: row.lrNumber,
        currentStatus: row.currentStatus,
        statusUpdatedAt: row.statusUpdatedAt,
        packageCount: row.packageCount,
        bookedAt: row.bookedAt,
        expectedDeliveryAt: row.expectedDeliveryAt,
        deliveredAt: row.deliveredAt,
        customerReference: row.customerReference,
        fromCity: row.consignorCity.name,
        toCity: row.consigneeCity.name,
      },
      row.events.map((event) => ({
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        resultingStatus: event.resultingStatus,
        cityName: event.branch?.city.name ?? null,
      })),
    ),
  );

  const matched = new Set<string>();
  for (const row of rows) {
    matched.add(row.lrNumber.toUpperCase());
    if (row.customerReference) matched.add(row.customerReference.toUpperCase());
  }

  return {
    ok: true,
    found,
    notFound: numbers.filter((number) => !matched.has(number)),
    truncated: numbers.length >= MAX_LOOKUP,
  };
}
