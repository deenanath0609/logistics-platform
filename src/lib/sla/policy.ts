import type { SlaState } from "@/generated/prisma/client";

/**
 * The SLA transit clock.
 *
 * Pure — no database, no `new Date()`, no session. Everything the maths
 * needs arrives as an argument, which is what makes the awkward cases
 * cheap to test, and the awkward cases are the whole point: a booking
 * taken at 18:40 on the Friday before a branch holiday is exactly where a
 * naive `bookedAt + 24h` quietly promises something nobody can deliver.
 *
 * Two decisions worth stating, because both are load-bearing:
 *
 *  · **Fixed offset, not `Intl`.** Branch opening hours are stored as
 *    "HH:mm in the org timezone", and India runs a single offset (+05:30)
 *    with no daylight saving. A fixed offset is therefore exactly correct
 *    here, and it is deterministic on a Node build without full ICU —
 *    which this codebase already had to work around once, in
 *    `src/lib/bulk/parse.ts`. `offsetMinutes` is on the calendar so a
 *    second country is a data change rather than a rewrite.
 *
 *  · **A lane with no policy is NOT_APPLICABLE, not "24 hours".** An
 *    invented commitment is worse than an absent one: it produces breach
 *    figures a branch manager will correctly refuse to accept, and the
 *    first argument about a made-up number is the last time anyone trusts
 *    the tower. See docs/BRD.html §A.11.
 */

// ────────────────────────────────────────────────────────────
// Time in a branch's local wall clock
// ────────────────────────────────────────────────────────────

/** India Standard Time. No daylight saving, so an offset is exact. */
export const IST_OFFSET_MINUTES = 330;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Schema defaults, used when a branch has left the field blank. */
const DEFAULT_OPENING_MS = 9 * HOUR_MS;
const DEFAULT_CLOSING_MS = 19 * HOUR_MS;

/**
 * Ceiling on how far the calendar walk will search for a working day.
 * A branch whose calendar leaves no working day at all is a data error;
 * the guards below neutralise it rather than looping to the heat death of
 * the universe.
 */
const MAX_CALENDAR_DAYS = 400;

export type WorkingCalendar = {
  /** "HH:mm" local. Null falls back to 09:00. */
  openingTime?: string | null;
  /** "HH:mm" local. Null falls back to 19:00. */
  closingTime?: string | null;
  /** "HH:mm" local. Null means the branch has no cut-off. */
  bookingCutoff?: string | null;
  /** 0 = Sunday … 6 = Saturday. */
  weeklyOffDays?: readonly number[];
  /** Local dates, "YYYY-MM-DD". */
  holidays?: readonly string[];
  /** Minutes east of UTC. Defaults to IST. */
  offsetMinutes?: number;
};

/** A calendar reduced to the numbers the walk actually uses. */
export type CalendarShape = {
  openingMs: number;
  closingMs: number;
  cutoffMs: number | null;
  offDays: ReadonlySet<number>;
  holidays: ReadonlySet<string>;
  offsetMinutes: number;
};

/** "HH:mm" to milliseconds since local midnight. */
function parseClock(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;

  return hours * HOUR_MS + minutes * MINUTE_MS;
}

export function shapeCalendar(calendar: WorkingCalendar = {}): CalendarShape {
  let openingMs = parseClock(calendar.openingTime) ?? DEFAULT_OPENING_MS;
  let closingMs = parseClock(calendar.closingTime) ?? DEFAULT_CLOSING_MS;

  // A branch that closes before it opens cannot be worked with. Falling
  // back is right: the alternative is a zero-length working day, which
  // makes every due date infinitely far away and every SLA green forever.
  if (closingMs <= openingMs) {
    openingMs = DEFAULT_OPENING_MS;
    closingMs = DEFAULT_CLOSING_MS;
  }

  const offDays = new Set(
    (calendar.weeklyOffDays ?? []).filter(
      (day) => Number.isInteger(day) && day >= 0 && day <= 6,
    ),
  );

  // Seven days off is not a calendar, it is a typo. Ignoring it keeps the
  // shipment measurable instead of pushing its due date past the guard.
  const usableOffDays: ReadonlySet<number> =
    offDays.size >= 7 ? new Set<number>() : offDays;

  return {
    openingMs,
    closingMs,
    cutoffMs: parseClock(calendar.bookingCutoff),
    offDays: usableOffDays,
    holidays: new Set(calendar.holidays ?? []),
    offsetMinutes: calendar.offsetMinutes ?? IST_OFFSET_MINUTES,
  };
}

