import { prisma } from "@/lib/prisma";
import { STATUS_GROUPS } from "@/lib/shipment/state-machine";
import type { Prisma, ShipmentStatus } from "@/generated/prisma/client";
import {
  ageMinutes,
  dateTimeCell,
  humanise,
  minutesBetween,
  moneyCell,
  percentCell,
  sumDecimal,
  weightCell,
} from "./format";
import { shipmentWhere, singleBranchWhere } from "./scope";
import type { ReportContext, ReportResult, ReportRow } from "./types";

/**
 * Customer and people reports — docs/BRD.html §A.17.
 *
 * These are the ones that get read in a review meeting, which changes
 * what they owe the reader. A scorecard that quietly counts a shipment
 * with no SLA policy as "on time" will be believed, acted on, and
 * eventually found out; so every rate here reports its own denominator
 * alongside it, and an empty denominator reads as a dash rather than as
 * a hundred per cent.
 */

const DELIVERED: ShipmentStatus[] = [...STATUS_GROUPS.done];

// ────────────────────────────────────────────────────────────
// Customer-wise shipments
// ────────────────────────────────────────────────────────────

export async function customerShipments(
  ctx: ReportContext,
): Promise<ReportResult> {
  const where = shipmentWhere(ctx.user, ctx.filters, "bookedAt") as Prisma.ShipmentWhereInput;

  // Grouped in the database. Pulling every shipment back to count them in
  // JavaScript is the version of this report that falls over in month
  // three, and it falls over on the busiest customer.
  const grouped = await prisma.shipment.groupBy({
    by: ["consignorId"],
    where,
    _count: { _all: true },
    _sum: { chargeableWeight: true, grandTotal: true, packageCount: true },
    orderBy: { _count: { consignorId: "desc" } },
    skip: (ctx.page - 1) * ctx.pageSize,
    take: ctx.pageSize,
  });

  const distinct = await prisma.shipment.groupBy({
    by: ["consignorId"],
    where,
    _count: { _all: true },
  });

  const customers = await loadCustomerNames(
    grouped.map((row) => row.consignorId),
  );

  const rows: ReportRow[] = grouped.map((row) => ({
    key: row.consignorId ?? "walk-in",
    href: row.consignorId ? `/customers/${row.consignorId}` : undefined,
    cells: {
      customer: row.consignorId
        ? (customers.get(row.consignorId) ?? "Unknown account")
        : "Walk-in / cash",
      shipments: row._count._all,
      packages: row._sum.packageCount ?? 0,
      weight: weightCell(row._sum.chargeableWeight),
      value: moneyCell(row._sum.grandTotal),
    },
  }));

  return {
    columns: [
      { key: "customer", label: "Customer" },
      { key: "shipments", label: "Shipments", type: "number" },
      { key: "packages", label: "Packages", type: "number" },
      { key: "weight", label: "Chargeable kg", type: "weight" },
      { key: "value", label: "Booked value", type: "money" },
    ],
    rows,
    total: distinct.length,
    note: "Booked value is what the consignment note carried at booking, not what was invoiced.",
  };
}

async function loadCustomerNames(
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();

  const rows = await prisma.customer.findMany({
    where: { id: { in: wanted } },
    select: { id: true, name: true, code: true },
  });

  return new Map(rows.map((row) => [row.id, `${row.name} (${row.code})`]));
}

// ────────────────────────────────────────────────────────────
// Customer-wise on-time %
// ────────────────────────────────────────────────────────────

/**
 * On-time performance per customer.
 *
 * Counted from `ShipmentSla.state`, which is the same field the tower and
 * the dashboard read — so a customer querying their figure and an
 * operations manager defending it are looking at one number, not two
 * derivations of it.
 */
