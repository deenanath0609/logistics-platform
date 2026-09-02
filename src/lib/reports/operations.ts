import { prisma } from "@/lib/prisma";
import { STATUS_GROUPS, STATUS_LABELS } from "@/lib/shipment/state-machine";
import { SLA_STATE_LABEL } from "@/lib/sla/policy";
import { kindLabel, STATUS_LABEL as EXCEPTION_STATUS_LABEL } from "@/lib/exceptions/kinds";
import type { Prisma, ShipmentStatus } from "@/generated/prisma/client";
import {
  ageMinutes,
  dateCell,
  dateTimeCell,
  humanise,
  minutesBetween,
  moneyCell,
  sumDecimal,
  weightCell,
} from "./format";
import {
  firstDepartureAfter,
  HUB_ARRIVAL_EVENTS,
  HUB_DEPARTURE_EVENTS,
} from "./kpi";
import { laneWhere, shipmentWhere, singleBranchWhere } from "./scope";
import { toDayString } from "./filters";
import type { ReportContext, ReportResult, ReportRow } from "./types";

/**
 * The operational report library — docs/BRD.html §A.17.
 *
 * Every one of these reads from records the operation already produces:
 * the shipment event log, the manifests, the receipts, the attempts. None
 * of them writes anything. None of them loads the whole result set either
 * — each runner asks for one page and a count, and the exporter walks the
 * pages, so a 40,000-row booking register is a stream rather than 40,000
 * rows sitting in the server's heap while somebody renders a table.
 */

// ────────────────────────────────────────────────────────────
// Booking register
// ────────────────────────────────────────────────────────────

export async function bookingRegister(
  ctx: ReportContext,
): Promise<ReportResult> {
  const where = shipmentWhere(ctx.user, ctx.filters, "bookedAt") as Prisma.ShipmentWhereInput;

  const [rows, total, aggregate] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { bookedAt: "desc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        lrNumber: true,
        bookedAt: true,
        mode: true,
        currentStatus: true,
        packageCount: true,
        chargeableWeight: true,
        grandTotal: true,
        paymentType: true,
        codAmount: true,
        customerReference: true,
        consignorName: true,
        consigneeName: true,
        serviceType: { select: { name: true } },
        originBranch: { select: { code: true } },
        destinationBranch: { select: { code: true } },
        consignor: { select: { name: true } },
      },
    }),
    prisma.shipment.count({ where }),
    prisma.shipment.aggregate({
      where,
      _sum: { chargeableWeight: true, grandTotal: true },
      _count: { _all: true },
    }),
  ]);

  return {
    columns: [
      { key: "lr", label: "LR number", type: "code" },
      { key: "bookedAt", label: "Booked", type: "datetime" },
      { key: "customer", label: "Customer" },
      { key: "lane", label: "Lane" },
      { key: "service", label: "Service" },
      { key: "mode", label: "Mode" },
      { key: "packages", label: "Pkgs", type: "number" },
      { key: "weight", label: "Chargeable kg", type: "weight" },
      { key: "payment", label: "Payment" },
      { key: "cod", label: "COD", type: "money" },
      { key: "value", label: "Total", type: "money" },
      { key: "status", label: "Status", type: "state" },
    ],
    rows: rows.map((row) => ({
      key: row.id,
      href: `/shipments/${row.id}`,
      cells: {
        lr: row.lrNumber,
        bookedAt: dateTimeCell(row.bookedAt),
        customer: row.consignor?.name ?? row.consignorName,
        lane: `${row.originBranch.code} → ${row.destinationBranch.code}`,
        service: row.serviceType.name,
        mode: row.mode,
        packages: row.packageCount,
        weight: weightCell(row.chargeableWeight),
        payment: humanise(row.paymentType),
        cod: moneyCell(row.codAmount),
        value: moneyCell(row.grandTotal),
        status: STATUS_LABELS[row.currentStatus],
      },
    })),
    total,
    totals: {
      lr: `${aggregate._count._all} shipment(s)`,
      weight: weightCell(aggregate._sum.chargeableWeight),
      value: moneyCell(aggregate._sum.grandTotal),
    },
  };
}

// ────────────────────────────────────────────────────────────
// Pickup performance
// ────────────────────────────────────────────────────────────

