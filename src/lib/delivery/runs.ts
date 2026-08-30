import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import { prisma, tenantTransaction, type DbOrTx } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch, assignmentScope, branchScope } from "@/server/repositories/scope";
import { nextNumber } from "@/lib/numbering/number-series";
import { appendShipmentEvent } from "@/lib/shipment/events";

/**
 * Building a delivery run.
 *
 * A run is one agent's route for one day: an ordered list of stops and a
 * COD total the agent is personally accountable for at day end. Attaching a
 * shipment to a run is a shipment event like any other — `DELIVERY_ASSIGNED`
 * moves it to `ASSIGNED_FOR_DELIVERY`. Nothing here writes `currentStatus`.
 *
 * See docs/BRD.html §A.10.
 */

/** Runs a field agent may see. OWN scope means their own run, nothing else. */
export function deliveryRunScope(user: SessionUser): Record<string, unknown> {
  return assignmentScope(user, "agentId", "branchId");
}

/**
 * Tasks a user may see. A task has no agent column of its own — the agent
 * is on the run — so ownership is resolved through the relation.
 */
export function deliveryTaskScope(user: SessionUser): Record<string, unknown> {
  if (user.scope === "OWN") return { run: { agentId: user.id } };
  return branchScope(user, "branchId");
}

export type CreateRunInput = {
  branchId: string;
  agentId: string;
  vehicleId?: string | null;
  /** The day the run is for, at local midnight. */
  runDate: Date;
};

export type RunResult =
  | { ok: true; runId: string; number: string }
  | { ok: false; error: string };

export async function createDeliveryRun(
  input: CreateRunInput,
  actor: SessionUser,
): Promise<RunResult> {
  if (!can(actor, "delivery.assign")) {
    return { ok: false, error: "You do not have permission to build delivery runs." };
  }
  if (!coversBranch(actor, input.branchId)) {
    return { ok: false, error: "That branch is outside your scope." };
  }

  const agent = await prisma.user.findUnique({
    where: { id: input.agentId },
    select: { id: true, name: true, status: true, deletedAt: true },
  });

  if (!agent || agent.deletedAt || agent.status !== "ACTIVE") {
    return { ok: false, error: "That agent is not available." };
  }

  const branch = await prisma.branch.findUnique({
    where: { id: input.branchId },
    select: { id: true, code: true },
  });

  if (!branch) return { ok: false, error: "That branch does not exist." };

  // One run per agent per day. A second one splits the COD accountability
  // in half, and day-end reconciliation stops adding up.
  const existing = await prisma.deliveryRun.findFirst({
    where: {
      agentId: input.agentId,
      runDate: input.runDate,
      status: { in: ["PLANNED", "STARTED"] },
    },
    select: { id: true, number: true },
  });

  if (existing) {
    return {
      ok: false,
      error: `${agent.name} already has run ${existing.number} open for that date. Add the stops to it instead.`,
    };
  }

  try {
    const run = await tenantTransaction(async (tx) => {
      const number = await nextNumber(
        { document: "DELIVERY_RUN", branchId: input.branchId, branchCode: branch.code },
        tx,
      );

      return tx.deliveryRun.create({
        data: {
          orgId: actor.orgId,
          number,
          branchId: input.branchId,
          agentId: input.agentId,
          vehicleId: input.vehicleId ?? undefined,
          runDate: input.runDate,
          createdById: actor.id,
        },
        select: { id: true, number: true },
      });
    });

    return { ok: true, runId: run.id, number: run.number };
  } catch (error) {
    // A network-wide series with no branch row configured is the usual
    // cause, and the message from `nextNumber` says exactly that.
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The run could not be created.",
    };
  }
}

export type AddStopsResult =
  | { ok: true; added: number; skipped: Array<{ lrNumber: string; reason: string }> }
  | { ok: false; error: string };

