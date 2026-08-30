"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { recordAudit } from "@/server/services/audit";
import { runSlaScan } from "@/lib/sla/scanner";
import {
  createMasterCrud,
  orgDefaults,
  zBool,
  zCode,
  zOptionalText,
} from "@/server/services/master-crud";
import {
  IST_OFFSET_MINUTES,
  explainPlan,
  fromLocal,
  policySpecificity,
  type ClockStep,
  type LaneKey,
  type PolicyCandidate,
  type SkippedDay,
  type WorkingCalendar,
} from "@/lib/sla/policy";

/**
 * Server actions for the SLA policy master.
 *
 * The CRUD is the standard master shape. `testLane` is the interesting
 * one: it answers "which policy governs this lane, and what would it
 * promise?" by calling the *same* pure functions the scanner calls, so a
 * lane that tests clean cannot then behave differently on a real booking.
 */

// ────────────────────────────────────────────────────────────
// CRUD
// ────────────────────────────────────────────────────────────

const schema = z.object({
  code: zCode(2, 30),
  name: z.string().trim().min(2, "Required").max(120),
  serviceTypeId: zOptionalText(40),
  originCityId: zOptionalText(40),
  destinationCityId: zOptionalText(40),
  originZoneId: zOptionalText(40),
  destinationZoneId: zOptionalText(40),
  transitHours: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
    z
      .number()
      .int("Whole hours")
      .min(1, "A promise of zero hours is not a promise")
      .max(24 * 30, "Longer than a month is a data-entry slip"),
  ),
  useWorkingHours: zBool,
  respectCutoff: zBool,
  atRiskPercent: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? 80 : Number(v)),
    z.number().int().min(1, "At least 1%").max(100, "At most 100%"),
  ),
  priority: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? 0 : Number(v)),
    z.number().int().min(0).max(1000),
  ),
  isActive: zBool,
});

const crud = createMasterCrud({
  model: "slaPolicy",
  entity: "SlaPolicy",
  refField: "code",
  label: "SLA policy",
  readPermission: "master.read",
  // Not `master.manage`: changing a transit promise changes what every
  // branch is measured against, which is why the catalogue gives it its
  // own sensitive permission.
  writePermission: "sla.manage",
  schema,
  path: "/masters/sla-policies",
  createDefaults: orgDefaults,
});

export const createSlaPolicy = crud.create;
export const updateSlaPolicy = crud.update;
export const setSlaPolicyActive = crud.setActive;

// ────────────────────────────────────────────────────────────
// Apply a policy change to work already in flight
// ────────────────────────────────────────────────────────────

/**
 * Re-runs the SLA scan now rather than at the next sweep.
 *
 * The sweep would pick these up within a few minutes on its own. The
 * button exists because the minutes after somebody creates the first
 * policy are exactly when they need to see it working — a screen that
 * says "it will start measuring shortly, probably" is a screen people
 * stop trusting, and the first thing they do instead is create a second
 * policy in case the first one did not take.
 *
 * Every shipment it touches is an upsert keyed on the shipment, so
 * pressing it twice costs time and changes nothing.
 */
export async function recomputeSla(): Promise<
  { ok: true; message: string } | { ok: false; error: string }
> {
  try {
    const user = await authorize("sla.manage");

    const result = await runSlaScan({ maxShipments: 5_000 });

    await recordAudit({
      user,
      action: "UPDATE",
      entity: "ShipmentSla",
      entityId: "bulk-recompute",
      entityRef: "SLA recompute",
      after: {
        scanned: result.scanned,
        scheduled: result.scheduled,
        notApplicable: result.notApplicable,
        exceptionsOpened: result.exceptionsOpened,
      },
      reason: "Manual recompute after an SLA policy change",
    });

    revalidatePath("/masters/sla-policies");

    if (result.scheduled === 0 && result.notApplicable > 0) {
      return {
        ok: false,
        error: `${result.notApplicable} shipment(s) still have no policy covering their lane. Test the lane above to see what is missing.`,
      };
    }

    return {
      ok: true,
      message:
        `${result.scanned} shipment(s) rescanned — ${result.scheduled} now measured` +
        (result.notApplicable > 0
          ? `, ${result.notApplicable} still uncovered.`
          : "."),
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { ok: false, error: "You do not have permission to do that." };
    }
    console.error("[sla-policies] recompute failed", error);
    return { ok: false, error: "The recompute failed. Nothing was changed." };
  }
}