export async function pickupPerformance(
  ctx: ReportContext,
): Promise<ReportResult> {
  const where = singleBranchWhere(
    ctx.user,
    ctx.filters,
    "createdAt",
  ) as Prisma.PickupRequestWhereInput;

  const scoped: Prisma.PickupRequestWhereInput = ctx.filters.customerId
    ? { AND: [where, { customerId: ctx.filters.customerId }] }
    : where;

  const [rows, total] = await Promise.all([
    prisma.pickupRequest.findMany({
      where: scoped,
      orderBy: { requestedDate: "desc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        number: true,
        status: true,
        requestedDate: true,
        slot: true,
        createdAt: true,
        contactName: true,
        expectedPackages: true,
        branch: { select: { code: true } },
        customer: { select: { name: true } },
        shipment: { select: { id: true, lrNumber: true } },
        assignments: {
          orderBy: { assignedAt: "desc" },
          take: 1,
          select: {
            assignedAt: true,
            completedAt: true,
            assignedTo: { select: { name: true } },
            attempts: {
              orderBy: { attemptedAt: "asc" },
              select: {
                outcome: true,
                attemptedAt: true,
                packagesCollected: true,
                reasonCode: { select: { name: true } },
              },
            },
          },
        },
      },
    }),
    prisma.pickupRequest.count({ where: scoped }),
  ]);

  const reportRows: ReportRow[] = rows.map((row) => {
    const assignment = row.assignments[0];
    const attempts = assignment?.attempts ?? [];
    const collected = attempts.find((a) => a.outcome === "COLLECTED");
    const lastFailure = [...attempts].reverse().find((a) => a.outcome === "FAILED");

    // On time means collected on the day the customer was promised. A
    // pickup completed a day late is not "completed", it is late.
    const onTime =
      collected && dateCell(collected.attemptedAt) === dateCell(row.requestedDate);

    return {
      key: row.id,
      href: "/pickups",
      cells: {
        number: row.number,
        requested: dateCell(row.requestedDate),
        slot: humanise(row.slot),
        branch: row.branch.code,
        customer: row.customer?.name ?? row.contactName,
        executive: assignment?.assignedTo.name ?? null,
        attempts: attempts.length,
        collected: dateTimeCell(collected?.attemptedAt),
        packages: collected?.packagesCollected ?? row.expectedPackages ?? null,
        lr: row.shipment?.lrNumber ?? null,
        outcome: collected ? (onTime ? "On time" : "Late") : humanise(row.status),
        reason: lastFailure?.reasonCode?.name ?? null,
      },
      tones: {
        outcome: collected ? (onTime ? "ok" : "warn") : row.status === "FAILED" ? "bad" : "muted",
      },
    };
  });

  return {
    columns: [
      { key: "number", label: "Pickup", type: "code" },
      { key: "requested", label: "Requested for", type: "date" },
      { key: "slot", label: "Slot" },
      { key: "branch", label: "Branch" },
      { key: "customer", label: "Customer" },
      { key: "executive", label: "Executive" },
      { key: "attempts", label: "Attempts", type: "number" },
      { key: "collected", label: "Collected", type: "datetime" },
      { key: "packages", label: "Pkgs", type: "number" },
      { key: "lr", label: "LR", type: "code" },
      { key: "outcome", label: "Outcome", type: "state" },
      { key: "reason", label: "Failure reason" },
    ],
    rows: reportRows,
    total,
    note: "On time means collected on the date the customer was promised, not merely completed.",
  };
}

// ────────────────────────────────────────────────────────────
// Dispatch & manifest
// ────────────────────────────────────────────────────────────

export async function dispatchManifest(
  ctx: ReportContext,
): Promise<ReportResult> {
  const where = laneWhere(
    ctx.user,
    ctx.filters,
    "createdAt",
  ) as Prisma.ManifestWhereInput;

  const [rows, total, aggregate] = await Promise.all([
    prisma.manifest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        number: true,
        status: true,
        createdAt: true,
        closedAt: true,
        dispatchedAt: true,
        receivedAt: true,
        totalShipments: true,
        totalPackages: true,
        totalWeight: true,
        originBranch: { select: { code: true } },
        destinationBranch: { select: { code: true } },
        trip: {
          select: {
            number: true,
            actualDepartureAt: true,
            actualArrivalAt: true,
            plannedArrivalAt: true,
            vehicle: { select: { registrationNumber: true } },
            driver: { select: { name: true } },
          },
        },
      },
    }),
    prisma.manifest.count({ where }),
    prisma.manifest.aggregate({
      where,
      _sum: { totalShipments: true, totalPackages: true, totalWeight: true },
    }),
  ]);

  return {
    columns: [
      { key: "number", label: "Manifest", type: "code" },
      { key: "lane", label: "Lane" },
      { key: "trip", label: "Trip", type: "code" },
      { key: "vehicle", label: "Vehicle", type: "code" },
      { key: "driver", label: "Driver" },
      { key: "shipments", label: "Shipments", type: "number" },
      { key: "packages", label: "Pkgs", type: "number" },
      { key: "weight", label: "Weight kg", type: "weight" },
      { key: "closed", label: "Closed", type: "datetime" },
      { key: "dispatched", label: "Dispatched", type: "datetime" },
      { key: "received", label: "Received", type: "datetime" },
      { key: "transit", label: "Transit", type: "duration" },
      { key: "status", label: "Status", type: "state" },
    ],
    rows: rows.map((row) => ({
      key: row.id,
      href: `/dispatch/manifests/${row.id}`,
      cells: {
        number: row.number,
        lane: `${row.originBranch.code} → ${row.destinationBranch.code}`,
        trip: row.trip?.number ?? null,
        vehicle: row.trip?.vehicle.registrationNumber ?? null,
        driver: row.trip?.driver?.name ?? null,
        shipments: row.totalShipments,
        packages: row.totalPackages,
        weight: weightCell(row.totalWeight),
        closed: dateTimeCell(row.closedAt),
        dispatched: dateTimeCell(row.dispatchedAt),
        received: dateTimeCell(row.receivedAt),
        transit: minutesBetween(row.dispatchedAt, row.receivedAt),
        status: humanise(row.status),
      },
    })),
    total,
    totals: {
      shipments: aggregate._sum.totalShipments ?? 0,
      packages: aggregate._sum.totalPackages ?? 0,
      weight: weightCell(aggregate._sum.totalWeight),
    },
  };
}

