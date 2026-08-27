import { describe, expect, it } from "vitest";
import type { DocumentKind } from "@/generated/prisma/client";
import {
  ALERT_DAYS,
  EXPIRY_WARNING_DAYS,
  canAssignDriver,
  canAssignVehicle,
  daysUntilExpiry,
  documentHealth,
  expiryUrgency,
  licenceHealth,
  type DocumentLike,
  type DriverLike,
  type VehicleLike,
} from "./availability";

/**
 * Expiry columns are plain calendar dates, so every fixture is built at UTC
 * midnight — the same way Prisma hands back a `@db.Date`. `asOf` is fixed so
 * a test that passes today still passes in March.
 */
const TODAY = new Date("2026-08-27T00:00:00.000Z");

/** A date `offset` calendar days from TODAY. */
function day(offset: number): Date {
  return new Date(Date.UTC(2026, 7, 27 + offset));
}

function doc(
  kind: DocumentKind,
  expiresOn: Date | null,
  isMandatory = true,
): DocumentLike {
  return { kind, expiresOn, isMandatory };
}

const ROADWORTHY: DocumentLike[] = [
  doc("INSURANCE", day(200)),
  doc("FITNESS", day(400)),
  doc("PUC", day(120)),
  doc("RC", null),
];

function vehicle(overrides: Partial<VehicleLike> = {}): VehicleLike {
  return {
    registrationNumber: "HR26AB1234",
    status: "AVAILABLE",
    isActive: true,
    deletedAt: null,
    ...overrides,
  };
}