// ────────────────────────────────────────────────────────────
// Test a lane
// ────────────────────────────────────────────────────────────

export type LaneTestCandidate = {
  code: string;
  name: string;
  specificity: number;
  priority: number;
  transitHours: number;
  matchedOn: "city" | "zone" | "service" | "network";
  isWinner: boolean;
};

export type LaneTestResult =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Null when nothing covered the lane. */
      winner: {
        code: string;
        name: string;
        transitHours: number;
        atRiskPercent: number;
        useWorkingHours: boolean;
        respectCutoff: boolean;
        matchedOn: string;
        specificity: number;
      } | null;
      /** Why there is no promise, when there is none. */
      notApplicableReason: string | null;
      candidates: LaneTestCandidate[];
      /** Branch whose working calendar was used, and what it says. */
      calendar: {
        branchCode: string;
        branchName: string;
        openingTime: string;
        closingTime: string;
        bookingCutoff: string | null;
        weeklyOffDays: number[];
        holidayCount: number;
      } | null;
      requestedAt: Date;
      startedAt: Date | null;
      atRiskAt: Date | null;
      dueAt: Date | null;
      steps: ClockStep[];
      skipped: SkippedDay[];
      workingDaysUsed: number;
    };

const testSchema = z.object({
  serviceTypeId: z.string().min(1, "Choose a service type"),
  originCityId: z.string().min(1, "Choose an origin"),
  destinationCityId: z.string().min(1, "Choose a destination"),
  /** "YYYY-MM-DDTHH:mm" read as branch-local wall-clock time. */
  bookedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Pick a date and time"),
  originBranchId: z.string().optional().default(""),
});

/** Every zone a city sits in, via the pincodes mapped to it. */
async function zonesForCity(cityId: string): Promise<string[]> {
  const rows = await prisma.zonePincode.findMany({
    where: { pincode: { cityId } },
    select: { zoneId: true },
    distinct: ["zoneId"],
  });
  return rows.map((row) => row.zoneId);
}

/**
 * Resolves one lane against the live policy table and reports the whole
 * calculation.
 *
 * Read-only, so it needs only `master.read` — someone who can see the
 * policies should be able to ask what they do. The answer is the thing
 * the screen exists for: twelve overlapping policies are unreadable as a
 * list, and entirely readable as "for this lane, this one wins, and here
 * is what it beat".
 */
