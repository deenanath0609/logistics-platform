import type { ExceptionKind } from "@/generated/prisma/client";

/**
 * The SLA policies and escalation ladders an install starts with.
 *
 * Plain data, no writes — the seed reads these and resolves the codes to
 * ids. Keeping it declarative means the same rows can be re-applied after
 * somebody has edited them without a script deciding what "re-apply"
 * ought to mean.
 *
 * Everything below is keyed by **code**, not id: `ServiceType.code`,
 * `City.code`, `Zone.code` and `Role.code` are all stable and unique in
 * this schema, and a seed written against cuids would only work on the
 * database it was written on.
 *
 * The transit numbers are the seeded routes' own (`RT-DEL-JAI` 24 h,
 * `RT-DEL-AMD` 48 h, `RT-FBD-DEL` 6 h) widened for handling at each end,
 * with the service type's `defaultTransitHours` as the network fallback.
 * They are a starting point an operations manager is expected to argue
 * with — which is the entire reason the admin screen exists.
 */

export type SlaPolicySeed = {
  code: string;
  name: string;
  /** `ServiceType.code`, or null for "any service". */
  serviceTypeCode: string | null;
  /** `City.code`. Beats a zone on the same side. */
  originCityCode: string | null;
  destinationCityCode: string | null;
  /** `Zone.code`. Used when no city is given for that side. */
  originZoneCode: string | null;
  destinationZoneCode: string | null;
  transitHours: number;
  useWorkingHours: boolean;
  respectCutoff: boolean;
  atRiskPercent: number;
  priority: number;
  isActive: boolean;
};

/** Shared shape for the majority of rows, so each entry states only what differs. */
function policy(
  seed: Pick<SlaPolicySeed, "code" | "name" | "transitHours"> &
    Partial<SlaPolicySeed>,
): SlaPolicySeed {
  return {
    serviceTypeCode: null,
    originCityCode: null,
    destinationCityCode: null,
    originZoneCode: null,
    destinationZoneCode: null,
    useWorkingHours: true,
    respectCutoff: true,
    atRiskPercent: 80,
    priority: 0,
    isActive: true,
    ...seed,
  };
}

/**
 * Twelve policies over three tiers, exactly as §A.11 describes resolution:
 * a service-type floor, zone pairs over it, and named city lanes over
 * those. The resolver picks the most specific; `priority` is left at zero
 * throughout so specificity alone decides, and an operations manager has
 * the whole priority range free for a festival-season override.
 */