// ────────────────────────────────────────────────────────────
// In-transit status
// ────────────────────────────────────────────────────────────

/**
 * Still in the network.
 *
 * Exported so the operations dashboard's SLA tiles count the same set the
 * in-transit report lists. They did not, which is how a tile said one
 * number and the page behind it said another.
 */
export const MOVING: ShipmentStatus[] = [
  ...STATUS_GROUPS.inNetwork,
  ...STATUS_GROUPS.moving,
  ...STATUS_GROUPS.lastMile,
];

export async function inTransitStatus(
  ctx: ReportContext,
): Promise<ReportResult> {
  // Deliberately booked-at rather than status-at: "everything still in
  // the network from last week's bookings" is the question, and filtering
  // on the last status change would hide anything that has not moved.
  const base = shipmentWhere(ctx.user, ctx.filters, "bookedAt") as Prisma.ShipmentWhereInput;
  const where: Prisma.ShipmentWhereInput = {
    AND: [
      base,
      { currentStatus: { in: MOVING } },
      // Whatever the operations dashboard counted, this can list. The
      // tiles link straight in here with `?sla=`, and the two agree
      // because they are now the same query.
      ctx.filters.slaState ? { sla: { state: ctx.filters.slaState } } : {},
    ],
  };

  const now = new Date();

  const [rows, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { statusUpdatedAt: "asc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        lrNumber: true,
        currentStatus: true,
        statusUpdatedAt: true,
        bookedAt: true,
        isOnHold: true,
        packageCount: true,
        chargeableWeight: true,
        originBranch: { select: { code: true } },
        destinationBranch: { select: { code: true } },
        currentBranch: { select: { code: true } },
        consignor: { select: { name: true } },
        consignorName: true,
        sla: { select: { state: true, dueAt: true } },
      },
    }),
    prisma.shipment.count({ where }),
  ]);

  return {
    columns: [
      { key: "lr", label: "LR number", type: "code" },
      { key: "customer", label: "Customer" },
      { key: "lane", label: "Lane" },
      { key: "at", label: "Currently at" },
      { key: "status", label: "Status", type: "state" },
      { key: "since", label: "Unchanged for", type: "duration" },
      { key: "packages", label: "Pkgs", type: "number" },
      { key: "weight", label: "Kg", type: "weight" },
      { key: "due", label: "SLA due", type: "datetime" },
      { key: "sla", label: "SLA", type: "state" },
    ],
    rows: rows.map((row) => ({
      key: row.id,
      href: `/shipments/${row.id}`,
      cells: {
        lr: row.lrNumber,
        customer: row.consignor?.name ?? row.consignorName,
        lane: `${row.originBranch.code} → ${row.destinationBranch.code}`,
        at: row.currentBranch?.code ?? "—",
        status: row.isOnHold
          ? `${STATUS_LABELS[row.currentStatus]} (held)`
          : STATUS_LABELS[row.currentStatus],
        since: ageMinutes(row.statusUpdatedAt, now),
        packages: row.packageCount,
        weight: weightCell(row.chargeableWeight),
        due: dateTimeCell(row.sla?.dueAt),
        sla: row.sla ? SLA_STATE_LABEL[row.sla.state] : "Not scanned",
      },
      tones: {
        sla: slaTone(row.sla?.state),
        status: row.isOnHold ? "bad" : "muted",
      },
    })),
    total,
    note: "Sorted oldest first: what has not moved for longest is what needs a phone call.",
  };
}

/** Reason-code names by id, in one query. */
async function loadReasonNames(
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();

  const rows = await prisma.reasonCode.findMany({
    where: { id: { in: wanted } },
    select: { id: true, name: true },
  });

  return new Map(rows.map((row) => [row.id, row.name]));
}

