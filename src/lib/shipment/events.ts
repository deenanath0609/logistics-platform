import { randomUUID } from "node:crypto";
import { prisma, type Db } from "@/lib/prisma";
import type {
  EventSource,
  Prisma,
  ShipmentEventType,
  ShipmentStatus,
} from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { evaluateTransition, isTerminal } from "./state-machine";
import { enqueueOutbox } from "@/server/services/outbox";

/**
 * The single write path for shipment state.
 *
 * Everything that happens to a consignment arrives here: a dock scan, a
 * load onto a manifest, an OTP at the door. The sequence is always the
 * same — validate, deduplicate, append, project, emit — and all five
 * happen in one transaction so a crash cannot leave the status ahead of
 * or behind the event log.
 */

export type AppendEventInput = {
  shipmentId: string;
  eventType: ShipmentEventType;
  /** Set when the event concerns one package rather than the consignment. */
  packageId?: string | null;
  /**
   * When it actually happened, from the device clock. Defaults to now.
   * A field app syncing after an hour offline supplies the original time.
   */
  occurredAt?: Date;
  branchId?: string | null;
  vehicleId?: string | null;
  tripId?: string | null;
  manifestId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  deviceId?: string | null;
  reasonCodeId?: string | null;
  remarks?: string | null;
  attachmentId?: string | null;
  source?: EventSource;
  /**
   * The portal customer who caused this, when it originated on the
   * customer side. Recorded alongside the staff actor rather than instead
   * of it, so the timeline names a real person either way.
   */
  customerUserId?: string | null;
  payload?: Prisma.InputJsonValue;
  /**
   * Client-generated UUID. The offline queue retries, so the same event
   * may arrive several times; the unique index makes that harmless.
   */
  idempotencyKey?: string;
  /** Only for STATUS_CORRECTED. */
  correctedTo?: ShipmentStatus;
};

export type AppendEventResult =
  | {
      ok: true;
      eventId: string;
      previousStatus: ShipmentStatus;
      currentStatus: ShipmentStatus;
      statusChanged: boolean;
      /** True when this exact event had already been recorded. */
      duplicate: boolean;
    }
  | { ok: false; error: string; code: "FORBIDDEN" | "INVALID_TRANSITION" | "NOT_FOUND" };

