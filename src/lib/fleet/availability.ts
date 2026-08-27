import type {
  DocumentKind,
  DriverStatus,
  VehicleStatus,
} from "@/generated/prisma/client";
import { listDocumentLabels } from "./documents";

/**
 * Whether a vehicle or a driver may be put on a trip.
 *
 * This module is pure on purpose. "Can this truck legally move?" is a
 * question the trip planner, the manifest screen, the fleet list and a
 * nightly alert job all have to answer, and they must answer it the same
 * way. Any drift between them is a vehicle on the road without valid
 * insurance, which is not a UI bug — see docs/BRD.html §A.8.
 *
 * Nothing here touches Prisma, the session, or the clock: `asOf` is always
 * passed in, so every rule is reproducible in a test.
 */

// ────────────────────────────────────────────────────────────
// Calendar arithmetic
//
// Expiry columns are `@db.Date` — a plain calendar day with no time and no
// zone, which Prisma materialises as UTC midnight. Comparing those against
// a wall-clock instant with `<` is what produces the classic off-by-one
// where a permit valid until today reads as expired at 00:30. Both sides
// are reduced to a UTC day number first, so the comparison is between two
// calendar days and nothing else.
// ────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

function utcDayNumber(value: Date): number {
  return Math.floor(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) /
      MS_PER_DAY,
  );
}

/**
 * Midnight of the UTC day an instant falls on.
 *
 * Queries that ask the database "what has already expired?" need the same
 * day boundary this module compares against, or the list on screen and the
 * badge beside it disagree by a day.
 */
export function startOfUtcDay(value: Date = new Date()): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

/** `startOfUtcDay` shifted by whole days — the horizon for an expiry query. */
export function utcDayFromNow(days: number, value: Date = new Date()): Date {
  const start = startOfUtcDay(value);
  return new Date(start.getTime() + days * MS_PER_DAY);
}

/**
 * Whole calendar days from `asOf` until `expiresOn`.
 *
 * Zero means "expires today", which is still valid — a certificate is good
 * through the whole of its last day. Negative means already expired.
 */
export function daysUntilExpiry(expiresOn: Date, asOf: Date): number {
  return utcDayNumber(expiresOn) - utcDayNumber(asOf);
}

// ────────────────────────────────────────────────────────────
// Urgency
// ────────────────────────────────────────────────────────────

/** Days ahead at which a document starts showing as expiring. */
export const EXPIRY_WARNING_DAYS = 30;

/** How far ahead the expiry desk looks. */
export const EXPIRY_HORIZON_DAYS = 60;

/** Alert ladder from the BRD: renewal reminders at 30, 15 and 7 days. */
export const ALERT_DAYS: readonly number[] = [30, 15, 7] as const;

export type ExpiryUrgency = "EXPIRED" | "CRITICAL" | "WARNING" | "OK";

/**
 * Four bands rather than three, because "expires in six days" and "expires
 * in twenty-nine days" are different working days for the transport desk
 * even though both are inside the warning window.
 */
export function expiryUrgency(daysRemaining: number): ExpiryUrgency {
  if (daysRemaining < 0) return "EXPIRED";
  if (daysRemaining <= 7) return "CRITICAL";
  if (daysRemaining <= EXPIRY_WARNING_DAYS) return "WARNING";
  return "OK";
}

// ────────────────────────────────────────────────────────────
// Document health
// ────────────────────────────────────────────────────────────

/**
 * The shape both `VehicleDocument` and `DriverDocument` satisfy. Taking a
 * structural type rather than a Prisma model keeps this module usable from
 * a test, a worker, and a server component without three signatures.
 */
export type DocumentLike = {
  kind: DocumentKind;
  /** Null for documents that do not expire, e.g. most RCs. */
  expiresOn: Date | null;
  isMandatory: boolean;
};

export type DocumentStatus = "OK" | "EXPIRING" | "EXPIRED";

export type DocumentTiming = {
  kind: DocumentKind;
  expiresOn: Date;
  /** Negative once expired. */
  daysRemaining: number;
  isMandatory: boolean;
  urgency: ExpiryUrgency;
};

export type DocumentHealth = {
  /**
   * The worst state across every document held, mandatory or not. A lapsed
   * PUC is still a lapsed PUC even when it does not stop the truck.
   */
  status: DocumentStatus;
  /**
   * Expired documents that are marked mandatory — the ones that actually
   * prevent assignment. Empty on a vehicle whose only lapsed paper is
   * optional.
   */
  blocking: DocumentKind[];
  /** Not yet expired, but inside the warning window. Soonest first. */
  expiringSoon: DocumentTiming[];
  /** Already expired, mandatory or not. Most overdue first. */
  expired: DocumentTiming[];
};

/**
 * Summarises a set of documents against a date.
 *
 * Documents with no expiry are ignored rather than treated as valid or
 * invalid: a permanent RC has nothing to say about whether the vehicle may
 * move today.
 */