function slaTone(
  state: string | undefined,
): "ok" | "warn" | "bad" | "info" | "muted" {
  switch (state) {
    case "MET":
      return "ok";
    case "AT_RISK":
      return "warn";
    case "BREACHED":
      return "bad";
    case "ON_TIME":
      return "info";
    default:
      return "muted";
  }
}

// ────────────────────────────────────────────────────────────
// Delivery & undelivered
// ────────────────────────────────────────────────────────────

export async function deliveryRegister(
  ctx: ReportContext,
): Promise<ReportResult> {
  const base = shipmentWhere(
    ctx.user,
    ctx.filters,
    "statusUpdatedAt",
  ) as Prisma.ShipmentWhereInput;

  const where: Prisma.ShipmentWhereInput = {
    AND: [
      base,
      {
        OR: [
          { currentStatus: { in: [...STATUS_GROUPS.done] } },
          { attemptCount: { gt: 0 } },
          { currentStatus: { in: ["RTO_INITIATED", "RTO_IN_TRANSIT", "RTO_DELIVERED"] } },
        ],
      },
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { statusUpdatedAt: "desc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        lrNumber: true,
        currentStatus: true,
        deliveredAt: true,
        attemptCount: true,
        statusUpdatedAt: true,
        codAmount: true,
        destinationBranch: { select: { code: true } },
        originBranch: { select: { code: true } },
        consignor: { select: { name: true } },
        consignorName: true,
        consigneeName: true,
        sla: { select: { state: true, varianceMinutes: true } },
        pod: { select: { receiverName: true, deliveredAt: true } },
        deliveryAttempts: {
          orderBy: { attemptedAt: "desc" },
          take: 1,
          select: {
            outcome: true,
            attemptedAt: true,
            // `DeliveryAttempt` carries the reason id without a relation,
            // so the names are looked up once below rather than joined.
            reasonCodeId: true,
            task: { select: { run: { select: { agent: { select: { name: true } } } } } },
          },
        },
      },
    }),
    prisma.shipment.count({ where }),
  ]);

  const reasons = await loadReasonNames(
    rows.flatMap((row) => row.deliveryAttempts.map((a) => a.reasonCodeId)),
  );

  return {
    columns: [
      { key: "lr", label: "LR number", type: "code" },
      { key: "customer", label: "Customer" },
      { key: "consignee", label: "Consignee" },
      { key: "lane", label: "Lane" },
      { key: "agent", label: "Agent" },
      { key: "attempts", label: "Failed attempts", type: "number" },
      { key: "delivered", label: "Delivered", type: "datetime" },
      { key: "receiver", label: "Received by" },
      { key: "cod", label: "COD", type: "money" },
      { key: "variance", label: "Against SLA", type: "duration" },
      { key: "outcome", label: "Outcome", type: "state" },
      { key: "reason", label: "Reason" },
    ],
    rows: rows.map((row) => {
      const attempt = row.deliveryAttempts[0];
      const delivered = Boolean(row.deliveredAt);

      return {
        key: row.id,
        href: `/shipments/${row.id}`,
        cells: {
          lr: row.lrNumber,
          customer: row.consignor?.name ?? row.consignorName,
          consignee: row.consigneeName,
          lane: `${row.originBranch.code} → ${row.destinationBranch.code}`,
          agent: attempt?.task.run?.agent.name ?? null,
          attempts: row.attemptCount,
          delivered: dateTimeCell(row.deliveredAt),
          receiver: row.pod?.receiverName ?? null,
          cod: moneyCell(row.codAmount),
          variance: row.sla?.varianceMinutes ?? null,
          outcome: delivered
            ? row.attemptCount === 0
              ? "Delivered first time"
              : `Delivered after ${row.attemptCount}`
            : STATUS_LABELS[row.currentStatus],
          reason:
            attempt?.outcome === "FAILED" && attempt.reasonCodeId
              ? (reasons.get(attempt.reasonCodeId) ?? null)
              : null,
        },
        tones: {
          outcome: delivered ? (row.attemptCount === 0 ? "ok" : "warn") : "bad",
        },
      };
    }),
    total,
    note: "Against SLA is signed: positive minutes are late, negative are early.",
  };
}

// ────────────────────────────────────────────────────────────
// Pending POD
// ────────────────────────────────────────────────────────────