export const DEFAULT_SLA_POLICIES: readonly SlaPolicySeed[] = [
  // ── Tier 1: the network floor, one per service type ───────
  //
  // Without these a lane nobody has written a policy for is
  // NOT_APPLICABLE, and "no data" on the on-time report is indistinguishable
  // from a broken scanner. These make every booked shipment measurable.
  policy({
    code: "SLA-FTL-STD",
    name: "FTL standard — anywhere",
    serviceTypeCode: "FTL-STD",
    transitHours: 48,
    // A dedicated truck runs through the night and does not wait for a
    // branch to open. Measuring it on working hours would promise the
    // customer four days for a two-day run.
    useWorkingHours: false,
    respectCutoff: false,
  }),
  policy({
    code: "SLA-PTL-EXP",
    name: "PTL express — anywhere",
    serviceTypeCode: "PTL-EXP",
    transitHours: 24,
  }),
  policy({
    code: "SLA-PTL-STD",
    name: "PTL standard — anywhere",
    serviceTypeCode: "PTL-STD",
    transitHours: 72,
  }),
  policy({
    code: "SLA-CRR-EXP",
    name: "Courier express — anywhere",
    serviceTypeCode: "CRR-EXP",
    transitHours: 48,
  }),

  // ── Tier 2: zone pairs ────────────────────────────────────
  policy({
    code: "SLA-NCR-NCR-EXP",
    name: "Within NCR — express",
    serviceTypeCode: "PTL-EXP",
    originZoneCode: "Z-NCR",
    destinationZoneCode: "Z-NCR",
    transitHours: 12,
  }),
  policy({
    code: "SLA-NCR-NCR-STD",
    name: "Within NCR — standard",
    serviceTypeCode: "PTL-STD",
    originZoneCode: "Z-NCR",
    destinationZoneCode: "Z-NCR",
    transitHours: 24,
  }),
  policy({
    code: "SLA-NCR-NORTH-EXP",
    name: "NCR → North India — express",
    serviceTypeCode: "PTL-EXP",
    originZoneCode: "Z-NCR",
    destinationZoneCode: "Z-NORTH",
    transitHours: 24,
  }),
  policy({
    code: "SLA-NCR-NORTH-STD",
    name: "NCR → North India — standard",
    serviceTypeCode: "PTL-STD",
    originZoneCode: "Z-NCR",
    destinationZoneCode: "Z-NORTH",
    transitHours: 48,
  }),
  policy({
    code: "SLA-NCR-WEST-EXP",
    name: "NCR → West India — express",
    serviceTypeCode: "PTL-EXP",
    originZoneCode: "Z-NCR",
    destinationZoneCode: "Z-WEST",
    transitHours: 48,
  }),
  policy({
    code: "SLA-NCR-WEST-STD",
    name: "NCR → West India — standard",
    serviceTypeCode: "PTL-STD",
    originZoneCode: "Z-NCR",
    destinationZoneCode: "Z-WEST",
    transitHours: 96,
  }),
  policy({
    code: "SLA-CRR-NCR",
    name: "Courier within NCR",
    serviceTypeCode: "CRR-EXP",
    originZoneCode: "Z-NCR",
    destinationZoneCode: "Z-NCR",
    transitHours: 24,
  }),

  // ── Tier 3: the named lanes ───────────────────────────────
  //
  // RT-DEL-JAI runs 24 h door to door; the express promise matches the
  // route and the standard promise allows a consolidation cycle on top.
  policy({
    code: "SLA-DEL-JAI-EXP",
    name: "Delhi → Jaipur express",
    serviceTypeCode: "PTL-EXP",
    originCityCode: "DEL",
    destinationCityCode: "JAI",
    transitHours: 24,
  }),
  policy({
    code: "SLA-JAI-DEL-EXP",
    name: "Jaipur → Delhi express",
    serviceTypeCode: "PTL-EXP",
    originCityCode: "JAI",
    destinationCityCode: "DEL",
    transitHours: 24,
  }),
  policy({
    code: "SLA-DEL-JAI-STD",
    name: "Delhi → Jaipur standard",
    serviceTypeCode: "PTL-STD",
    originCityCode: "DEL",
    destinationCityCode: "JAI",
    transitHours: 48,
  }),
  policy({
    code: "SLA-DEL-AMD-EXP",
    name: "Delhi → Ahmedabad express",
    serviceTypeCode: "PTL-EXP",
    originCityCode: "DEL",
    destinationCityCode: "AMD",
    transitHours: 48,
  }),
  policy({
    code: "SLA-AMD-DEL-EXP",
    name: "Ahmedabad → Delhi express",
    serviceTypeCode: "PTL-EXP",
    originCityCode: "AMD",
    destinationCityCode: "DEL",
    transitHours: 48,
  }),
  policy({
    code: "SLA-DEL-AMD-STD",
    name: "Delhi → Ahmedabad standard",
    serviceTypeCode: "PTL-STD",
    originCityCode: "DEL",
    destinationCityCode: "AMD",
    transitHours: 72,
  }),
  // Faridabad → Delhi is a 35 km feeder run. Eight working hours is one
  // shift: booked before the cut-off, it is at the Delhi hub the same day.
  policy({
    code: "SLA-FBD-DEL-EXP",
    name: "Faridabad → Delhi express",
    serviceTypeCode: "PTL-EXP",
    originCityCode: "FBD",
    destinationCityCode: "DEL",
    transitHours: 8,
  }),
  policy({
    code: "SLA-FBD-DEL-STD",
    name: "Faridabad → Delhi standard",
    serviceTypeCode: "PTL-STD",
    originCityCode: "FBD",
    destinationCityCode: "DEL",
    transitHours: 16,
  }),

  // FTL on the named trunk lanes: the truck is dedicated, so the promise
  // is the route's own running time and the clock never stops.
  policy({
    code: "SLA-FTL-DEL-JAI",
    name: "Delhi → Jaipur full truck",
    serviceTypeCode: "FTL-STD",
    originCityCode: "DEL",
    destinationCityCode: "JAI",
    transitHours: 24,
    useWorkingHours: false,
    respectCutoff: false,
  }),
  policy({
    code: "SLA-FTL-DEL-AMD",
    name: "Delhi → Ahmedabad full truck",
    serviceTypeCode: "FTL-STD",
    originCityCode: "DEL",
    destinationCityCode: "AMD",
    transitHours: 48,
    useWorkingHours: false,
    respectCutoff: false,
  }),
];

// ────────────────────────────────────────────────────────────
// Escalation ladders
// ────────────────────────────────────────────────────────────

export type EscalationRuleSeed = {
  kind: ExceptionKind;
  /** 1 is the first person told. Levels fire in order. */
  level: number;
  /**
   * Minutes since **detection**, not since the previous level — §A.11
   * states total tolerance ("2 h → regional"), and a ladder of relative
   * delays would not mean what anyone reading the rule expects.
   */
  afterMinutes: number;
  /** `Role.code`. */
  notifyRoleCode: string;
  isActive: boolean;
};

function rung(
  kind: ExceptionKind,
  level: number,
  afterMinutes: number,
  notifyRoleCode: string,
): EscalationRuleSeed {
  return { kind, level, afterMinutes, notifyRoleCode, isActive: true };
}

const HOUR = 60;
const DAY = 24 * HOUR;

/**
 * The §A.11 escalation windows, as two rungs per kind.
 *
 * Two, not one: a single rung means an exception nobody acts on sits at
 * the top of its ladder forever, visible only to whoever was told first.
 * The second rung is what gets it in front of somebody with the authority
 * to move freight.
 */
