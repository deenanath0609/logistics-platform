/**
 * What happens after a delivery attempt.
 *
 * A failed attempt is a fact, not a status. The shipment goes back to
 * `RECEIVED_AT_HUB`, `attemptCount` goes up by one, and the attempt row
 * survives forever — see docs/BRD.html §A.10. This module decides only
 * what should happen *next*: another visit, a hold for ops, or a proposed
 * return to origin.
 *
 * Every behavioural decision here reads the automation flags on the
 * `ReasonCode` row. Operations owns that table: adding "society gate
 * closed" or making "phone unreachable" chargeable must be a data change,
 * not a release. Nothing in this file may branch on a reason *code*.
 *
 * Pure — no database, no clock unless you hand one in — which is what
 * makes the whole policy exhaustively testable.
 */

/**
 * The automation flags operations maintains on a delivery-failure reason.
 * Structurally satisfied by a `ReasonCode` row.
 */
export type AttemptReasonPolicy = {
  triggersReattempt: boolean;
  triggersException: boolean;
  isChargeable: boolean;
  notifiesConsignor: boolean;
  notifiesConsignee: boolean;
  requiresPhoto: boolean;
  requiresRemarks: boolean;
};

/**
 * What the state machine knows about the consignment.
 *
 * `attemptCount` is the number of failed attempts recorded *including the
 * one being decided on*. Callers that ask before writing the attempt must
 * pass `shipment.attemptCount + 1`; callers that ask after the event has
 * been appended pass the stored value, which the projection has already
 * incremented.
 */
export type AttemptShipmentFacts = {
  attemptCount: number;
};

/** The contracted attempt allowance for this service. */
export type AttemptServiceFacts = {
  maxDeliveryAttempts: number;
};

export type NextActionOptions = {
  /** The moment of the failed attempt. Defaults to now. */
  now?: Date;
  /** Branch weekly offs, 0 = Sunday … 6 = Saturday. */
  weeklyOffDays?: number[];
  /** Branch holidays, as Dates or `yyyy-mm-dd` strings. */
  holidays?: Array<Date | string>;
  /** Local hour the reattempt is scheduled for. Branch opening time. */
  reattemptHour?: number;
};

export type NextAction = {
  /**
   * `REATTEMPT` — another visit is owed and has been scheduled.
   * `RTO` — the attempt allowance is spent; return to origin is *proposed*
   *   and still needs `delivery.rto` and a human.
   * `HOLD` — the reason needs an ops decision before anyone drives out
   *   again (a wrong address, a refusal, damage).
   */
  action: "REATTEMPT" | "RTO" | "HOLD";
  /** Present only for `REATTEMPT`. */
  scheduledFor?: Date;
  notifyConsignor: boolean;
  notifyConsignee: boolean;
  chargeable: boolean;
};

/**
 * Decides what a failed attempt leads to.
 *
 * The order matters and is deliberate:
 *
 *  1. The attempt allowance is checked first. Once it is spent, nothing
 *     earns another automatic visit whatever the reason says — RTO is
 *     proposed and a human decides.
 *  2. A reason that does not trigger a reattempt holds. "Wrong address"
 *     and "consignee refused" are not solved by driving back to the same
 *     door; they need support or an approval first.
 *  3. Otherwise the shipment is owed another visit on the next working day.
 */
export function nextAction(
  shipment: AttemptShipmentFacts,
  reasonCode: AttemptReasonPolicy,
  serviceType: AttemptServiceFacts,
  options: NextActionOptions = {},
): NextAction {
  const outcome = {
    notifyConsignor: reasonCode.notifiesConsignor,
    notifyConsignee: reasonCode.notifiesConsignee,
    chargeable: reasonCode.isChargeable,
  };

  if (shipment.attemptCount >= serviceType.maxDeliveryAttempts) {
    return { action: "RTO", ...outcome };
  }

  if (!reasonCode.triggersReattempt) {
    return { action: "HOLD", ...outcome };
  }

  return {
    action: "REATTEMPT",
    scheduledFor: nextWorkingDay(options.now ?? new Date(), {
      weeklyOffDays: options.weeklyOffDays,
      holidays: options.holidays,
      hour: options.reattemptHour,
    }),
    ...outcome,
  };
}

/** How many visits the contract still allows after the attempts recorded. */
export function attemptsRemaining(
  shipment: AttemptShipmentFacts,
  serviceType: AttemptServiceFacts,
): number {
  return Math.max(0, serviceType.maxDeliveryAttempts - shipment.attemptCount);
}

/** True when this failed attempt exhausts the contracted allowance. */
export function isFinalAttempt(
  shipment: AttemptShipmentFacts,
  serviceType: AttemptServiceFacts,
): boolean {
  return shipment.attemptCount >= serviceType.maxDeliveryAttempts;
}

export type AttemptCapture = {
  photoAssetId?: string | null;
  remarks?: string | null;
};

/**
 * Whether the agent has supplied everything the reason demands.
 *
 * Returns the message to show, or null when the capture is complete. Run
 * this on the device before queueing, so an agent standing at a door with
 * no signal is told immediately rather than at sync time — and again on
 * the server, because the client cannot be trusted.
 */
export function validateAttemptCapture(
  reasonCode: AttemptReasonPolicy,
  capture: AttemptCapture,
): string | null {
  if (reasonCode.requiresPhoto && !capture.photoAssetId) {
    return "This reason needs a photo before it can be submitted.";
  }
  if (reasonCode.requiresRemarks && !capture.remarks?.trim()) {
    return "This reason needs a note explaining what happened.";
  }
  return null;
}

export type WorkingDayOptions = {
  weeklyOffDays?: number[];
  holidays?: Array<Date | string>;
  hour?: number;
};

/**
 * The next day the branch will actually deliver on.
 *
 * A reattempt promised for a Sunday is a promise the network cannot keep,
 * and the consignee is the one who waits in for it.
 */
export function nextWorkingDay(
  from: Date,
  options: WorkingDayOptions = {},
): Date {
  const offs = new Set(options.weeklyOffDays ?? []);
  const holidays = new Set(
    (options.holidays ?? []).map((day) =>
      typeof day === "string" ? day.slice(0, 10) : dayKey(day),
    ),
  );

  const candidate = new Date(from);
  candidate.setHours(options.hour ?? 9, 0, 0, 0);

  // A fortnight is far more closure than any branch has. Bailing out beats
  // spinning forever on a weeklyOffDays of [0,1,2,3,4,5,6].
  for (let step = 0; step < 14; step += 1) {
    candidate.setDate(candidate.getDate() + 1);
    if (offs.has(candidate.getDay())) continue;
    if (holidays.has(dayKey(candidate))) continue;
    return candidate;
  }

  return candidate;
}

/** Local `yyyy-mm-dd`. Deliberately not UTC — branch calendars are local. */
function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