export async function customerOnTime(
  ctx: ReportContext,
): Promise<ReportResult> {
  const base = shipmentWhere(ctx.user, ctx.filters, "bookedAt") as Prisma.ShipmentWhereInput;

  const grouped = await prisma.shipment.groupBy({
    by: ["consignorId"],
    where: base,
    _count: { _all: true },
    orderBy: { _count: { consignorId: "desc" } },
    skip: (ctx.page - 1) * ctx.pageSize,
    take: ctx.pageSize,
  });

  const ids = grouped.map((row) => row.consignorId);
  const customers = await loadCustomerNames(ids);

  const rows: ReportRow[] = [];

  for (const group of grouped) {
    const scoped: Prisma.ShipmentWhereInput = {
      AND: [base, { consignorId: group.consignorId }],
    };

    const [met, breached, notApplicable, delivered, firstTime] = await Promise.all([
      prisma.shipment.count({ where: { AND: [scoped, { sla: { state: "MET" } }] } }),
      prisma.shipment.count({
        where: { AND: [scoped, { sla: { state: "BREACHED" } }] },
      }),
      prisma.shipment.count({
        where: { AND: [scoped, { sla: { state: "NOT_APPLICABLE" } }] },
      }),
      prisma.shipment.count({
        where: { AND: [scoped, { currentStatus: { in: DELIVERED } }] },
      }),
      prisma.shipment.count({
        where: {
          AND: [scoped, { currentStatus: { in: DELIVERED } }, { attemptCount: 0 }],
        },
      }),
    ]);

    const measured = met + breached;

    rows.push({
      key: group.consignorId ?? "walk-in",
      href: group.consignorId ? `/customers/${group.consignorId}` : undefined,
      cells: {
        customer: group.consignorId
          ? (customers.get(group.consignorId) ?? "Unknown account")
          : "Walk-in / cash",
        shipments: group._count._all,
        delivered,
        measured,
        onTime: percentCell(met, measured),
        breached,
        firstAttempt: percentCell(firstTime, delivered),
        unmeasured: notApplicable,
      },
      tones: {
        onTime: toneForPercent(percentCell(met, measured), 95, 90),
      },
    });
  }

  const distinct = await prisma.shipment.groupBy({
    by: ["consignorId"],
    where: base,
    _count: { _all: true },
  });

  return {
    columns: [
      { key: "customer", label: "Customer" },
      { key: "shipments", label: "Shipments", type: "number" },
      { key: "delivered", label: "Delivered", type: "number" },
      { key: "measured", label: "With an SLA", type: "number" },
      { key: "onTime", label: "On time", type: "percent" },
      { key: "breached", label: "Breached", type: "number" },
      { key: "firstAttempt", label: "First attempt", type: "percent" },
      { key: "unmeasured", label: "No SLA policy", type: "number" },
    ],
    rows,
    total: distinct.length,
    note: "On time counts only shipments a policy covered. The last column is how many were not covered at all — a lane with no policy is a gap to close, not a pass mark.",
  };
}

function toneForPercent(
  value: number | null,
  good: number,
  watch: number,
): "ok" | "warn" | "bad" | "muted" {
  if (value === null) return "muted";
  if (value >= good) return "ok";
  return value >= watch ? "warn" : "bad";
}

// ────────────────────────────────────────────────────────────
// Complaint register & ageing
// ────────────────────────────────────────────────────────────