type LocalMoment = {
  /** "YYYY-MM-DD" in branch-local time. */
  ymd: string;
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  /** Milliseconds since local midnight. */
  msOfDay: number;
};

/** Reads an instant as a branch-local wall-clock moment. */
export function toLocal(at: Date, offsetMinutes: number): LocalMoment {
  const shifted = new Date(at.getTime() + offsetMinutes * MINUTE_MS);

  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");

  return {
    ymd: `${year}-${month}-${day}`,
    dayOfWeek: shifted.getUTCDay(),
    msOfDay:
      shifted.getUTCHours() * HOUR_MS +
      shifted.getUTCMinutes() * MINUTE_MS +
      shifted.getUTCSeconds() * 1000 +
      shifted.getUTCMilliseconds(),
  };
}

/** The instant at a branch-local date and time-of-day. */
export function fromLocal(
  ymd: string,
  msOfDay: number,
  offsetMinutes: number,
): Date {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(
    Date.UTC(year, month - 1, day) + msOfDay - offsetMinutes * MINUTE_MS,
  );
}

function shiftDays(ymd: string, days: number): { ymd: string; dayOfWeek: number } {
  const [year, month, day] = ymd.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);

  return {
    ymd: `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}-${String(moved.getUTCDate()).padStart(2, "0")}`,
    dayOfWeek: moved.getUTCDay(),
  };
}

export function isWorkingDay(
  shape: CalendarShape,
  ymd: string,
  dayOfWeek: number,
): boolean {
  return !shape.offDays.has(dayOfWeek) && !shape.holidays.has(ymd);
}

/**
 * A day the calendar walk stepped over.
 *
 * Recorded so the admin screen can say "skipped Sunday 30 Aug, skipped
 * Diwali 20 Oct" instead of presenting a due date as an oracle. A transit
 * promise nobody can retrace is a transit promise nobody will accept.
 */
export type SkippedDay = {
  ymd: string;
  dayOfWeek: number;
  reason: "Weekly off" | "Branch holiday";
};

/**
 * The next day the branch is open, starting the search after `ymd`.
 *
 * `skipped` is an optional collector rather than a second return value:
 * the walk is on the hot path of every scan, and the explanation is only
 * wanted by one screen.
 */
function nextWorkingDay(
  shape: CalendarShape,
  ymd: string,
  skipped?: SkippedDay[],
): { ymd: string; dayOfWeek: number } {
  let cursor = shiftDays(ymd, 1);

  for (let guard = 0; guard < MAX_CALENDAR_DAYS; guard++) {
    if (isWorkingDay(shape, cursor.ymd, cursor.dayOfWeek)) return cursor;

    skipped?.push({
      ymd: cursor.ymd,
      dayOfWeek: cursor.dayOfWeek,
      // Holidays are named first: a branch shut for Holi on a Tuesday is
      // a holiday, and calling it a weekly off would send somebody to
      // correct a rota that is perfectly correct.
      reason: shape.holidays.has(cursor.ymd) ? "Branch holiday" : "Weekly off",
    });

    cursor = shiftDays(cursor.ymd, 1);
  }

  // Every day for more than a year is a holiday. Return the cursor rather
  // than throwing: a wrong due date is recoverable, a scanner that dies on
  // one bad branch calendar stops measuring the whole network.
  return cursor;
}

// ────────────────────────────────────────────────────────────
// Where the clock starts
// ────────────────────────────────────────────────────────────

export type ClockOptions = {
  /** Elapse time only inside branch working hours. */
  useWorkingHours: boolean;
  /** A booking after the branch cut-off starts next working morning. */
  respectCutoff: boolean;
};