/**
 * Adds shipments to a run.
 *
 * Only consignments physically received at this branch can go out for
 * delivery from it, so the candidate set is `RECEIVED_AT_HUB` here. Anything
 * that cannot be added is reported back by LR number rather than silently
 * dropped — an agent leaving without a parcel the branch thinks he has is
 * how shipments get lost.
 */
export async function addShipmentsToRun(
  runId: string,
  shipmentIds: string[],
  actor: SessionUser,
): Promise<AddStopsResult> {
  if (!can(actor, "delivery.assign")) {
    return { ok: false, error: "You do not have permission to assign deliveries." };
  }
  if (shipmentIds.length === 0) {
    return { ok: true, added: 0, skipped: [] };
  }

  const run = await prisma.deliveryRun.findUnique({
    where: { id: runId },
    select: { id: true, branchId: true, status: true, number: true },
  });

  if (!run) return { ok: false, error: "That run does not exist." };
  if (!coversBranch(actor, run.branchId)) {
    return { ok: false, error: "That run belongs to another branch." };
  }
  if (run.status === "COMPLETED" || run.status === "CANCELLED") {
    return { ok: false, error: `Run ${run.number} is ${run.status.toLowerCase()}.` };
  }

  const shipments = await prisma.shipment.findMany({
    where: { id: { in: shipmentIds }, deletedAt: null },
    select: {
      id: true,
      lrNumber: true,
      currentStatus: true,
      currentBranchId: true,
      isOnHold: true,
      attemptCount: true,
      paymentType: true,
      codAmount: true,
    },
  });

  const skipped: Array<{ lrNumber: string; reason: string }> = [];
  let added = 0;

  const highest = await prisma.deliveryTask.aggregate({
    where: { runId },
    _max: { sequence: true },
  });
  let sequence = highest._max.sequence ?? 0;

  for (const shipment of shipments) {
    if (shipment.isOnHold) {
      skipped.push({ lrNumber: shipment.lrNumber, reason: "on hold" });
      continue;
    }
    if (shipment.currentBranchId !== run.branchId) {
      skipped.push({ lrNumber: shipment.lrNumber, reason: "not at this branch" });
      continue;
    }
    if (
      shipment.currentStatus !== "RECEIVED_AT_HUB" &&
      shipment.currentStatus !== "ASSIGNED_FOR_DELIVERY"
    ) {
      skipped.push({
        lrNumber: shipment.lrNumber,
        reason: `is ${shipment.currentStatus.replace(/_/g, " ").toLowerCase()}`,
      });
      continue;
    }

    const openTask = await prisma.deliveryTask.findFirst({
      where: {
        shipmentId: shipment.id,
        status: { in: ["PENDING", "OUT_FOR_DELIVERY"] },
        runId: { not: null },
      },
      select: { id: true, run: { select: { number: true } } },
    });

    if (openTask) {
      skipped.push({
        lrNumber: shipment.lrNumber,
        reason: `already on run ${openTask.run?.number ?? "another run"}`,
      });
      continue;
    }

    sequence += 1;
    const stopNumber = sequence;

    try {
      await tenantTransaction(async (tx) => {
        // A reattempt task raised by a previous failure is reused rather
        // than duplicated, so the attempt history stays one row per visit.
        const pending = await tx.deliveryTask.findFirst({
          where: { shipmentId: shipment.id, status: "PENDING", runId: null },
          select: { id: true, attemptNumber: true, priority: true },
        });

        if (pending) {
          await tx.deliveryTask.update({
            where: { id: pending.id },
            data: {
              runId,
              branchId: run.branchId,
              sequence: stopNumber,
              codAmount:
                shipment.paymentType === "COD" ? shipment.codAmount : undefined,
              assignedById: actor.id,
              assignedAt: new Date(),
            },
          });
        } else {
          await tx.deliveryTask.create({
            data: {
              // The dispatcher building the run; the run and the shipment
              // were already read under the same tenant.
              orgId: actor.orgId,
              runId,
              shipmentId: shipment.id,
              branchId: run.branchId,
              sequence: stopNumber,
              // A shipment that has already been out once sorts to the front
              // of the next run: it has waited longest.
              priority: shipment.attemptCount > 0 ? 10 : 0,
              attemptNumber: shipment.attemptCount + 1,
              codAmount:
                shipment.paymentType === "COD" ? shipment.codAmount : undefined,
              assignedById: actor.id,
            },
          });
        }

        const event = await appendShipmentEvent(
          {
            shipmentId: shipment.id,
            eventType: "DELIVERY_ASSIGNED",
            branchId: run.branchId,
            idempotencyKey: randomUUID(),
            payload: {
              runId,
              runNumber: run.number,
              sequence: stopNumber,
              attemptNumber: shipment.attemptCount + 1,
            },
          },
          actor,
          tx,
        );

        if (!event.ok) throw new Error(event.error);
      });

      added += 1;
    } catch (error) {
      sequence -= 1;
      skipped.push({
        lrNumber: shipment.lrNumber,
        reason: error instanceof Error ? error.message : "could not be assigned",
      });
    }
  }

  const missing = shipmentIds.filter((id) => !shipments.some((s) => s.id === id));
  for (const id of missing) {
    skipped.push({ lrNumber: id, reason: "not found" });
  }

  await recalculateRunTotals(runId);

  return { ok: true, added, skipped };
}