export const DEFAULT_ESCALATION_RULES: readonly EscalationRuleSeed[] = [
  // "Immediate visibility" — the point of at-risk is that somebody looks
  // while there is still time to save the promise.
  rung("SLA_AT_RISK", 1, 15, "BRANCH_MANAGER"),
  rung("SLA_AT_RISK", 2, HOUR, "OPS_MANAGER"),

  // "2 h → regional".
  rung("SLA_BREACHED", 1, 2 * HOUR, "OPS_MANAGER"),
  rung("SLA_BREACHED", 2, 6 * HOUR, "MANAGEMENT"),

  rung("NO_GPS_UPDATE", 1, HOUR, "TRANSPORT_DESK"),
  rung("NO_GPS_UPDATE", 2, 3 * HOUR, "OPS_MANAGER"),

  rung("VEHICLE_STOPPED", 1, 2 * HOUR, "TRANSPORT_DESK"),
  rung("VEHICLE_STOPPED", 2, 4 * HOUR, "OPS_MANAGER"),

  rung("ROUTE_DEVIATION", 1, 30, "TRANSPORT_DESK"),
  rung("ROUTE_DEVIATION", 2, 90, "OPS_MANAGER"),

  // "After attempt 2" is a count, not a clock; four hours is the nearest
  // honest time-based stand-in and the attempt count is on the row.
  rung("DELIVERY_FAILED", 1, 4 * HOUR, "BRANCH_MANAGER"),
  rung("DELIVERY_FAILED", 2, 12 * HOUR, "OPS_MANAGER"),

  rung("SHORT_RECEIVED", 1, DAY, "BRANCH_MANAGER"),
  rung("SHORT_RECEIVED", 2, 2 * DAY, "OPS_MANAGER"),

  rung("EXCESS_RECEIVED", 1, DAY, "BRANCH_MANAGER"),
  rung("EXCESS_RECEIVED", 2, 2 * DAY, "OPS_MANAGER"),

  rung("DAMAGED", 1, DAY, "CUSTOMER_SUPPORT"),
  rung("DAMAGED", 2, 2 * DAY, "OPS_MANAGER"),

  // "Pending POD > 24 h … escalates after 48 h": the exception opens at
  // 24 h, so its first rung fires 24 h later.
  rung("POD_PENDING", 1, 2 * DAY, "BRANCH_MANAGER"),
  rung("POD_PENDING", 2, 4 * DAY, "OPS_MANAGER"),

  // "Configurable" — the dwell threshold itself lives in SystemConfig;
  // this is how long the resulting exception may sit untouched.
  rung("HUB_DWELL", 1, 12 * HOUR, "BRANCH_MANAGER"),
  rung("HUB_DWELL", 2, DAY, "OPS_MANAGER"),

  // "Same day". Cash discrepancies go cold within a day.
  rung("COD_SHORTFALL", 1, 8 * HOUR, "ACCOUNTS"),
  rung("COD_SHORTFALL", 2, DAY, "OPS_MANAGER"),

  rung("CUSTOMER_COMPLAINT", 1, 4 * HOUR, "CUSTOMER_SUPPORT"),
  rung("CUSTOMER_COMPLAINT", 2, DAY, "OPS_MANAGER"),

  rung("DOCUMENT_EXPIRED", 1, DAY, "TRANSPORT_DESK"),
  rung("DOCUMENT_EXPIRED", 2, 3 * DAY, "OPS_MANAGER"),

  rung("OTHER", 1, 12 * HOUR, "BRANCH_MANAGER"),
  rung("OTHER", 2, DAY, "OPS_MANAGER"),
];

/**
 * Detector thresholds an install starts with, as `SystemConfig` rows.
 *
 * The dwell figure is deliberately a bare number: per-branch overrides
 * are a real need, but every install that never has one should be able to
 * read its own setting at a glance.
 */
export const DEFAULT_SLA_SYSTEM_CONFIG: ReadonlyArray<{
  key: string;
  value: number;
  description: string;
  category: string;
}> = [
  {
    key: "sla.hubDwellHours",
    value: 24,
    description:
      "Hours a consignment may sit at a branch with no outbound scan before an exception is raised. Accepts a number, or {\"defaultHours\":24,\"byBranchCode\":{\"HUB-DEL\":6}} for per-branch thresholds.",
    category: "sla",
  },
  {
    key: "sla.podPendingHours",
    value: 24,
    description: "Hours after delivery before a missing POD is an exception.",
    category: "sla",
  },
  {
    key: "sla.codShortfallTolerance",
    value: 0,
    description:
      "Rupees an agent may be short at day end before an exception is raised. Zero by default — cash either adds up or it does not.",
    category: "sla",
  },
  {
    key: "sla.codDayEndHour",
    value: 22,
    description:
      "Branch-local hour after which the day's COD is expected to be deposited.",
    category: "sla",
  },
];