export async function appendShipmentEvent(
  input: AppendEventInput,
  actor: SessionUser | null,
  /**
   * Pass a transaction client to number and event a shipment atomically.
   *
   * Narrower than `DbOrTx`, and `outboxEvent` is in the list even though
   * nothing here touches it directly: the emit at the end hands this same
   * client to `enqueueOutbox`.
   */
  client: Pick<Db, "shipment" | "shipmentEvent" | "outboxEvent"> = prisma,
): Promise<AppendEventResult> {
  const idempotencyKey = input.idempotencyKey ?? randomUUID();

  // `findFirst`, not `findUnique`: the key is now unique per carrier
  // rather than globally, and naming the compound key here would mean
  // writing the tenant into a `where` the extension already scopes.
  const existing = await client.shipmentEvent.findFirst({
    where: { idempotencyKey },
    select: { id: true, shipment: { select: { currentStatus: true } } },
  });

  if (existing) {
    // A retry from the offline queue. Report the current state rather than
    // writing a second copy or raising an error at the operator.
    return {
      ok: true,
      eventId: existing.id,
      previousStatus: existing.shipment.currentStatus,
      currentStatus: existing.shipment.currentStatus,
      statusChanged: false,
      duplicate: true,
    };
  }

  const shipment = await client.shipment.findUnique({
    where: { id: input.shipmentId },
    select: {
      id: true,
      // The event inherits the consignment's carrier rather than the
      // ambient one. They cannot disagree — this read was already
      // tenant-scoped — but stamping it from the parent is what makes the
      // event log's own isolation independent of the caller.
      orgId: true,
      lrNumber: true,
      currentStatus: true,
      originBranchId: true,
      destinationBranchId: true,
      attemptCount: true,
      serviceType: { select: { maxDeliveryAttempts: true } },
    },
  });

  if (!shipment) {
    return { ok: false, error: "That shipment does not exist.", code: "NOT_FOUND" };
  }

  const decision = evaluateTransition(
    input.eventType,
    {
      currentStatus: shipment.currentStatus,
      branchId: input.branchId,
      originBranchId: shipment.originBranchId,
      destinationBranchId: shipment.destinationBranchId,
      attemptCount: shipment.attemptCount,
      maxDeliveryAttempts: shipment.serviceType.maxDeliveryAttempts,
    },
    {
      branchId: input.branchId,
      userId: actor?.id,
      reasonCodeId: input.reasonCodeId,
      remarks: input.remarks,
      latitude: input.latitude,
    },
    input.correctedTo,
  );

  if (!decision.ok) {
    return { ok: false, error: decision.reason, code: "INVALID_TRANSITION" };
  }

  // System-generated events (geofence crossings, automatic closure) have no
  // actor and are not permission-checked; everything a human does is.
  const isSystem = input.source === "SYSTEM" || input.source === "GPS";
  if (!isSystem) {
    if (!actor) {
      return { ok: false, error: "Not signed in.", code: "FORBIDDEN" };
    }
    if (!can(actor, decision.rule.permission)) {
      return {
        ok: false,
        error: `You do not have permission to record "${decision.rule.describe}".`,
        code: "FORBIDDEN",
      };
    }
  }

  const occurredAt = input.occurredAt ?? new Date();
  const recordedAt = new Date();
  // Large drift means a device clock is wrong; the event is still accepted
  // (refusing it would lose the work) but flagged for review.
  const clockDriftSeconds = input.occurredAt
    ? Math.round((recordedAt.getTime() - occurredAt.getTime()) / 1000)
    : null;

  const nextStatus = decision.nextStatus;
  const previousStatus = shipment.currentStatus;

  const event = await client.shipmentEvent.create({
    data: {
      orgId: shipment.orgId,
      shipmentId: shipment.id,
      packageId: input.packageId ?? undefined,
      eventType: input.eventType,
      occurredAt,
      recordedAt,
      clockDriftSeconds,
      branchId: input.branchId ?? undefined,
      userId: actor?.id,
      customerUserId: input.customerUserId ?? undefined,
      vehicleId: input.vehicleId ?? undefined,
      tripId: input.tripId ?? undefined,
      manifestId: input.manifestId ?? undefined,
      latitude: input.latitude ?? undefined,
      longitude: input.longitude ?? undefined,
      deviceId: input.deviceId ?? undefined,
      reasonCodeId: input.reasonCodeId ?? undefined,
      remarks: input.remarks ?? undefined,
      attachmentId: input.attachmentId ?? undefined,
      source: input.source ?? "WEB",
      idempotencyKey,
      payload: input.payload,
      resultingStatus: nextStatus ?? undefined,
    },
    select: { id: true },
  });

  // ── Projection ────────────────────────────────────────────
  const projection: Prisma.ShipmentUpdateInput = {};

  if (nextStatus && nextStatus !== previousStatus) {
    projection.currentStatus = nextStatus;
    projection.statusUpdatedAt = occurredAt;
  }

  if (input.branchId) {
    // Custody follows the scan: after an inbound scan the goods are here.
    if (
      input.eventType === "INBOUND_SCAN" ||
      input.eventType === "GATE_IN" ||
      input.eventType === "UNLOADED"
    ) {
      projection.currentBranch = { connect: { id: input.branchId } };
    }
  }

  switch (input.eventType) {
    case "PICKUP_COMPLETED":
      projection.pickedUpAt = occurredAt;
      break;
    case "GATE_OUT":
      projection.dispatchedAt = occurredAt;
      break;
    case "DELIVERY_ATTEMPTED":
      projection.attemptCount = { increment: 1 };
      break;
    case "DELIVERED":
      projection.deliveredAt = occurredAt;
      break;
    case "HELD":
      projection.isOnHold = true;
      if (input.reasonCodeId) {
        projection.holdReason = { connect: { id: input.reasonCodeId } };
      }
      break;
    case "HOLD_RELEASED":
      projection.isOnHold = false;
      projection.holdReason = { disconnect: true };
      break;
    case "CANCELLED":
      projection.cancelledAt = occurredAt;
      if (input.reasonCodeId) {
        projection.cancelReason = { connect: { id: input.reasonCodeId } };
      }
      break;
    case "CLOSED":
      projection.closedAt = occurredAt;
      break;
  }

  if (Object.keys(projection).length > 0) {
    await client.shipment.update({
      where: { id: shipment.id },
      data: projection,
    });
  }

  // ── Emit ──────────────────────────────────────────────────
  // Written to the outbox inside this transaction, drained by a worker
  // afterwards. Nothing external is called here, so a dead SMS gateway
  // can never fail a dock scan.
  await enqueueOutbox(
    {
      eventType: `shipment.${input.eventType.toLowerCase()}`,
      aggregate: "Shipment",
      aggregateId: shipment.id,
      payload: {
        lrNumber: shipment.lrNumber,
        eventId: event.id,
        eventType: input.eventType,
        previousStatus,
        currentStatus: nextStatus ?? previousStatus,
        branchId: input.branchId ?? null,
        reasonCodeId: input.reasonCodeId ?? null,
        occurredAt: occurredAt.toISOString(),
      },
    },
    client,
  );

  return {
    ok: true,
    eventId: event.id,
    previousStatus,
    currentStatus: nextStatus ?? previousStatus,
    statusChanged: Boolean(nextStatus && nextStatus !== previousStatus),
    duplicate: false,
  };
}

/**
 * Rebuilds `currentStatus` by replaying the event log.
 *
 * Used by the CI fixture check and available to support when a status
 * looks wrong. If this ever disagrees with the stored projection, the
 * projection is what is broken — the events are the source of truth.
 */
export async function replayStatus(
  shipmentId: string,
): Promise<{ replayed: ShipmentStatus | null; stored: ShipmentStatus; matches: boolean }> {
  const shipment = await prisma.shipment.findUniqueOrThrow({
    where: { id: shipmentId },
    select: { currentStatus: true },
  });

  const events = await prisma.shipmentEvent.findMany({
    where: { shipmentId, resultingStatus: { not: null } },
    orderBy: [{ occurredAt: "asc" }, { recordedAt: "asc" }],
    select: { resultingStatus: true },
  });

  const replayed = events.at(-1)?.resultingStatus ?? null;

  return {
    replayed,
    stored: shipment.currentStatus,
    matches: replayed === shipment.currentStatus,
  };
}

/** True when the shipment can still accept operational events. */
export function isOpen(status: ShipmentStatus): boolean {
  return !isTerminal(status);
}