/** Takes a stop off a run before it starts. The shipment stays at the branch. */
export async function removeTaskFromRun(
  taskId: string,
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "delivery.reassign")) {
    return { ok: false, error: "You do not have permission to change delivery runs." };
  }

  const task = await prisma.deliveryTask.findUnique({
    where: { id: taskId },
    select: { id: true, runId: true, status: true, branchId: true },
  });

  if (!task || !task.runId) return { ok: false, error: "That stop does not exist." };
  if (!coversBranch(actor, task.branchId)) {
    return { ok: false, error: "That stop belongs to another branch." };
  }
  if (task.status !== "PENDING") {
    return {
      ok: false,
      error: "The agent has already started this stop — record the outcome instead.",
    };
  }

  const runId = task.runId;

  // The task itself survives, unassigned: it is still owed a delivery, and
  // deleting it would erase which attempt the next visit is.
  await prisma.deliveryTask.update({
    where: { id: taskId },
    data: { runId: null, sequence: 0 },
  });

  await recalculateRunTotals(runId);
  return { ok: true };
}

/** Reorders the stops. Sequencing is manual — route optimisation is Phase 8. */
export async function resequenceRun(
  runId: string,
  orderedTaskIds: string[],
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "delivery.assign")) {
    return { ok: false, error: "You do not have permission to sequence runs." };
  }

  const run = await prisma.deliveryRun.findUnique({
    where: { id: runId },
    select: { branchId: true, tasks: { select: { id: true } } },
  });

  if (!run) return { ok: false, error: "That run does not exist." };
  if (!coversBranch(actor, run.branchId)) {
    return { ok: false, error: "That run belongs to another branch." };
  }

  const known = new Set(run.tasks.map((task) => task.id));
  const ordered = orderedTaskIds.filter((id) => known.has(id));

  // Sequenced one at a time in the given order. The array form could not
  // carry the tenant into the session, and every update is independent —
  // the ordering here is the caller's, not a dependency between statements.
  await tenantTransaction(async (tx) => {
    for (const [index, id] of ordered.entries()) {
      await tx.deliveryTask.update({
        where: { id },
        data: { sequence: index + 1 },
      });
    }
  });

  return { ok: true };
}

/**
 * The out-scan. The agent takes custody and the goods leave the branch.
 *
 * Every stop is evented here rather than at the door, because that is when
 * the parcels physically go on the vehicle — which is what "out for
 * delivery" means to a customer chasing one.
 */