export async function complaintRegister(
  ctx: ReportContext,
): Promise<ReportResult> {
  const scope =
    ctx.user.branchIds === null ? {} : { branchId: { in: ctx.user.branchIds } };

  const where: Prisma.ComplaintWhereInput = {
    AND: [
      { createdAt: { gte: ctx.filters.from, lte: ctx.filters.to } },
      scope,
      ctx.filters.branchId ? { branchId: ctx.filters.branchId } : {},
      ctx.filters.customerId ? { customerId: ctx.filters.customerId } : {},
      ctx.filters.q
        ? {
            OR: [
              { number: { contains: ctx.filters.q, mode: "insensitive" } },
              { subject: { contains: ctx.filters.q, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };

  const now = new Date();

  const [rows, total] = await Promise.all([
    prisma.complaint.findMany({
      where,
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        number: true,
        category: true,
        priority: true,
        status: true,
        subject: true,
        createdAt: true,
        respondBy: true,
        resolveBy: true,
        firstResponseAt: true,
        resolvedAt: true,
        closedAt: true,
        resolution: true,
        branch: { select: { code: true } },
        customer: { select: { name: true } },
        assignedTo: { select: { name: true } },
        shipment: { select: { lrNumber: true } },
      },
    }),
    prisma.complaint.count({ where }),
  ]);

  return {
    columns: [
      { key: "number", label: "Complaint", type: "code" },
      { key: "category", label: "Category" },
      { key: "priority", label: "Priority", type: "state" },
      { key: "subject", label: "Subject" },
      { key: "customer", label: "Customer" },
      { key: "lr", label: "LR", type: "code" },
      { key: "branch", label: "Branch" },
      { key: "owner", label: "Owner" },
      { key: "raised", label: "Raised", type: "datetime" },
      { key: "age", label: "Age", type: "duration" },
      { key: "response", label: "First response", type: "duration" },
      { key: "resolution", label: "Time to resolve", type: "duration" },
      { key: "slaState", label: "Against SLA", type: "state" },
      { key: "status", label: "Status", type: "state" },
    ],
    rows: rows.map((row) => {
      const responseMinutes = minutesBetween(row.createdAt, row.firstResponseAt);
      const resolveMinutes = minutesBetween(row.createdAt, row.resolvedAt);

      const responseLate =
        row.respondBy !== null &&
        (row.firstResponseAt ?? now).getTime() > row.respondBy.getTime();
      const resolveLate =
        row.resolveBy !== null &&
        (row.resolvedAt ?? now).getTime() > row.resolveBy.getTime();

      const slaState = !row.respondBy
        ? "Untracked"
        : responseLate || resolveLate
          ? "Breached"
          : row.resolvedAt
            ? "Met"
            : "Running";

      return {
        key: row.id,
        href: `/complaints/${row.id}`,
        cells: {
          number: row.number,
          category: humanise(row.category),
          priority: humanise(row.priority),
          subject: row.subject,
          customer: row.customer?.name ?? null,
          lr: row.shipment?.lrNumber ?? null,
          branch: row.branch?.code ?? null,
          owner: row.assignedTo?.name ?? "Unassigned",
          raised: dateTimeCell(row.createdAt),
          age: ageMinutes(row.createdAt, row.resolvedAt ?? now),
          response: responseMinutes,
          resolution: resolveMinutes,
          slaState,
          status: humanise(row.status),
        },
        tones: {
          slaState:
            slaState === "Breached"
              ? "bad"
              : slaState === "Met"
                ? "ok"
                : slaState === "Running"
                  ? "info"
                  : "muted",
          priority:
            row.priority === "CRITICAL"
              ? "bad"
              : row.priority === "HIGH"
                ? "warn"
                : "muted",
        },
      };
    }),
    total,
    note: "Two clocks: how long the customer waited to hear from a person, and how long they waited for an answer.",
  };
}

// ────────────────────────────────────────────────────────────
// Branch scorecard
// ────────────────────────────────────────────────────────────

export async function branchScorecard(
  ctx: ReportContext,
): Promise<ReportResult> {
  const visible =
    ctx.user.branchIds === null
      ? ctx.filters.branchId
        ? { id: ctx.filters.branchId }
        : {}
      : {
          id: {
            in: ctx.filters.branchId
              ? ctx.user.branchIds.filter((id) => id === ctx.filters.branchId)
              : ctx.user.branchIds,
          },
        };

  const branchWhere: Prisma.BranchWhereInput = {
    ...visible,
    isActive: true,
    deletedAt: null,
  };

  const [branches, total] = await Promise.all([
    prisma.branch.findMany({
      where: branchWhere,
      orderBy: { code: "asc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: { id: true, code: true, name: true, type: true },
    }),
    prisma.branch.count({ where: branchWhere }),
  ]);

  const range = { gte: ctx.filters.from, lte: ctx.filters.to };

  const rows: ReportRow[] = [];

  for (const branch of branches) {
    const originated: Prisma.ShipmentWhereInput = {
      deletedAt: null,
      originBranchId: branch.id,
      bookedAt: range,
    };
    const inbound: Prisma.ShipmentWhereInput = {
      deletedAt: null,
      destinationBranchId: branch.id,
      statusUpdatedAt: range,
    };

    const [booked, delivered, firstTime, met, breached, exceptions, complaints] =
      await Promise.all([
        prisma.shipment.count({ where: originated }),
        prisma.shipment.count({
          where: { AND: [inbound, { currentStatus: { in: DELIVERED } }] },
        }),
        prisma.shipment.count({
          where: {
            AND: [inbound, { currentStatus: { in: DELIVERED } }, { attemptCount: 0 }],
          },
        }),
        prisma.shipment.count({
          where: { AND: [inbound, { sla: { state: "MET" } }] },
        }),
        prisma.shipment.count({
          where: { AND: [inbound, { sla: { state: "BREACHED" } }] },
        }),
        prisma.exception.count({
          where: { ownerBranchId: branch.id, detectedAt: range },
        }),
        prisma.complaint.count({ where: { branchId: branch.id, createdAt: range } }),
      ]);

    const measured = met + breached;
    const onTime = percentCell(met, measured);

    rows.push({
      key: branch.id,
      cells: {
        branch: `${branch.code} — ${branch.name}`,
        type: humanise(branch.type),
        booked,
        delivered,
        onTime,
        firstAttempt: percentCell(firstTime, delivered),
        breached,
        exceptions,
        complaints,
      },
      tones: { onTime: toneForPercent(onTime, 95, 90) },
    });
  }

  return {
    columns: [
      { key: "branch", label: "Branch" },
      { key: "type", label: "Type" },
      { key: "booked", label: "Booked", type: "number" },
      { key: "delivered", label: "Delivered", type: "number" },
      { key: "onTime", label: "On time", type: "percent" },
      { key: "firstAttempt", label: "First attempt", type: "percent" },
      { key: "breached", label: "SLA breaches", type: "number" },
      { key: "exceptions", label: "Exceptions", type: "number" },
      { key: "complaints", label: "Complaints", type: "number" },
    ],
    rows,
    total,
    note: "Booked counts what the branch originated. Delivered, on-time and first-attempt count what it received — a branch is not accountable for the other end of the lane.",
  };
}

// ────────────────────────────────────────────────────────────
// Driver scorecard
// ────────────────────────────────────────────────────────────

export async function driverScorecard(
  ctx: ReportContext,
): Promise<ReportResult> {
  const branchIds = ctx.user.branchIds;
  const branchFilter = ctx.filters.branchId
    ? [ctx.filters.branchId].filter((id) => branchIds === null || branchIds.includes(id))
    : branchIds;

  const where: Prisma.DriverWhereInput = {
    deletedAt: null,
    isActive: true,
    ...(branchFilter ? { branchId: { in: branchFilter } } : {}),
  };

  const [drivers, total] = await Promise.all([
    prisma.driver.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        branch: { select: { code: true } },
        trips: {
          where: { createdAt: { gte: ctx.filters.from, lte: ctx.filters.to } },
          select: {
            id: true,
            status: true,
            distanceKm: true,
            plannedArrivalAt: true,
            actualArrivalAt: true,
            actualDepartureAt: true,
            plannedDepartureAt: true,
          },
        },
      },
    }),
    prisma.driver.count({ where }),
  ]);

  const rows: ReportRow[] = drivers.map((driver) => {
    const trips = driver.trips;
    const completed = trips.filter((t) => t.status === "COMPLETED");

    const arrivalsJudged = completed.filter(
      (t) => t.actualArrivalAt && t.plannedArrivalAt,
    );
    const onTimeArrivals = arrivalsJudged.filter(
      (t) => t.actualArrivalAt!.getTime() <= t.plannedArrivalAt!.getTime(),
    );

    const delays = arrivalsJudged
      .map((t) => minutesBetween(t.plannedArrivalAt, t.actualArrivalAt) ?? 0)
      .filter((minutes) => minutes > 0);

    return {
      key: driver.id,
      href: `/fleet/drivers/${driver.id}`,
      cells: {
        driver: `${driver.name} (${driver.code})`,
        branch: driver.branch?.code ?? null,
        status: humanise(driver.status),
        trips: trips.length,
        completed: completed.length,
        distance: sumDecimal(trips.map((t) => t.distanceKm))
          .toDecimalPlaces(1)
          .toNumber(),
        judged: arrivalsJudged.length,
        onTime: percentCell(onTimeArrivals.length, arrivalsJudged.length),
        averageDelay:
          delays.length > 0
            ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
            : null,
      },
      tones: {
        onTime: toneForPercent(
          percentCell(onTimeArrivals.length, arrivalsJudged.length),
          90,
          75,
        ),
      },
    };
  });

  return {
    columns: [
      { key: "driver", label: "Driver" },
      { key: "branch", label: "Branch" },
      { key: "status", label: "Status" },
      { key: "trips", label: "Trips", type: "number" },
      { key: "completed", label: "Completed", type: "number" },
      { key: "distance", label: "Km", type: "number" },
      { key: "judged", label: "Trips with a plan", type: "number" },
      { key: "onTime", label: "On-time arrival", type: "percent" },
      { key: "averageDelay", label: "Average delay", type: "duration" },
    ],
    rows,
    total,
    note: "On-time arrival is judged only against trips that carried a planned arrival. A trip nobody planned cannot be late.",
  };
}

// ────────────────────────────────────────────────────────────
// Delivery agent scorecard
// ────────────────────────────────────────────────────────────

export async function agentScorecard(
  ctx: ReportContext,
): Promise<ReportResult> {
  const runWhere = singleBranchWhere(
    ctx.user,
    ctx.filters,
    "createdAt",
  ) as Prisma.DeliveryRunWhereInput;

  const grouped = await prisma.deliveryRun.groupBy({
    by: ["agentId"],
    where: runWhere,
    _count: { _all: true },
    _sum: {
      totalTasks: true,
      completedTasks: true,
      failedTasks: true,
      codExpected: true,
      codCollected: true,
    },
    orderBy: { _count: { agentId: "desc" } },
    skip: (ctx.page - 1) * ctx.pageSize,
    take: ctx.pageSize,
  });

  const distinct = await prisma.deliveryRun.groupBy({
    by: ["agentId"],
    where: runWhere,
    _count: { _all: true },
  });

  const agents = await prisma.user.findMany({
    where: { id: { in: grouped.map((row) => row.agentId) } },
    select: { id: true, name: true, primaryBranch: { select: { code: true } } },
  });
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));

  const rows: ReportRow[] = [];

  for (const group of grouped) {
    // First-attempt success is a property of the consignment, not of the
    // run, so it has to come from the shipments the agent actually
    // delivered rather than from the run counters.
    const [delivered, firstTime] = await Promise.all([
      prisma.deliveryTask.count({
        where: {
          run: { ...runWhere, agentId: group.agentId },
          status: "DELIVERED",
          shipment: { deletedAt: null },
        },
      }),
      prisma.deliveryTask.count({
        where: {
          run: { ...runWhere, agentId: group.agentId },
          status: "DELIVERED",
          shipment: { deletedAt: null, attemptCount: 0 },
        },
      }),
    ]);

    const agent = agentById.get(group.agentId);
    const tasks = group._sum.totalTasks ?? 0;
    const failed = group._sum.failedTasks ?? 0;

    rows.push({
      key: group.agentId,
      cells: {
        agent: agent?.name ?? "Unknown",
        branch: agent?.primaryBranch?.code ?? null,
        runs: group._count._all,
        tasks,
        delivered,
        failed,
        success: percentCell(group._sum.completedTasks ?? 0, tasks),
        firstAttempt: percentCell(firstTime, delivered),
        codExpected: moneyCell(group._sum.codExpected),
        codCollected: moneyCell(group._sum.codCollected),
      },
      tones: {
        firstAttempt: toneForPercent(percentCell(firstTime, delivered), 90, 80),
      },
    });
  }

  return {
    columns: [
      { key: "agent", label: "Agent" },
      { key: "branch", label: "Branch" },
      { key: "runs", label: "Runs", type: "number" },
      { key: "tasks", label: "Tasks", type: "number" },
      { key: "delivered", label: "Delivered", type: "number" },
      { key: "failed", label: "Failed", type: "number" },
      { key: "success", label: "Completion", type: "percent" },
      { key: "firstAttempt", label: "First attempt", type: "percent" },
      { key: "codExpected", label: "COD expected", type: "money" },
      { key: "codCollected", label: "COD collected", type: "money" },
    ],
    rows,
    total: distinct.length,
  };
}