function driver(overrides: Partial<DriverLike> = {}): DriverLike {
  return {
    name: "Ramesh Kumar",
    status: "AVAILABLE",
    isActive: true,
    deletedAt: null,
    licenceNumber: "HR0620110012345",
    licenceExpiry: day(500),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────

describe("daysUntilExpiry", () => {
  it("is zero on the day of expiry", () => {
    expect(daysUntilExpiry(day(0), TODAY)).toBe(0);
  });

  it("counts whole calendar days ahead", () => {
    expect(daysUntilExpiry(day(1), TODAY)).toBe(1);
    expect(daysUntilExpiry(day(30), TODAY)).toBe(30);
  });

  it("goes negative once the date has passed", () => {
    expect(daysUntilExpiry(day(-1), TODAY)).toBe(-1);
    expect(daysUntilExpiry(day(-45), TODAY)).toBe(-45);
  });

  it("ignores the time of day on either side", () => {
    // Same calendar day, thirteen hours apart: still "expires today".
    const lateInTheDay = new Date("2026-08-27T23:59:59.000Z");
    expect(daysUntilExpiry(day(0), lateInTheDay)).toBe(0);

    const earlyMorning = new Date("2026-08-27T00:00:01.000Z");
    expect(daysUntilExpiry(new Date("2026-08-28T00:00:00.000Z"), earlyMorning)).toBe(1);
  });

  it("crosses month and year boundaries correctly", () => {
    expect(
      daysUntilExpiry(
        new Date("2027-01-01T00:00:00.000Z"),
        new Date("2026-12-31T00:00:00.000Z"),
      ),
    ).toBe(1);
    expect(
      daysUntilExpiry(
        new Date("2028-03-01T00:00:00.000Z"),
        new Date("2028-02-28T00:00:00.000Z"),
      ),
    ).toBe(2); // 2028 is a leap year.
  });
});

describe("expiryUrgency", () => {
  it("bands the ladder the transport desk works to", () => {
    expect(expiryUrgency(-1)).toBe("EXPIRED");
    expect(expiryUrgency(-90)).toBe("EXPIRED");
    expect(expiryUrgency(0)).toBe("CRITICAL");
    expect(expiryUrgency(7)).toBe("CRITICAL");
    expect(expiryUrgency(8)).toBe("WARNING");
    expect(expiryUrgency(30)).toBe("WARNING");
    expect(expiryUrgency(31)).toBe("OK");
  });

  it("puts every BRD alert day inside the warning window", () => {
    for (const days of ALERT_DAYS) {
      expect(expiryUrgency(days)).not.toBe("OK");
      expect(expiryUrgency(days)).not.toBe("EXPIRED");
    }
  });
});

// ────────────────────────────────────────────────────────────

describe("documentHealth", () => {
  it("reports OK when everything is comfortably in date", () => {
    const health = documentHealth(ROADWORTHY, TODAY);
    expect(health.status).toBe("OK");
    expect(health.blocking).toEqual([]);
    expect(health.expiringSoon).toEqual([]);
    expect(health.expired).toEqual([]);
  });

  it("treats a document with no expiry as having nothing to say", () => {
    const health = documentHealth([doc("RC", null)], TODAY);
    expect(health.status).toBe("OK");
    expect(health.expiringSoon).toEqual([]);
  });

  it("is OK for an empty set — absence of paper is not a document state", () => {
    expect(documentHealth([], TODAY).status).toBe("OK");
  });

  // ── Boundaries. These are the cases that decide whether a truck rolls.

  it("counts a document expiring today as still valid", () => {
    const health = documentHealth([doc("INSURANCE", day(0))], TODAY);
    expect(health.status).toBe("EXPIRING");
    expect(health.blocking).toEqual([]);
    expect(health.expired).toEqual([]);
    expect(health.expiringSoon[0].daysRemaining).toBe(0);
  });

  it("counts a document that expired yesterday as expired", () => {
    const health = documentHealth([doc("INSURANCE", day(-1))], TODAY);
    expect(health.status).toBe("EXPIRED");
    expect(health.blocking).toEqual(["INSURANCE"]);
    expect(health.expiringSoon).toEqual([]);
    expect(health.expired[0].daysRemaining).toBe(-1);
  });

  it("includes the last day of the warning window and excludes the next", () => {
    const inside = documentHealth([doc("FITNESS", day(EXPIRY_WARNING_DAYS))], TODAY);
    expect(inside.status).toBe("EXPIRING");

    const outside = documentHealth(
      [doc("FITNESS", day(EXPIRY_WARNING_DAYS + 1))],
      TODAY,
    );
    expect(outside.status).toBe("OK");
    expect(outside.expiringSoon).toEqual([]);
  });

  it("honours a caller-supplied window", () => {
    const documents = [doc("PUC", day(45))];
    expect(documentHealth(documents, TODAY).status).toBe("OK");
    expect(documentHealth(documents, TODAY, 60).status).toBe("EXPIRING");
  });

  // ── Mandatory versus not.

  it("blocks on an expired mandatory document", () => {
    const health = documentHealth([doc("PERMIT_NATIONAL", day(-3), true)], TODAY);
    expect(health.blocking).toEqual(["PERMIT_NATIONAL"]);
  });

  it("only warns on an expired non-mandatory document", () => {
    const health = documentHealth([doc("ROAD_TAX", day(-3), false)], TODAY);
    expect(health.status).toBe("EXPIRED");
    expect(health.blocking).toEqual([]);
    expect(health.expired).toHaveLength(1);
    expect(health.expired[0].isMandatory).toBe(false);
  });

  it("separates the mandatory from the optional in a mixed set", () => {
    const health = documentHealth(
      [
        doc("INSURANCE", day(-10), true),
        doc("ROAD_TAX", day(-40), false),
        doc("PUC", day(5), true),
        doc("FITNESS", day(365), true),
      ],
      TODAY,
    );
    expect(health.status).toBe("EXPIRED");
    expect(health.blocking).toEqual(["INSURANCE"]);
    expect(health.expired.map((d) => d.kind)).toEqual(["ROAD_TAX", "INSURANCE"]);
    expect(health.expiringSoon.map((d) => d.kind)).toEqual(["PUC"]);
  });

  // ── Ordering and precedence.

  it("ranks expired above expiring when both are present", () => {
    const health = documentHealth(
      [doc("PUC", day(2)), doc("INSURANCE", day(-1))],
      TODAY,
    );
    expect(health.status).toBe("EXPIRED");
  });

  it("sorts expiring documents soonest first", () => {
    const health = documentHealth(
      [doc("FITNESS", day(25)), doc("PUC", day(2)), doc("INSURANCE", day(12))],
      TODAY,
    );
    expect(health.expiringSoon.map((d) => d.kind)).toEqual([
      "PUC",
      "INSURANCE",
      "FITNESS",
    ]);
  });

  it("sorts expired documents most overdue first", () => {
    const health = documentHealth(
      [doc("PUC", day(-2)), doc("INSURANCE", day(-90)), doc("FITNESS", day(-30))],
      TODAY,
    );
    expect(health.expired.map((d) => d.kind)).toEqual([
      "INSURANCE",
      "FITNESS",
      "PUC",
    ]);
    expect(health.blocking).toEqual(["INSURANCE", "FITNESS", "PUC"]);
  });

  it("carries the urgency band through on each timing", () => {
    const health = documentHealth(
      [doc("PUC", day(3)), doc("FITNESS", day(20))],
      TODAY,
    );
    expect(health.expiringSoon[0].urgency).toBe("CRITICAL");
    expect(health.expiringSoon[1].urgency).toBe("WARNING");
  });

  it("does not mutate the array it is given", () => {
    const documents = [doc("FITNESS", day(25)), doc("PUC", day(2))];
    const order = documents.map((d) => d.kind);
    documentHealth(documents, TODAY);
    expect(documents.map((d) => d.kind)).toEqual(order);
  });
});

// ────────────────────────────────────────────────────────────

describe("canAssignVehicle", () => {
  it("allows an available, road-legal vehicle", () => {
    expect(canAssignVehicle(vehicle(), ROADWORTHY, TODAY)).toEqual({ ok: true });
  });

  it("allows one whose mandatory document expires today", () => {
    const result = canAssignVehicle(
      vehicle(),
      [doc("INSURANCE", day(0))],
      TODAY,
    );
    expect(result.ok).toBe(true);
  });

  it("refuses one whose mandatory document expired yesterday", () => {
    const result = canAssignVehicle(
      vehicle(),
      [doc("INSURANCE", day(-1))],
      TODAY,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/insurance/i);
    expect(result.reason).toMatch(/expired/i);
  });

  it("names every expired mandatory document, not just the first", () => {
    const result = canAssignVehicle(
      vehicle(),
      [doc("INSURANCE", day(-2)), doc("FITNESS", day(-9))],
      TODAY,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Fitness/);
    expect(result.reason).toMatch(/Insurance/);
    expect(result.reason).toMatch(/have expired/);
  });

  it("allows a vehicle whose only expired document is optional", () => {
    const result = canAssignVehicle(
      vehicle(),
      [doc("INSURANCE", day(90)), doc("ROAD_TAX", day(-60), false)],
      TODAY,
    );
    expect(result.ok).toBe(true);
  });

  it("allows a vehicle with documents merely expiring soon", () => {
    const result = canAssignVehicle(
      vehicle(),
      [doc("INSURANCE", day(4)), doc("PUC", day(1))],
      TODAY,
    );
    expect(result.ok).toBe(true);
  });

  it("allows a vehicle carrying no documents at all", () => {
    // Nothing recorded is a data gap, not a legal finding — the expiry desk
    // surfaces it, but the planner is not told a lie about why.
    expect(canAssignVehicle(vehicle(), [], TODAY).ok).toBe(true);
  });

  it("refuses a deactivated vehicle", () => {
    const result = canAssignVehicle(vehicle({ isActive: false }), ROADWORTHY, TODAY);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/deactivated/i);
  });

  it("refuses a soft-deleted vehicle", () => {
    const result = canAssignVehicle(
      vehicle({ deletedAt: day(-5) }),
      ROADWORTHY,
      TODAY,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/removed/i);
  });

  it.each([
    ["ASSIGNED", /already assigned/i],
    ["LOADING", /loading/i],
    ["DISPATCHED", /dispatched/i],
    ["IN_TRANSIT", /in transit/i],
    ["AT_HUB", /hub/i],
    ["UNLOADING", /unloading/i],
    ["MAINTENANCE", /maintenance/i],
    ["INACTIVE", /inactive/i],
  ] as const)("refuses a vehicle that is %s", (status, pattern) => {
    const result = canAssignVehicle(vehicle({ status }), ROADWORTHY, TODAY);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(pattern);
  });

  it("reports the expired document rather than the busy status", () => {
    // A planner told "in maintenance" books a different truck. A planner
    // told "insurance expired" calls the renewal desk. The legal fact wins.
    const result = canAssignVehicle(
      vehicle({ status: "MAINTENANCE" }),
      [doc("INSURANCE", day(-1))],
      TODAY,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/insurance/i);
  });

  it("reports deactivation ahead of everything else", () => {
    const result = canAssignVehicle(
      vehicle({ isActive: false, status: "MAINTENANCE" }),
      [doc("INSURANCE", day(-1))],
      TODAY,
    );
    expect(result.reason).toMatch(/deactivated/i);
  });

  it("omits a reason entirely when the answer is yes", () => {
    expect(canAssignVehicle(vehicle(), ROADWORTHY, TODAY).reason).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────

describe("canAssignDriver", () => {
  it("allows an available driver with a valid licence", () => {
    expect(canAssignDriver(driver(), TODAY)).toEqual({ ok: true });
  });

  it("allows a licence expiring today", () => {
    expect(canAssignDriver(driver({ licenceExpiry: day(0) }), TODAY).ok).toBe(true);
  });

  it("refuses a licence that expired yesterday", () => {
    const result = canAssignDriver(driver({ licenceExpiry: day(-1) }), TODAY);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/licence has expired/i);
  });

  it("allows a licence expiring inside the warning window", () => {
    expect(canAssignDriver(driver({ licenceExpiry: day(3) }), TODAY).ok).toBe(true);
  });

  it("refuses a driver with no licence number on record", () => {
    const result = canAssignDriver(driver({ licenceNumber: null }), TODAY);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no licence number/i);
  });

  it("refuses a driver with a licence number but no expiry", () => {
    const result = canAssignDriver(driver({ licenceExpiry: null }), TODAY);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no licence expiry/i);
  });

  it("refuses a deactivated driver", () => {
    const result = canAssignDriver(driver({ isActive: false }), TODAY);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/deactivated/i);
  });

  it("refuses a soft-deleted driver", () => {
    const result = canAssignDriver(driver({ deletedAt: day(-1) }), TODAY);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/removed/i);
  });

  it.each([
    ["ON_TRIP", /already on a trip/i],
    ["ON_LEAVE", /on leave/i],
    ["SUSPENDED", /suspended/i],
    ["INACTIVE", /inactive/i],
  ] as const)("refuses a driver who is %s", (status, pattern) => {
    const result = canAssignDriver(driver({ status }), TODAY);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(pattern);
  });

  it("reports suspension ahead of the licence", () => {
    // Suspension is a decision someone made about this person; a lapsed
    // licence is paperwork. The first is the more useful thing to say.
    const result = canAssignDriver(
      driver({ status: "SUSPENDED", licenceExpiry: day(-30) }),
      TODAY,
    );
    expect(result.reason).toMatch(/suspended/i);
  });

  it("reports the expired licence ahead of being on a trip", () => {
    const result = canAssignDriver(
      driver({ status: "ON_TRIP", licenceExpiry: day(-1) }),
      TODAY,
    );
    expect(result.reason).toMatch(/licence has expired/i);
  });

  it("omits a reason entirely when the answer is yes", () => {
    expect(canAssignDriver(driver(), TODAY).reason).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────

describe("licenceHealth", () => {
  it("renders a valid licence as OK", () => {
    expect(licenceHealth({ licenceExpiry: day(400) }, TODAY).status).toBe("OK");
  });

  it("renders a licence inside the window as expiring", () => {
    const health = licenceHealth({ licenceExpiry: day(10) }, TODAY);
    expect(health.status).toBe("EXPIRING");
    expect(health.expiringSoon[0].kind).toBe("DRIVING_LICENCE");
  });

  it("renders a lapsed licence as blocking", () => {
    const health = licenceHealth({ licenceExpiry: day(-1) }, TODAY);
    expect(health.status).toBe("EXPIRED");
    expect(health.blocking).toEqual(["DRIVING_LICENCE"]);
  });

  it("says nothing when no expiry is recorded", () => {
    // The blocking decision belongs to canAssignDriver; a badge should not
    // claim a licence is fine when there is no licence to judge.
    expect(licenceHealth({ licenceExpiry: null }, TODAY).status).toBe("OK");
  });
});