export async function testLane(formData: FormData): Promise<LaneTestResult> {
  try {
    const user = await authorize("master.read");

    const parsed = testSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "That request made no sense.",
      };
    }

    const { serviceTypeId, originCityId, destinationCityId, bookedAt } =
      parsed.data;

    const [rows, originZoneIds, destinationZoneIds] = await Promise.all([
      prisma.slaPolicy.findMany({ where: { orgId: user.orgId } }),
      zonesForCity(originCityId),
      zonesForCity(destinationCityId),
    ]);

    const policies: PolicyCandidate[] = rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      serviceTypeId: row.serviceTypeId,
      originCityId: row.originCityId,
      destinationCityId: row.destinationCityId,
      originZoneId: row.originZoneId,
      destinationZoneId: row.destinationZoneId,
      transitHours: row.transitHours,
      useWorkingHours: row.useWorkingHours,
      respectCutoff: row.respectCutoff,
      atRiskPercent: row.atRiskPercent,
      priority: row.priority,
      isActive: row.isActive,
    }));

    // The clock is the origin branch's. Given one, use it; otherwise pick
    // a branch in the origin city, hubs first, which is what a booking
    // from that city would route through anyway.
    const branch = parsed.data.originBranchId
      ? await prisma.branch.findUnique({
          where: { id: parsed.data.originBranchId },
          select: BRANCH_SELECT,
        })
      : await prisma.branch.findFirst({
          where: { orgId: user.orgId, cityId: originCityId, isActive: true },
          orderBy: [{ type: "asc" }, { code: "asc" }],
          select: BRANCH_SELECT,
        });

    const [date, time] = bookedAt.split("T");
    const [hours, minutes] = time.split(":").map(Number);
    const requestedAt = fromLocal(
      date,
      (hours * 60 + minutes) * 60_000,
      IST_OFFSET_MINUTES,
    );

    // A year either side: a holiday last month still shortens a re-scan of
    // an old shipment, and one next month is exactly what this screen is
    // for catching before somebody promises through it.
    const holidays = branch
      ? await prisma.branchHoliday.findMany({
          where: {
            branchId: branch.id,
            date: {
              gte: new Date(requestedAt.getTime() - 365 * 86_400_000),
              lte: new Date(requestedAt.getTime() + 365 * 86_400_000),
            },
          },
          select: { date: true },
        })
      : [];

    const calendar: WorkingCalendar | undefined = branch
      ? {
          openingTime: branch.openingTime,
          closingTime: branch.closingTime,
          bookingCutoff: branch.bookingCutoff,
          weeklyOffDays: branch.weeklyOffDays,
          // `@db.Date` comes back at midnight UTC, so the UTC components
          // are the calendar date as stored.
          holidays: holidays.map((row) => row.date.toISOString().slice(0, 10)),
        }
      : undefined;

    const lane: LaneKey = {
      serviceTypeId,
      originCityId,
      destinationCityId,
      originZoneIds,
      destinationZoneIds,
    };

    const explained = explainPlan({
      startedAt: requestedAt,
      lane,
      policies,
      calendar,
    });

    const winnerId =
      explained.plan.state === "SCHEDULED" ? explained.plan.policyId : null;

    const candidates: LaneTestCandidate[] = explained.matches.map((match) => ({
      code: match.policy.code,
      name: match.policy.name,
      specificity: match.specificity,
      priority: match.policy.priority,
      transitHours: match.policy.transitHours,
      matchedOn: match.matchedOn,
      isWinner: match.policy.id === explained.matches[0]?.policy.id,
    }));

    const top = explained.matches[0]?.policy ?? null;

    return {
      ok: true,
      winner:
        top && winnerId
          ? {
              code: top.code,
              name: top.name,
              transitHours: top.transitHours,
              atRiskPercent: top.atRiskPercent,
              useWorkingHours: top.useWorkingHours,
              respectCutoff: top.respectCutoff,
              matchedOn: explained.matches[0].matchedOn,
              specificity: policySpecificity(top),
            }
          : null,
      notApplicableReason:
        explained.plan.state === "NOT_APPLICABLE" ? explained.plan.reason : null,
      candidates,
      calendar: branch
        ? {
            branchCode: branch.code,
            branchName: branch.name,
            openingTime: branch.openingTime ?? "09:00",
            closingTime: branch.closingTime ?? "19:00",
            bookingCutoff: branch.bookingCutoff,
            weeklyOffDays: branch.weeklyOffDays,
            holidayCount: holidays.length,
          }
        : null,
      requestedAt,
      startedAt:
        explained.plan.state === "SCHEDULED" ? explained.plan.startedAt : null,
      atRiskAt:
        explained.plan.state === "SCHEDULED" ? explained.plan.atRiskAt : null,
      dueAt: explained.plan.state === "SCHEDULED" ? explained.plan.dueAt : null,
      steps: explained.clockSteps,
      skipped: explained.skipped,
      workingDaysUsed: explained.workingDaysUsed,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { ok: false, error: "You do not have permission to do that." };
    }
    console.error("[sla-policies] lane test failed", error);
    return { ok: false, error: "Could not work that lane out. Try again." };
  }
}

const BRANCH_SELECT = {
  id: true,
  code: true,
  name: true,
  openingTime: true,
  closingTime: true,
  bookingCutoff: true,
  weeklyOffDays: true,
} as const;