export async function pendingPod(ctx: ReportContext): Promise<ReportResult> {
  const base = shipmentWhere(
    ctx.user,
    ctx.filters,
    "deliveredAt",
  ) as Prisma.ShipmentWhereInput;

  const where: Prisma.ShipmentWhereInput = {
    AND: [
      base,
      { deliveredAt: { not: null } },
      // Delivered, but no proof has landed. Either no POD row at all, or
      // one with nothing attached to it — a signature nobody captured is
      // the same problem as a POD nobody created.
      {
        OR: [
          { pod: { is: null } },
          { pod: { signatureAssetId: null, photoAssetId: null } },
        ],
      },
    ],
  };

  const now = new Date();

  const [rows, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { deliveredAt: "asc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        lrNumber: true,
        deliveredAt: true,
        consigneeName: true,
        consignor: { select: { name: true } },
        consignorName: true,
        destinationBranch: { select: { code: true, name: true } },
        pod: { select: { receiverName: true, recordedAt: true } },
        deliveryTasks: {
          orderBy: { assignedAt: "desc" },
          take: 1,
          select: { run: { select: { agent: { select: { name: true } } } } },
        },
      },
    }),
    prisma.shipment.count({ where }),
  ]);

  return {
    columns: [
      { key: "lr", label: "LR number", type: "code" },
      { key: "customer", label: "Customer" },
      { key: "consignee", label: "Consignee" },
      { key: "branch", label: "Destination" },
      { key: "agent", label: "Agent" },
      { key: "delivered", label: "Delivered", type: "datetime" },
      { key: "pending", label: "POD outstanding", type: "duration" },
      { key: "state", label: "State", type: "state" },
    ],
    rows: rows.map((row) => {
      const pending = ageMinutes(row.deliveredAt, now) ?? 0;

      return {
        key: row.id,
        href: `/delivery/pod/${row.id}`,
        cells: {
          lr: row.lrNumber,
          customer: row.consignor?.name ?? row.consignorName,
          consignee: row.consigneeName,
          branch: row.destinationBranch.code,
          agent: row.deliveryTasks[0]?.run?.agent.name ?? null,
          delivered: dateTimeCell(row.deliveredAt),
          pending,
          state: row.pod ? "POD started, nothing attached" : "No POD",
        },
        // §A.11 puts the escalation at 24 hours; the colour follows.
        tones: { state: pending > 24 * 60 ? "bad" : "warn" },
      };
    }),
    total,
    note: "A delivery with no proof is a delivery you cannot bill for and cannot defend.",
  };
}

// ────────────────────────────────────────────────────────────
// Exception register
// ────────────────────────────────────────────────────────────