export async function startRun(
  runId: string,
  actor: SessionUser,
): Promise<{ ok: true; started: number } | { ok: false; error: string }> {
  if (!can(actor, "delivery.execute")) {
    return { ok: false, error: "You do not have permission to start a run." };
  }

  const run = await prisma.deliveryRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      branchId: true,
      agentId: true,
      status: true,
      tasks: {
        where: { status: "PENDING" },
        select: { id: true, shipmentId: true },
      },
    },
  });

  if (!run) return { ok: false, error: "That run does not exist." };
  if (actor.scope === "OWN" && run.agentId !== actor.id) {
    return { ok: false, error: "That run belongs to another agent." };
  }
  if (run.status === "COMPLETED" || run.status === "CANCELLED") {
    return { ok: false, error: "That run is closed." };
  }
  if (run.tasks.length === 0) {
    return { ok: false, error: "There is nothing on this run yet." };
  }

  let started = 0;

  for (const task of run.tasks) {
    const result = await tenantTransaction(async (tx) => {
      const event = await appendShipmentEvent(
        {
          shipmentId: task.shipmentId,
          eventType: "RUN_STARTED",
          branchId: run.branchId,
          source: "FIELD_APP",
          idempotencyKey: randomUUID(),
          payload: { runId, taskId: task.id },
        },
        actor,
        tx,
      );

      if (!event.ok) return false;

      await tx.deliveryTask.update({
        where: { id: task.id },
        data: { status: "OUT_FOR_DELIVERY" },
      });

      return true;
    });

    if (result) started += 1;
  }

  await prisma.deliveryRun.update({
    where: { id: runId },
    data: { status: "STARTED", startedAt: new Date() },
  });

  return { ok: true, started };
}

/**
 * Recomputes the run's counters and its COD accountability.
 *
 * Derived from the tasks every time rather than incremented in place: a
 * counter that drifts from the rows underneath it is worse than no counter,
 * because day-end reconciliation trusts it.
 */
export async function recalculateRunTotals(
  runId: string,
  client: DbOrTx = prisma,
): Promise<void> {
  const tasks = await client.deliveryTask.findMany({
    where: { runId },
    select: { status: true, codAmount: true, shipmentId: true },
  });

  const codExpected = tasks
    .filter((task) => task.status !== "CANCELLED")
    .reduce((sum, task) => sum.plus(new Decimal(task.codAmount?.toString() ?? 0)), new Decimal(0));

  const shipmentIds = tasks.map((task) => task.shipmentId);
  const collected = shipmentIds.length
    ? await client.codCollection.aggregate({
        where: { shipmentId: { in: shipmentIds } },
        _sum: { amountCollected: true },
      })
    : { _sum: { amountCollected: null } };

  await client.deliveryRun.update({
    where: { id: runId },
    data: {
      totalTasks: tasks.filter((task) => task.status !== "CANCELLED").length,
      completedTasks: tasks.filter((task) => task.status === "DELIVERED").length,
      failedTasks: tasks.filter((task) => task.status === "FAILED").length,
      codExpected: codExpected.toFixed(2),
      codCollected: new Decimal(
        collected._sum.amountCollected?.toString() ?? 0,
      ).toFixed(2),
    },
  });
}

/** Closes the run once every stop has an outcome. */
export async function completeRun(
  runId: string,
  actor: SessionUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "delivery.execute")) {
    return { ok: false, error: "You do not have permission to close a run." };
  }

  const run = await prisma.deliveryRun.findUnique({
    where: { id: runId },
    select: {
      agentId: true,
      tasks: { where: { status: { in: ["PENDING", "OUT_FOR_DELIVERY"] } }, select: { id: true } },
    },
  });

  if (!run) return { ok: false, error: "That run does not exist." };
  if (actor.scope === "OWN" && run.agentId !== actor.id) {
    return { ok: false, error: "That run belongs to another agent." };
  }
  if (run.tasks.length > 0) {
    return {
      ok: false,
      error: `${run.tasks.length} stop${run.tasks.length > 1 ? "s have" : " has"} no outcome yet. Every one needs a delivery or a reason.`,
    };
  }

  await recalculateRunTotals(runId);
  await prisma.deliveryRun.update({
    where: { id: runId },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  return { ok: true };
}