/**
 * Moves a raw start instant to the moment the promise actually begins.
 *
 * Four things can push it forward, in this order: the branch is shut that
 * day, the branch has not opened yet, the booking missed the cut-off, or
 * the branch has already closed. Each is a separate rule because each is
 * separately configurable, and collapsing them produces a cut-off that
 * silently stops working the moment somebody turns working hours off.
 */
export function startOfClock(
  startedAt: Date,
  shape: CalendarShape,
  options: ClockOptions,
): Date {
  return explainClockStart(startedAt, shape, options).at;
}

/** One rule that moved the clock's start, in words. */
export type ClockStep = {
  /** Short name of the rule, e.g. "Cut-off". */
  rule: string;
  /** What it did, phrased for somebody who did not write the code. */
  detail: string;
  /** Where the clock stood after this rule ran. */
  at: Date;
};

export type ClockStartExplanation = {
  at: Date;
  steps: ClockStep[];
  skipped: SkippedDay[];
};

/**
 * `startOfClock`, showing its working.
 *
 * The rules and their order are identical because there is only one copy
 * of them — `startOfClock` is a thin call onto this. A second
 * implementation kept "for the UI" would drift within a month, and the
 * screen whose whole job is explaining the maths would be the one lying
 * about it.
 */
export function explainClockStart(
  startedAt: Date,
  shape: CalendarShape,
  options: ClockOptions,
): ClockStartExplanation {
  const steps: ClockStep[] = [];
  const skipped: SkippedDay[] = [];

  if (!options.useWorkingHours && !options.respectCutoff) {
    steps.push({
      rule: "Wall clock",
      detail:
        "This policy ignores working hours and the cut-off, so the clock starts the moment the consignment does.",
      at: startedAt,
    });
    return { at: startedAt, steps, skipped };
  }

  let { ymd, dayOfWeek, msOfDay } = toLocal(startedAt, shape.offsetMinutes);

  const here = () => fromLocal(ymd, msOfDay, shape.offsetMinutes);

  const moveToNextMorning = () => {
    const next = nextWorkingDay(shape, ymd, skipped);
    ymd = next.ymd;
    dayOfWeek = next.dayOfWeek;
    msOfDay = shape.openingMs;
  };

  // Shut today — a Sunday booking drop or a branch holiday.
  if (!isWorkingDay(shape, ymd, dayOfWeek)) {
    const wasShutOn = ymd;
    const reason = shape.holidays.has(ymd) ? "a branch holiday" : "a weekly off";
    moveToNextMorning();
    steps.push({
      rule: "Branch shut",
      detail: `${wasShutOn} is ${reason}. The clock waits for ${ymd} opening at ${clockLabel(shape.openingMs)}.`,
      at: here(),
    });
  }

  // Dropped through the letterbox before the shutters went up.
  if (options.useWorkingHours && msOfDay < shape.openingMs) {
    const was = msOfDay;
    msOfDay = shape.openingMs;
    steps.push({
      rule: "Before opening",
      detail: `Handed over at ${clockLabel(was)}, before the branch opens at ${clockLabel(shape.openingMs)}.`,
      at: here(),
    });
  }

  // Missed the cut-off: §A.11's headline rule.
  if (
    options.respectCutoff &&
    shape.cutoffMs !== null &&
    msOfDay > shape.cutoffMs
  ) {
    const was = msOfDay;
    const cutoff = shape.cutoffMs;
    moveToNextMorning();
    steps.push({
      rule: "Cut-off missed",
      detail: `${clockLabel(was)} is past the ${clockLabel(cutoff)} cut-off, so the promise begins ${ymd} at ${clockLabel(shape.openingMs)}.`,
      at: here(),
    });
  }

  // Booked after closing at a branch with no cut-off configured.
  if (options.useWorkingHours && msOfDay >= shape.closingMs) {
    const was = msOfDay;
    moveToNextMorning();
    steps.push({
      rule: "After closing",
      detail: `${clockLabel(was)} is at or after the ${clockLabel(shape.closingMs)} close, so the clock starts ${ymd} morning.`,
      at: here(),
    });
  }

  if (steps.length === 0) {
    steps.push({
      rule: "Inside working hours",
      detail:
        "The branch was open and the cut-off had not passed, so the clock started immediately.",
      at: startedAt,
    });
  }

  return { at: here(), steps, skipped };
}