export async function exceptionRegister(
  ctx: ReportContext,
): Promise<ReportResult> {
  const scope =
    ctx.user.branchIds === null
      ? {}
      : { ownerBranchId: { in: ctx.user.branchIds } };

  const where: Prisma.ExceptionWhereInput = {
    AND: [
      { detectedAt: { gte: ctx.filters.from, lte: ctx.filters.to } },
      scope,
      ctx.filters.branchId ? { ownerBranchId: ctx.filters.branchId } : {},
      ctx.filters.q
        ? {
            OR: [
              { number: { contains: ctx.filters.q, mode: "insensitive" } },
              { title: { contains: ctx.filters.q, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };

  const now = new Date();

  const [rows, total] = await Promise.all([
    prisma.exception.findMany({
      where,
      orderBy: [{ priority: "desc" }, { detectedAt: "asc" }],
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        number: true,
        kind: true,
        priority: true,
        status: true,
        title: true,
        detectedAt: true,
        resolvedAt: true,
        closedAt: true,
        resolution: true,
        escalationLevel: true,
        source: true,
        branch: { select: { code: true } },
        assignedTo: { select: { name: true } },
        shipment: { select: { lrNumber: true } },
      },
    }),
    prisma.exception.count({ where }),
  ]);

  return {
    columns: [
      { key: "number", label: "Exception", type: "code" },
      { key: "kind", label: "Kind" },
      { key: "priority", label: "Priority", type: "state" },
      { key: "title", label: "What is wrong" },
      { key: "lr", label: "LR", type: "code" },
      { key: "branch", label: "Owner branch" },
      { key: "owner", label: "Assigned to" },
      { key: "detected", label: "Opened", type: "datetime" },
      { key: "age", label: "Age", type: "duration" },
      { key: "escalation", label: "Escalated to", type: "number" },
      { key: "resolved", label: "Resolved", type: "datetime" },
      { key: "resolution", label: "Resolution" },
      { key: "status", label: "Status", type: "state" },
    ],
    rows: rows.map((row) => ({
      key: row.id,
      href: `/exceptions/${row.id}`,
      cells: {
        number: row.number,
        kind: kindLabel(row.kind),
        priority: humanise(row.priority),
        title: row.title,
        lr: row.shipment?.lrNumber ?? null,
        branch: row.branch?.code ?? null,
        owner: row.assignedTo?.name ?? "Unassigned",
        detected: dateTimeCell(row.detectedAt),
        age: minutesBetween(row.detectedAt, row.resolvedAt ?? now),
        escalation: row.escalationLevel,
        resolved: dateTimeCell(row.resolvedAt),
        resolution: row.resolution,
        status: EXCEPTION_STATUS_LABEL[row.status],
      },
      tones: {
        priority:
          row.priority === "CRITICAL"
            ? "bad"
            : row.priority === "HIGH"
              ? "warn"
              : "muted",
        status:
          row.status === "RESOLVED" || row.status === "CLOSED"
            ? "ok"
            : row.status === "DISMISSED"
              ? "muted"
              : "bad",
      },
    })),
    total,
  };
}

// ────────────────────────────────────────────────────────────
// Hub inbound / outbound and dwell
// ────────────────────────────────────────────────────────────

/**
 * Dwell, read off the event log.
 *
 * The arrival is the inbound scan and the departure is the gate-out that
 * follows it — §A.17's definition exactly. Computed per shipment-visit
 * rather than per shipment, because a consignment crossing three hubs
 * dwells three times and averaging them into one number hides the hub
 * that is actually slow.
 */
export async function hubDwell(ctx: ReportContext): Promise<ReportResult> {
  const branchClause =
    ctx.user.branchIds === null
      ? ctx.filters.branchId
        ? { branchId: ctx.filters.branchId }
        : {}
      : {
          branchId: {
            in: ctx.filters.branchId
              ? ctx.user.branchIds.filter((id) => id === ctx.filters.branchId)
              : ctx.user.branchIds,
          },
        };

  const where: Prisma.ShipmentEventWhereInput = {
    AND: [
      { occurredAt: { gte: ctx.filters.from, lte: ctx.filters.to } },
      // The same list the dashboard's dwell KPI uses. Keeping two lists
      // meant the two disagreed on the same event log.
      { eventType: { in: [...HUB_ARRIVAL_EVENTS] } },
      { branchId: { not: null } },
      branchClause,
    ],
  };

  const [arrivals, total] = await Promise.all([
    prisma.shipmentEvent.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        occurredAt: true,
        shipmentId: true,
        branchId: true,
        branch: { select: { code: true, name: true } },
        shipment: {
          select: {
            id: true,
            lrNumber: true,
            packageCount: true,
            chargeableWeight: true,
            destinationBranch: { select: { code: true } },
          },
        },
      },
    }),
    prisma.shipmentEvent.count({ where }),
  ]);

  // One query for the matching departures rather than one per row.
  const earliest = arrivals.reduce(
    (min, arrival) => Math.min(min, arrival.occurredAt.getTime()),
    Number.POSITIVE_INFINITY,
  );

  const departures =
    arrivals.length === 0
      ? []
      : await prisma.shipmentEvent.findMany({
          where: {
            shipmentId: { in: arrivals.map((a) => a.shipmentId) },
            eventType: { in: [...HUB_DEPARTURE_EVENTS] },
            occurredAt: { gte: new Date(earliest) },
          },
          orderBy: { occurredAt: "asc" },
          select: { shipmentId: true, occurredAt: true, branchId: true },
        });

  const now = new Date();

  const rows: ReportRow[] = arrivals.map((arrival) => {
    // Same hub, not merely later. `branchId` was already being selected
    // here and never compared, so a consignment's gate-out at the *next*
    // hub closed this hub's dwell — which makes a slow hub read fast and
    // charges the delay to whoever handled it afterwards.
    const departure = firstDepartureAfter(departures, arrival);

    const dwell = minutesBetween(arrival.occurredAt, departure?.occurredAt ?? now);

    return {
      key: arrival.id,
      href: `/shipments/${arrival.shipment.id}`,
      cells: {
        lr: arrival.shipment.lrNumber,
        hub: arrival.branch?.code ?? null,
        onwards: arrival.shipment.destinationBranch.code,
        packages: arrival.shipment.packageCount,
        weight: weightCell(arrival.shipment.chargeableWeight),
        inbound: dateTimeCell(arrival.occurredAt),
        outbound: dateTimeCell(departure?.occurredAt),
        dwell,
        state: departure ? "Moved on" : "Still here",
      },
      tones: {
        state: departure ? "ok" : (dwell ?? 0) > 24 * 60 ? "bad" : "warn",
      },
    };
  });

  return {
    columns: [
      { key: "lr", label: "LR number", type: "code" },
      { key: "hub", label: "Hub" },
      { key: "onwards", label: "Onward to" },
      { key: "packages", label: "Pkgs", type: "number" },
      { key: "weight", label: "Kg", type: "weight" },
      { key: "inbound", label: "Inbound scan", type: "datetime" },
      { key: "outbound", label: "Outbound load", type: "datetime" },
      { key: "dwell", label: "Dwell", type: "duration" },
      { key: "state", label: "State", type: "state" },
    ],
    rows,
    total,
    note: "One row per visit. A consignment crossing three hubs dwells three times, and averaging them hides the slow one.",
  };
}

// ────────────────────────────────────────────────────────────
// Vehicle utilisation
// ────────────────────────────────────────────────────────────

export async function vehicleUtilisation(
  ctx: ReportContext,
): Promise<ReportResult> {
  const where = laneWhere(
    ctx.user,
    ctx.filters,
    "createdAt",
  ) as Prisma.TripWhereInput;

  const [rows, total] = await Promise.all([
    prisma.trip.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        number: true,
        status: true,
        actualDepartureAt: true,
        actualArrivalAt: true,
        plannedArrivalAt: true,
        distanceKm: true,
        originBranch: { select: { code: true } },
        destinationBranch: { select: { code: true } },
        driver: { select: { name: true } },
        vehicle: {
          select: {
            registrationNumber: true,
            vehicleType: {
              select: { name: true, capacityKg: true, capacityCft: true },
            },
          },
        },
        manifests: {
          select: { totalWeight: true, totalPackages: true, totalShipments: true },
        },
      },
    }),
    prisma.trip.count({ where }),
  ]);

  const reportRows: ReportRow[] = rows.map((row) => {
    const loaded = sumDecimal(row.manifests.map((m) => m.totalWeight));
    const capacity = row.vehicle.vehicleType.capacityKg;
    const capacityKg = capacity ? Number(capacity.toString()) : 0;

    const utilisation =
      capacityKg > 0
        ? Math.round(loaded.dividedBy(capacityKg).times(10_000).toNumber()) / 100
        : null;

    const lateBy =
      row.actualArrivalAt && row.plannedArrivalAt
        ? minutesBetween(row.plannedArrivalAt, row.actualArrivalAt)
        : null;

    return {
      key: row.id,
      href: `/dispatch/trips/${row.id}`,
      cells: {
        trip: row.number,
        vehicle: row.vehicle.registrationNumber,
        type: row.vehicle.vehicleType.name,
        driver: row.driver?.name ?? null,
        lane: `${row.originBranch.code} → ${row.destinationBranch.code}`,
        shipments: row.manifests.reduce((sum, m) => sum + m.totalShipments, 0),
        loaded: loaded.toDecimalPlaces(3).toNumber(),
        capacity: capacityKg,
        utilisation,
        distance: row.distanceKm ? Number(row.distanceKm.toString()) : null,
        departed: dateTimeCell(row.actualDepartureAt),
        arrived: dateTimeCell(row.actualArrivalAt),
        lateBy,
        status: humanise(row.status),
      },
      tones: {
        utilisation:
          utilisation === null ? "muted" : utilisation >= 80 ? "ok" : utilisation >= 65 ? "warn" : "bad",
      },
    };
  });

  return {
    columns: [
      { key: "trip", label: "Trip", type: "code" },
      { key: "vehicle", label: "Vehicle", type: "code" },
      { key: "type", label: "Type" },
      { key: "driver", label: "Driver" },
      { key: "lane", label: "Lane" },
      { key: "shipments", label: "Shipments", type: "number" },
      { key: "loaded", label: "Loaded kg", type: "weight" },
      { key: "capacity", label: "Capacity kg", type: "weight" },
      { key: "utilisation", label: "Utilisation", type: "percent" },
      { key: "distance", label: "Km", type: "number" },
      { key: "departed", label: "Departed", type: "datetime" },
      { key: "arrived", label: "Arrived", type: "datetime" },
      { key: "lateBy", label: "Against plan", type: "duration" },
      { key: "status", label: "Status", type: "state" },
    ],
    rows: reportRows,
    total,
    note: "Utilisation is manifested weight against the vehicle type's rated capacity. Volume utilisation needs cubic capacity on the vehicle type.",
  };
}