export function documentHealth(
  documents: readonly DocumentLike[],
  asOf: Date,
  windowDays: number = EXPIRY_WARNING_DAYS,
): DocumentHealth {
  const expired: DocumentTiming[] = [];
  const expiringSoon: DocumentTiming[] = [];

  for (const document of documents) {
    if (!document.expiresOn) continue;

    const daysRemaining = daysUntilExpiry(document.expiresOn, asOf);
    const timing: DocumentTiming = {
      kind: document.kind,
      expiresOn: document.expiresOn,
      daysRemaining,
      isMandatory: document.isMandatory,
      urgency: expiryUrgency(daysRemaining),
    };

    if (daysRemaining < 0) expired.push(timing);
    else if (daysRemaining <= windowDays) expiringSoon.push(timing);
  }

  expired.sort((a, b) => a.daysRemaining - b.daysRemaining);
  expiringSoon.sort((a, b) => a.daysRemaining - b.daysRemaining);

  const blocking = expired
    .filter((timing) => timing.isMandatory)
    .map((timing) => timing.kind);

  const status: DocumentStatus =
    expired.length > 0 ? "EXPIRED" : expiringSoon.length > 0 ? "EXPIRING" : "OK";

  return { status, blocking, expiringSoon, expired };
}

// ────────────────────────────────────────────────────────────
// Assignability
// ────────────────────────────────────────────────────────────

export type Assignability = {
  ok: boolean;
  /** Present only when `ok` is false. Written to be shown to a user as-is. */
  reason?: string;
};

const OK: Assignability = { ok: true };

function no(reason: string): Assignability {
  return { ok: false, reason };
}

export type VehicleLike = {
  registrationNumber: string;
  status: VehicleStatus;
  isActive: boolean;
  deletedAt?: Date | null;
};

/**
 * Statuses a vehicle can be picked up from. Everything else means it is
 * already committed, off the road, or retired.
 */
const VEHICLE_BUSY_REASON: Partial<Record<VehicleStatus, string>> = {
  ASSIGNED: "already assigned to a trip",
  LOADING: "loading",
  DISPATCHED: "dispatched",
  IN_TRANSIT: "in transit",
  AT_HUB: "at a hub on an open trip",
  UNLOADING: "unloading",
  MAINTENANCE: "in maintenance",
  INACTIVE: "marked inactive",
};

/**
 * Whether a vehicle may be assigned to a trip on a given date.
 *
 * The document rule is the point of this function: **a vehicle with an
 * expired mandatory document cannot be assigned**. That is a legal
 * constraint, not a preference, so it is checked before availability — a
 * planner needs to be told "insurance expired", not "vehicle is busy",
 * because those two lead to entirely different actions.
 */
export function canAssignVehicle(
  vehicle: VehicleLike,
  documents: readonly DocumentLike[],
  asOf: Date,
): Assignability {
  if (vehicle.deletedAt) return no("This vehicle has been removed from the fleet.");
  if (!vehicle.isActive) return no("This vehicle is deactivated.");

  const health = documentHealth(documents, asOf);
  if (health.blocking.length > 0) {
    return no(
      `Cannot be assigned: ${listDocumentLabels(health.blocking)} ${
        health.blocking.length === 1 ? "has" : "have"
      } expired. Renew before the vehicle moves.`,
    );
  }

  const busy = VEHICLE_BUSY_REASON[vehicle.status];
  if (busy) return no(`This vehicle is ${busy}.`);

  return OK;
}

export type DriverLike = {
  name: string;
  status: DriverStatus;
  isActive: boolean;
  deletedAt?: Date | null;
  licenceNumber: string | null;
  licenceExpiry: Date | null;
};

const DRIVER_BUSY_REASON: Partial<Record<DriverStatus, string>> = {
  ON_TRIP: "already on a trip",
  ON_LEAVE: "on leave",
  SUSPENDED: "suspended",
  INACTIVE: "marked inactive",
};

/**
 * Whether a driver may be assigned to a trip on a given date.
 *
 * A missing licence is treated exactly like an expired one. The alternative
 * — letting an unrecorded licence pass — turns an incomplete master record
 * into permission to drive, which is the wrong default for the one field
 * that a checkpoint will actually ask for.
 */
export function canAssignDriver(
  driver: DriverLike,
  asOf: Date,
): Assignability {
  if (driver.deletedAt) return no("This driver has been removed.");
  if (!driver.isActive) return no("This driver is deactivated.");

  if (driver.status === "SUSPENDED") return no("This driver is suspended.");

  if (!driver.licenceNumber) {
    return no("Cannot be assigned: no licence number on record.");
  }
  if (!driver.licenceExpiry) {
    return no("Cannot be assigned: no licence expiry on record.");
  }
  if (daysUntilExpiry(driver.licenceExpiry, asOf) < 0) {
    return no("Cannot be assigned: the driving licence has expired.");
  }

  const busy = DRIVER_BUSY_REASON[driver.status];
  if (busy) return no(`This driver is ${busy}.`);

  return OK;
}

/**
 * A driver's licence expressed as document health, so the licence renders
 * through the same badge as every other piece of paper.
 */
export function licenceHealth(
  driver: Pick<DriverLike, "licenceExpiry">,
  asOf: Date,
  windowDays: number = EXPIRY_WARNING_DAYS,
): DocumentHealth {
  return documentHealth(
    driver.licenceExpiry
      ? [
          {
            kind: "DRIVING_LICENCE",
            expiresOn: driver.licenceExpiry,
            isMandatory: true,
          },
        ]
      : [],
    asOf,
    windowDays,
  );
}