/** Milliseconds since local midnight back as "HH:mm", for explanations. */
function clockLabel(msOfDay: number): string {
  const total = Math.floor(msOfDay / MINUTE_MS);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Adds a duration measured in *working* time.
 *
 * Walks the calendar a day at a time, consuming whatever the branch has
 * open. Landing exactly on closing time stays at closing rather than
 * rolling to the next morning — a promise met at the last minute of the
 * day was met.
 */
export function addWorkingTime(
  from: Date,
  durationMs: number,
  shape: CalendarShape,
): Date {
  return explainWorkingTime(from, durationMs, shape).at;
}

export type WorkingTimeExplanation = {
  at: Date;
  /** Weekends and holidays the walk stepped over on the way. */
  skipped: SkippedDay[];
  /** How many separate working days the duration was spread across. */
  workingDaysUsed: number;
};

/** `addWorkingTime`, reporting the days it stepped over. */
export function explainWorkingTime(
  from: Date,
  durationMs: number,
  shape: CalendarShape,
): WorkingTimeExplanation {
  const skipped: SkippedDay[] = [];
  if (durationMs <= 0) return { at: from, skipped, workingDaysUsed: 0 };

  let { ymd, dayOfWeek, msOfDay } = toLocal(from, shape.offsetMinutes);
  let remaining = durationMs;
  let workingDaysUsed = 0;

  for (let guard = 0; guard < MAX_CALENDAR_DAYS; guard++) {
    if (!isWorkingDay(shape, ymd, dayOfWeek)) {
      skipped.push({
        ymd,
        dayOfWeek,
        reason: shape.holidays.has(ymd) ? "Branch holiday" : "Weekly off",
      });
      const next = nextWorkingDay(shape, ymd, skipped);
      ymd = next.ymd;
      dayOfWeek = next.dayOfWeek;
      msOfDay = shape.openingMs;
      continue;
    }

    const cursor = Math.max(msOfDay, shape.openingMs);
    const available = shape.closingMs - cursor;

    if (available > 0 && remaining <= available) {
      return {
        at: fromLocal(ymd, cursor + remaining, shape.offsetMinutes),
        skipped,
        workingDaysUsed: workingDaysUsed + 1,
      };
    }

    if (available > 0) {
      remaining -= available;
      workingDaysUsed++;
    }

    const next = nextWorkingDay(shape, ymd, skipped);
    ymd = next.ymd;
    dayOfWeek = next.dayOfWeek;
    msOfDay = shape.openingMs;
  }

  // Unreachable for any sane calendar; see MAX_CALENDAR_DAYS.
  return {
    at: fromLocal(ymd, shape.openingMs, shape.offsetMinutes),
    skipped,
    workingDaysUsed,
  };
}

/** Working milliseconds between two instants. Used by transit-time KPIs. */
export function workingTimeBetween(
  from: Date,
  to: Date,
  shape: CalendarShape,
): number {
  if (to.getTime() <= from.getTime()) return 0;

  let { ymd, dayOfWeek, msOfDay } = toLocal(from, shape.offsetMinutes);
  const end = toLocal(to, shape.offsetMinutes);
  let total = 0;

  for (let guard = 0; guard < MAX_CALENDAR_DAYS; guard++) {
    const finalDay = ymd === end.ymd;

    if (isWorkingDay(shape, ymd, dayOfWeek)) {
      const start = Math.min(
        Math.max(msOfDay, shape.openingMs),
        shape.closingMs,
      );
      const stop = finalDay
        ? Math.min(Math.max(end.msOfDay, shape.openingMs), shape.closingMs)
        : shape.closingMs;

      if (stop > start) total += stop - start;
    }

    if (finalDay) return total;
    if (ymd > end.ymd) return total;

    const next = shiftDays(ymd, 1);
    ymd = next.ymd;
    dayOfWeek = next.dayOfWeek;
    msOfDay = 0;
  }

  return total;
}

// ────────────────────────────────────────────────────────────
// Policy resolution
// ────────────────────────────────────────────────────────────

/** The lane a shipment actually travels, as far as SLA is concerned. */
export type LaneKey = {
  serviceTypeId: string | null;
  originCityId: string | null;
  destinationCityId: string | null;
  /** A pincode can belong to several zones, so these are lists. */
  originZoneIds: readonly string[];
  destinationZoneIds: readonly string[];
};

export type PolicyCandidate = {
  id: string;
  code: string;
  name: string;
  serviceTypeId: string | null;
  originCityId: string | null;
  destinationCityId: string | null;
  originZoneId: string | null;
  destinationZoneId: string | null;
  transitHours: number;
  useWorkingHours: boolean;
  respectCutoff: boolean;
  atRiskPercent: number;
  priority: number;
  isActive: boolean;
};

export type PolicyMatch = {
  policy: PolicyCandidate;
  /** Higher is more specific. Reported so the UI can explain the choice. */
  specificity: number;
  matchedOn: "city" | "zone" | "service" | "network";
};

const CITY_WEIGHT = 20;
const ZONE_WEIGHT = 10;
const SERVICE_WEIGHT = 1;

/**
 * Picks the policy that governs a lane.
 *
 * Most specific first — service + city pair, then service + zone pair,
 * then the service default — exactly as §A.11 and the schema comment
 * describe. `priority` outranks specificity because it is the only thing
 * an operations manager has to say "no, this one, whatever your scoring
 * thinks"; without that, a temporary festival-season override could not
 * be expressed at all.
 */
export function resolvePolicy(
  candidates: readonly PolicyCandidate[],
  lane: LaneKey,
): PolicyMatch | null {
  return rankPolicies(candidates, lane)[0] ?? null;
}

/** How narrowly a policy is drawn, independent of any lane. */
export type PolicyScope = Pick<
  PolicyCandidate,
  | "serviceTypeId"
  | "originCityId"
  | "destinationCityId"
  | "originZoneId"
  | "destinationZoneId"
>;

/**
 * The specificity a policy would score if it matched.
 *
 * Same weights, same arithmetic as the resolver — the admin list uses it
 * to sort twelve overlapping policies from narrowest to broadest without
 * having to invent a lane first.
 */
export function policySpecificity(policy: PolicyScope): number {
  const side = (cityId: string | null, zoneId: string | null) =>
    cityId ? CITY_WEIGHT : zoneId ? ZONE_WEIGHT : 0;

  return (
    side(policy.originCityId, policy.originZoneId) +
    side(policy.destinationCityId, policy.destinationZoneId) +
    (policy.serviceTypeId ? SERVICE_WEIGHT : 0)
  );
}

/** How a policy's scope reads in a list. "Any" is said out loud. */
export function describePolicyScope(policy: PolicyScope, names: {
  service?: string | null;
  originCity?: string | null;
  destinationCity?: string | null;
  originZone?: string | null;
  destinationZone?: string | null;
}): { origin: string; destination: string; service: string } {
  return {
    origin:
      names.originCity ?? names.originZone ?? (policy.originCityId || policy.originZoneId ? "—" : "Anywhere"),
    destination:
      names.destinationCity ??
      names.destinationZone ??
      (policy.destinationCityId || policy.destinationZoneId ? "—" : "Anywhere"),
    service: names.service ?? (policy.serviceTypeId ? "—" : "Any service"),
  };
}

/**
 * Every policy that covers a lane, best first.
 *
 * The tail matters as much as the head: an admin looking at "why did
 * SLA-NCR-STD win?" needs to see what it beat and by how much, and the
 * only honest way to show that is the same sorted list the resolver used.
 */
export function rankPolicies(
  candidates: readonly PolicyCandidate[],
  lane: LaneKey,
): PolicyMatch[] {
  const matches: PolicyMatch[] = [];

  for (const policy of candidates) {
    if (!policy.isActive) continue;

    if (policy.serviceTypeId && policy.serviceTypeId !== lane.serviceTypeId) {
      continue;
    }

    let specificity = 0;
    let cityMatched = false;
    let zoneMatched = false;
    let rejected = false;

    const side = (
      cityId: string | null,
      zoneId: string | null,
      laneCityId: string | null,
      laneZoneIds: readonly string[],
    ) => {
      if (cityId) {
        if (cityId !== laneCityId) {
          rejected = true;
          return;
        }
        specificity += CITY_WEIGHT;
        cityMatched = true;
        return;
      }
      if (zoneId) {
        if (!laneZoneIds.includes(zoneId)) {
          rejected = true;
          return;
        }
        specificity += ZONE_WEIGHT;
        zoneMatched = true;
      }
    };

    side(
      policy.originCityId,
      policy.originZoneId,
      lane.originCityId,
      lane.originZoneIds,
    );
    if (!rejected) {
      side(
        policy.destinationCityId,
        policy.destinationZoneId,
        lane.destinationCityId,
        lane.destinationZoneIds,
      );
    }
    if (rejected) continue;

    if (policy.serviceTypeId) specificity += SERVICE_WEIGHT;

    matches.push({
      policy,
      specificity,
      matchedOn: cityMatched
        ? "city"
        : zoneMatched
          ? "zone"
          : policy.serviceTypeId
            ? "service"
            : "network",
    });
  }

  matches.sort(
    (a, b) =>
      b.policy.priority - a.policy.priority ||
      b.specificity - a.specificity ||
      a.policy.code.localeCompare(b.policy.code),
  );

  return matches;
}

// ────────────────────────────────────────────────────────────
// The plan
// ────────────────────────────────────────────────────────────

export type SlaPlan =
  | {
      state: Extract<SlaState, "NOT_APPLICABLE">;
      /** Shown in the UI. "No SLA" with no explanation invites a ticket. */
      reason: string;
    }
  | {
      state: "SCHEDULED";
      policyId: string;
      matchedOn: PolicyMatch["matchedOn"];
      /** When the promise actually begins, after cut-off and calendar. */
      startedAt: Date;
      dueAt: Date;
      atRiskAt: Date;
      transitMinutes: number;
    };

export type PlanInput = {
  /** Pickup, or booking for a walk-in. */
  startedAt: Date;
  lane: LaneKey;
  policies: readonly PolicyCandidate[];
  /** The origin branch's calendar — the clock is theirs to start. */
  calendar?: WorkingCalendar;
};

/** Resolves a policy and computes the whole schedule for one shipment. */
export function planSla(input: PlanInput): SlaPlan {
  return explainPlan(input).plan;
}

export type PlanExplanation = {
  plan: SlaPlan;
  /** Every policy that covered the lane, winner first. */
  matches: PolicyMatch[];
  /** What moved the clock's start, in order. Empty when no policy won. */
  clockSteps: ClockStep[];
  /** Weekends and holidays stepped over, start and transit combined. */
  skipped: SkippedDay[];
  /** Working days the transit was spread across. */
  workingDaysUsed: number;
};

/**
 * `planSla`, showing its working.
 *
 * The single source of the schedule — `planSla` returns `.plan` from
 * this. Everything the admin screen prints therefore comes from the same
 * run that a shipment would get, which is the only version of "test a
 * lane" worth having: one that cannot be right on the test screen and
 * wrong in the scanner.
 */
export function explainPlan(input: PlanInput): PlanExplanation {
  const matches = rankPolicies(input.policies, input.lane);
  const match = matches[0];

  if (!match) {
    return {
      plan: {
        state: "NOT_APPLICABLE",
        reason: "No SLA policy covers this lane and service.",
      },
      matches,
      clockSteps: [],
      skipped: [],
      workingDaysUsed: 0,
    };
  }

  const { policy } = match;

  if (policy.transitHours <= 0) {
    return {
      plan: {
        state: "NOT_APPLICABLE",
        reason: `Policy ${policy.code} carries no transit commitment.`,
      },
      matches,
      clockSteps: [],
      skipped: [],
      workingDaysUsed: 0,
    };
  }

  const shape = shapeCalendar(input.calendar);
  const options: ClockOptions = {
    useWorkingHours: policy.useWorkingHours,
    respectCutoff: policy.respectCutoff,
  };

  const start = explainClockStart(input.startedAt, shape, options);
  const startedAt = start.at;
  const transitMs = policy.transitHours * HOUR_MS;

  // At-risk is a fraction of the same clock, not of wall time. Measuring
  // it any other way makes a Friday-evening booking read as at-risk before
  // the branch has opened on Monday to do anything about it.
  const atRiskPercent = Math.min(100, Math.max(0, policy.atRiskPercent));
  const atRiskMs = Math.round((transitMs * atRiskPercent) / 100);

  const advance = (durationMs: number): WorkingTimeExplanation =>
    policy.useWorkingHours
      ? explainWorkingTime(startedAt, durationMs, shape)
      : {
          at: new Date(startedAt.getTime() + durationMs),
          skipped: [],
          workingDaysUsed: 0,
        };

  const due = advance(transitMs);
  const atRisk = advance(atRiskMs);

  return {
    plan: {
      state: "SCHEDULED",
      policyId: policy.id,
      matchedOn: match.matchedOn,
      startedAt,
      dueAt: due.at,
      atRiskAt: atRisk.at,
      transitMinutes: Math.round(transitMs / MINUTE_MS),
    },
    matches,
    clockSteps: start.steps,
    // The at-risk walk is a prefix of the transit walk, so its skipped
    // days are already in `due.skipped`. Merging both would print Sunday
    // twice and invite the reader to think two Sundays were lost.
    skipped: dedupeDays([...start.skipped, ...due.skipped]),
    workingDaysUsed: due.workingDaysUsed,
  };
}

function dedupeDays(days: readonly SkippedDay[]): SkippedDay[] {
  const seen = new Set<string>();
  const out: SkippedDay[] = [];

  for (const day of days) {
    if (seen.has(day.ymd)) continue;
    seen.add(day.ymd);
    out.push(day);
  }

  return out.sort((a, b) => a.ymd.localeCompare(b.ymd));
}

// ────────────────────────────────────────────────────────────
// Where a shipment stands
// ────────────────────────────────────────────────────────────

export type SlaClock = {
  dueAt: Date;
  atRiskAt: Date | null;
  /** Actual delivery, once it happens. */
  settledAt: Date | null;
};

/**
 * The state of one shipment's clock.
 *
 * `now > dueAt`, not `>=`: a shipment delivered on the stroke of its
 * deadline was delivered on time. The at-risk comparison is `>=` for the
 * mirror reason — the threshold is the moment attention is wanted, so it
 * should fire at the threshold rather than a millisecond after it.
 */
export function evaluateSlaState(clock: SlaClock, now: Date): SlaState {
  if (clock.settledAt) {
    return clock.settledAt.getTime() > clock.dueAt.getTime()
      ? "BREACHED"
      : "MET";
  }

  if (now.getTime() > clock.dueAt.getTime()) return "BREACHED";

  if (clock.atRiskAt && now.getTime() >= clock.atRiskAt.getTime()) {
    return "AT_RISK";
  }

  return "ON_TIME";
}

/** Signed minutes against the promise. Positive is late, negative early. */
export function varianceMinutes(dueAt: Date, at: Date): number {
  return Math.round((at.getTime() - dueAt.getTime()) / MINUTE_MS);
}

/** "3 h 20 m" — the ageing column, shared with the exception tower. */
export function formatDuration(minutes: number): string {
  const value = Math.abs(Math.round(minutes));
  if (value < 60) return `${value} m`;

  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (hours < 48) return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;

  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

export const SLA_STATE_LABEL: Record<SlaState, string> = {
  ON_TIME: "On time",
  AT_RISK: "At risk",
  BREACHED: "Breached",
  MET: "Met",
  NOT_APPLICABLE: "No SLA",
};

/** Tone follows meaning, not the accent palette. */
export const SLA_STATE_TONE: Record<SlaState, string> = {
  ON_TIME: "bg-info-muted text-info",
  AT_RISK: "bg-warn-muted text-warn",
  BREACHED: "bg-bad-muted text-bad",
  MET: "bg-ok-muted text-ok",
  NOT_APPLICABLE: "bg-muted text-muted-foreground",
};