// ────────────────────────────────────────────────────────────
// Document expiry
// ────────────────────────────────────────────────────────────

/**
 * Vehicle and driver documents, closest expiry first.
 *
 * Deliberately not filtered by the report date range: an insurance
 * certificate that expired last month is a problem today, and hiding it
 * because the range starts on the first of this month would be exactly
 * the wrong behaviour. The range is ignored and the header says so.
 */
export async function documentExpiry(
  ctx: ReportContext,
): Promise<ReportResult> {
  const branchIds = ctx.user.branchIds;
  const branchFilter = ctx.filters.branchId
    ? [ctx.filters.branchId].filter((id) => branchIds === null || branchIds.includes(id))
    : branchIds;

  const vehicleWhere: Prisma.VehicleDocumentWhereInput = {
    expiresOn: { not: null },
    vehicle: {
      deletedAt: null,
      isActive: true,
      ...(branchFilter ? { branchId: { in: branchFilter } } : {}),
    },
  };

  const driverWhere: Prisma.DriverDocumentWhereInput = {
    expiresOn: { not: null },
    driver: {
      deletedAt: null,
      isActive: true,
      ...(branchFilter ? { branchId: { in: branchFilter } } : {}),
    },
  };

  /**
   * Both tables, up to the end of the requested page.
   *
   * The merge has to happen before the slice. Taking one page from each
   * table and sorting the two pages together produced a "closest expiry
   * first" ordering that was only true inside a page: with 300 vehicle
   * documents and 3 driver ones, page one showed 53 rows — the header
   * promised 50 — and every driver document sat on page one however far
   * away it expired. Reading to the end of the page and slicing once costs
   * `page × pageSize` rows and is the only ordering that survives paging.
   */
  const upTo = ctx.page * ctx.pageSize;

  const [vehicleDocs, driverDocs, vehicleCount, driverCount] = await Promise.all([
    prisma.vehicleDocument.findMany({
      where: vehicleWhere,
      orderBy: { expiresOn: "asc" },
      take: upTo,
      select: {
        id: true,
        kind: true,
        documentNumber: true,
        expiresOn: true,
        vehicle: {
          select: {
            registrationNumber: true,
            branch: { select: { code: true } },
          },
        },
      },
    }),
    prisma.driverDocument.findMany({
      where: driverWhere,
      orderBy: { expiresOn: "asc" },
      take: upTo,
      select: {
        id: true,
        kind: true,
        documentNumber: true,
        expiresOn: true,
        driver: {
          select: { name: true, code: true, branch: { select: { code: true } } },
        },
      },
    }),
    prisma.vehicleDocument.count({ where: vehicleWhere }),
    prisma.driverDocument.count({ where: driverWhere }),
  ]);

  /**
   * Today, as the `date` column stores it.
   *
   * `expiresOn` is `@db.Date` — UTC midnight of a calendar day — so "today"
   * has to be the *branch-local* calendar day expressed the same way.
   * Building it from the UTC parts of `new Date()` made every evening in
   * India read yesterday's date: between 18:30 and midnight IST, "Days
   * left" was one too high and a certificate expiring today was labelled
   * Valid. Six of these have been found in this repo; this was the seventh.
   */
  const [year, month, day] = toDayString(new Date()).split("-").map(Number);
  const startOfToday = new Date(Date.UTC(year, month - 1, day));

  const rows: ReportRow[] = [
    ...vehicleDocs.map((doc) => ({
      key: `v-${doc.id}`,
      cells: {
        holder: doc.vehicle.registrationNumber,
        holderKind: "Vehicle",
        branch: doc.vehicle.branch?.code ?? null,
        document: humanise(doc.kind),
        number: doc.documentNumber,
        expires: dateCell(doc.expiresOn),
        days: daysUntil(doc.expiresOn, startOfToday),
      },
      tones: { state: "muted" as const },
    })),
    ...driverDocs.map((doc) => ({
      key: `d-${doc.id}`,
      cells: {
        holder: `${doc.driver.name} (${doc.driver.code})`,
        holderKind: "Driver",
        branch: doc.driver.branch?.code ?? null,
        document: humanise(doc.kind),
        number: doc.documentNumber,
        expires: dateCell(doc.expiresOn),
        days: daysUntil(doc.expiresOn, startOfToday),
      },
      tones: { state: "muted" as const },
    })),
  ]
    // Sorted across both tables, then cut to the page the reader asked
    // for. `key` breaks ties so two documents expiring on the same day do
    // not swap places between page loads and appear twice, or not at all.
    .sort(
      (a, b) =>
        Number(a.cells.days ?? 0) - Number(b.cells.days ?? 0) ||
        a.key.localeCompare(b.key),
    )
    .slice((ctx.page - 1) * ctx.pageSize, upTo)
    .map((row) => {
      const days = Number(row.cells.days ?? 0);
      return {
        ...row,
        cells: {
          ...row.cells,
          state: days < 0 ? "Expired" : days <= 30 ? "Expiring" : "Valid",
        },
        tones: {
          state: (days < 0 ? "bad" : days <= 30 ? "warn" : "ok") as
            | "bad"
            | "warn"
            | "ok",
        },
      };
    });

  return {
    columns: [
      { key: "holder", label: "Vehicle / driver", type: "code" },
      { key: "holderKind", label: "Kind" },
      { key: "branch", label: "Branch" },
      { key: "document", label: "Document" },
      { key: "number", label: "Number", type: "code" },
      { key: "expires", label: "Expires", type: "date" },
      { key: "days", label: "Days left", type: "number" },
      { key: "state", label: "State", type: "state" },
    ],
    rows,
    total: vehicleCount + driverCount,
    note: "The date range does not apply here — a certificate that expired last month is a problem today.",
  };
}

function daysUntil(expiresOn: Date | null, from: Date): number | null {
  if (!expiresOn) return null;
  return Math.round((expiresOn.getTime() - from.getTime()) / 86_400_000);
}
