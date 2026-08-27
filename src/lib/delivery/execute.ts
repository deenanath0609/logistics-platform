import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import type { CodMode, Prisma } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { appendShipmentEvent } from "@/lib/shipment/events";
import { enqueueOutbox } from "@/server/services/outbox";
import { issueOtp, verifyOtp } from "@/lib/auth/otp";
import { getEnv } from "@/lib/env";
import { storeDataUrl } from "./assets";
import { recalculateRunTotals } from "./runs";
import { nextAction, validateAttemptCapture, type NextAction } from "./attempts";

/**
 * What happens at the door.
 *
 * Every function here is the end of an offline queue: the agent's phone
 * confirmed the action minutes or hours ago and is only now able to tell
 * the server. So each one takes a client-generated `idempotencyKey` and an
 * `occurredAt` from the device clock, and each one is safe to call twice
 * with the same key.
 *
 * See docs/BRD.html §A.10.
 */

/** Everything a field action carries regardless of what it is. */
export type FieldContext = {
  /** Client-generated UUID. The offline queue retries on this. */
  idempotencyKey: string;
  /** Device clock at the moment of the act, not of the sync. */
  occurredAt: Date;
  latitude?: number | null;
  longitude?: number | null;
  deviceId?: string | null;
};

type TaskForExecution = {
  id: string;
  runId: string | null;
  branchId: string;
  status: string;
  attemptNumber: number;
  codAmount: Prisma.Decimal | null;
  shipment: {
    id: string;
    lrNumber: string;
    currentStatus: string;
    attemptCount: number;
    paymentType: string;
    codAmount: Prisma.Decimal | null;
    consigneeName: string;
    consigneePhone: string;
    serviceType: { maxDeliveryAttempts: number };
  };
  run: { id: string; agentId: string; branchId: string } | null;
};

async function loadTask(
  taskId: string,
  actor: SessionUser,
): Promise<{ ok: true; task: TaskForExecution } | { ok: false; error: string }> {
  const task = await prisma.deliveryTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      runId: true,
      branchId: true,
      status: true,
      attemptNumber: true,
      codAmount: true,
      shipment: {
        select: {
          id: true,
          lrNumber: true,
          currentStatus: true,
          attemptCount: true,
          paymentType: true,
          codAmount: true,
          consigneeName: true,
          consigneePhone: true,
          serviceType: { select: { maxDeliveryAttempts: true } },
        },
      },
      run: { select: { id: true, agentId: true, branchId: true } },
    },
  });

  if (!task) return { ok: false, error: "That stop is not on any run." };

  // A field agent has OWN scope: their own run and nothing else. Enforced
  // here rather than in the page, so the server action is safe on its own.
  if (actor.scope === "OWN") {
    if (task.run?.agentId !== actor.id) {
      return { ok: false, error: "That stop belongs to another agent." };
    }
  } else if (!coversBranch(actor, task.branchId)) {
    return { ok: false, error: "That stop belongs to another branch." };
  }

  return { ok: true, task: task as TaskForExecution };
}

// ────────────────────────────────────────────────────────────
// OTP at the door
// ────────────────────────────────────────────────────────────

/**
 * Sends the consignee a delivery code.
 *
 * The code goes to the consignee's phone through the notification outbox —
 * never back to the agent's device, which would make the whole check
 * theatre. Until the SMS provider is connected in Phase 5, development
 * returns it so the field flow can be exercised end to end.
 */
export async function requestDeliveryOtp(
  taskId: string,
  actor: SessionUser,
): Promise<{ ok: true; sentTo: string; devCode?: string } | { ok: false; error: string }> {
  if (!can(actor, "delivery.execute")) {
    return { ok: false, error: "You do not have permission to deliver." };
  }

  const loaded = await loadTask(taskId, actor);
  if (!loaded.ok) return loaded;

  const { shipment } = loaded.task;
  const { code, expiresAt } = await issueOtp({
    destination: shipment.consigneePhone,
    purpose: "DELIVERY",
    referenceId: shipment.id,
  });

  await enqueueOutbox({
    eventType: "notification.delivery_otp",
    aggregate: "Shipment",
    aggregateId: shipment.id,
    payload: {
      lrNumber: shipment.lrNumber,
      destination: shipment.consigneePhone,
      code,
      expiresAt: expiresAt.toISOString(),
      channel: "SMS",
    },
  });

  return {
    ok: true,
    sentTo: maskPhone(shipment.consigneePhone),
    devCode: getEnv().NODE_ENV === "production" ? undefined : code,
  };
}

/** `98765 43210` becomes `98•••43210` — enough to confirm, not to dial. */
export function maskPhone(phone: string): string {
  if (phone.length < 6) return "•".repeat(phone.length);
  return `${phone.slice(0, 2)}${"•".repeat(phone.length - 7)}${phone.slice(-5)}`;
}

// ────────────────────────────────────────────────────────────
// Delivered
// ────────────────────────────────────────────────────────────

export type DeliverInput = FieldContext & {
  taskId: string;
  receiverName: string;
  receiverRelation?: string | null;
  receiverPhone?: string | null;
  /** PNG data URL from the signature canvas. */
  signatureDataUrl?: string | null;
  /** Compressed JPEG data URL from the camera. */
  photoDataUrl?: string | null;
  /** Present when the agent verified a code at the door. */
  otpCode?: string | null;
  remarks?: string | null;
  cod?: {
    amountCollected: number;
    mode: CodMode;
    reference?: string | null;
  } | null;
};

export type DeliverResult =
  | { ok: true; podId: string; duplicate: boolean }
  | { ok: false; error: string; field?: string };

/**
 * Records a delivery.
 *
 * Order matters: the evidence is stored, then the event is appended, then
 * the POD is bound to it. A weak signal can delay the PDF; it must never
 * delay the delivery confirmation, which is why the assets are written
 * first and the POD row simply points at them.
 */
export async function recordDelivery(
  input: DeliverInput,
  actor: SessionUser,
): Promise<DeliverResult> {
  if (!can(actor, "delivery.execute")) {
    return { ok: false, error: "You do not have permission to deliver." };
  }

  const loaded = await loadTask(input.taskId, actor);
  if (!loaded.ok) return loaded;
  const { task } = loaded;

  // The offline queue retries. A second arrival of the same delivery must
  // confirm, not fail and not double-write.
  const existing = await prisma.pod.findUnique({
    where: { taskId: task.id },
    select: { id: true },
  });
  if (existing) return { ok: true, podId: existing.id, duplicate: true };

  if (!input.receiverName.trim()) {
    return { ok: false, error: "Who received it?", field: "receiverName" };
  }

  // A signature or a photograph. Something has to prove the handover, and
  // "the agent said so" is not proof when a claim lands eighteen months on.
  if (!input.signatureDataUrl && !input.photoDataUrl) {
    return {
      ok: false,
      error: "Capture a signature or a photograph before marking this delivered.",
      field: "signature",
    };
  }

  const { shipment } = task;

  // ── COD must balance before the goods are released ─────────
  const codExpected = new Decimal(shipment.codAmount?.toString() ?? 0);
  const isCod = shipment.paymentType === "COD" && codExpected.greaterThan(0);

  if (isCod) {
    if (!input.cod) {
      return {
        ok: false,
        error: `₹${codExpected.toFixed(2)} is due on this shipment. Collect it before handing over.`,
        field: "cod",
      };
    }
    const collected = new Decimal(input.cod.amountCollected);
    if (collected.lessThan(codExpected)) {
      return {
        ok: false,
        error: `Short by ₹${codExpected.minus(collected).toFixed(2)}. A part collection needs a branch override.`,
        field: "cod",
      };
    }
  }

  // ── OTP ────────────────────────────────────────────────────
  let otpReference: string | null = null;
  let otpVerified = false;

  if (input.otpCode?.trim()) {
    otpVerified = await verifyOtp({
      destination: shipment.consigneePhone,
      purpose: "DELIVERY",
      code: input.otpCode.trim(),
      referenceId: shipment.id,
    });

    if (!otpVerified) {
      // Deliberately one message for wrong, expired, and used up — see
      // `verifyOtp`. Telling them which turns this into an oracle.
      return { ok: false, error: "That code is not valid.", field: "otpCode" };
    }

    otpReference = `OTP/${maskPhone(shipment.consigneePhone)}/${input.occurredAt.toISOString()}`;
  }

  // ── Evidence, before anything else ─────────────────────────
  let signatureAssetId: string | null = null;
  let photoAssetId: string | null = null;

  try {
    const signature = await storeDataUrl(input.signatureDataUrl, {
      kind: "POD_SIGNATURE",
      fileName: `${shipment.lrNumber}-signature.png`,
      ownerEntity: "Shipment",
      ownerId: shipment.id,
      orgId: actor.orgId,
      uploadedById: actor.id,
      capturedAt: input.occurredAt,
      latitude: input.latitude,
      longitude: input.longitude,
    });
    signatureAssetId = signature?.id ?? null;

    const photo = await storeDataUrl(input.photoDataUrl, {
      kind: "POD_PHOTO",
      fileName: `${shipment.lrNumber}-delivery.jpg`,
      ownerEntity: "Shipment",
      ownerId: shipment.id,
      orgId: actor.orgId,
      uploadedById: actor.id,
      capturedAt: input.occurredAt,
      latitude: input.latitude,
      longitude: input.longitude,
    });
    photoAssetId = photo?.id ?? null;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The capture could not be stored.",
    };
  }

  try {
    const podId = await prisma.$transaction(async (tx) => {
      await ensureOutForDelivery(task, actor, input, tx);

      const delivered = await appendShipmentEvent(
        {
          shipmentId: shipment.id,
          eventType: "DELIVERED",
          branchId: task.branchId,
          occurredAt: input.occurredAt,
          latitude: input.latitude,
          longitude: input.longitude,
          deviceId: input.deviceId,
          remarks: input.remarks,
          attachmentId: photoAssetId ?? signatureAssetId ?? undefined,
          source: "FIELD_APP",
          idempotencyKey: `${input.idempotencyKey}:delivered`,
          payload: {
            receiverName: input.receiverName,
            receiverRelation: input.receiverRelation ?? null,
            otpVerified,
            attemptNumber: task.attemptNumber,
          },
        },
        actor,
        tx,
      );

      if (!delivered.ok) throw new Error(delivered.error);

      // The successful visit is an attempt row too. Without it, the
      // first-attempt success rate has a numerator and no denominator.
      await tx.deliveryAttempt.create({
        data: {
          taskId: task.id,
          shipmentId: shipment.id,
          attemptNumber: task.attemptNumber,
          outcome: "COLLECTED",
          receiverName: input.receiverName,
          receiverRelation: input.receiverRelation ?? undefined,
          otpVerified,
          latitude: input.latitude ?? undefined,
          longitude: input.longitude ?? undefined,
          deviceId: input.deviceId ?? undefined,
          remarks: input.remarks ?? undefined,
          photoAssetId: photoAssetId ?? undefined,
          attemptedAt: input.occurredAt,
          agentId: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      });

      const pod = await tx.pod.create({
        data: {
          taskId: task.id,
          shipmentId: shipment.id,
          receiverName: input.receiverName.trim(),
          receiverRelation: input.receiverRelation ?? undefined,
          receiverPhone: input.receiverPhone ?? undefined,
          signatureAssetId: signatureAssetId ?? undefined,
          photoAssetId: photoAssetId ?? undefined,
          otpReference: otpReference ?? undefined,
          latitude: input.latitude ?? undefined,
          longitude: input.longitude ?? undefined,
          deliveredAt: input.occurredAt,
          agentId: actor.id,
          remarks: input.remarks ?? undefined,
        },
        select: { id: true },
      });

      const assets: Array<{ kind: "SIGNATURE" | "DELIVERY_PHOTO"; fileAssetId: string }> = [];
      if (signatureAssetId) assets.push({ kind: "SIGNATURE", fileAssetId: signatureAssetId });
      if (photoAssetId) assets.push({ kind: "DELIVERY_PHOTO", fileAssetId: photoAssetId });

      if (assets.length > 0) {
        await tx.podAsset.createMany({
          data: assets.map((asset) => ({
            podId: pod.id,
            kind: asset.kind,
            fileAssetId: asset.fileAssetId,
            capturedAt: input.occurredAt,
          })),
        });
      }

      // ── COD at the door ─────────────────────────────────────
      if (isCod && input.cod) {
        await tx.codCollection.create({
          data: {
            shipmentId: shipment.id,
            taskId: task.id,
            branchId: task.branchId,
            agentId: actor.id,
            amountExpected: codExpected.toFixed(2),
            amountCollected: new Decimal(input.cod.amountCollected).toFixed(2),
            mode: input.cod.mode,
            reference: input.cod.reference ?? undefined,
            collectedAt: input.occurredAt,
          },
        });

        const codEvent = await appendShipmentEvent(
          {
            shipmentId: shipment.id,
            eventType: "COD_COLLECTED",
            branchId: task.branchId,
            occurredAt: input.occurredAt,
            source: "FIELD_APP",
            idempotencyKey: `${input.idempotencyKey}:cod`,
            payload: {
              amount: new Decimal(input.cod.amountCollected).toFixed(2),
              mode: input.cod.mode,
              reference: input.cod.reference ?? null,
            },
          },
          actor,
          tx,
        );

        if (!codEvent.ok) throw new Error(codEvent.error);
      }

      // Assets arrived with this request, so the POD is complete already.
      // When uploads move to a background channel this event moves with
      // them and fires when the last asset lands.
      await appendShipmentEvent(
        {
          shipmentId: shipment.id,
          eventType: "POD_SYNCED",
          branchId: task.branchId,
          occurredAt: input.occurredAt,
          source: "FIELD_APP",
          idempotencyKey: `${input.idempotencyKey}:pod`,
          payload: { podId: pod.id, assets: assets.length },
        },
        actor,
        tx,
      );

      await tx.deliveryTask.update({
        where: { id: task.id },
        data: { status: "DELIVERED", completedAt: input.occurredAt },
      });

      await enqueueOutbox(
        {
          eventType: "delivery.completed",
          aggregate: "Shipment",
          aggregateId: shipment.id,
          payload: {
            lrNumber: shipment.lrNumber,
            podId: pod.id,
            receiverName: input.receiverName,
            attemptNumber: task.attemptNumber,
            firstAttempt: task.attemptNumber === 1,
            codCollected: isCod ? new Decimal(input.cod?.amountCollected ?? 0).toFixed(2) : null,
          },
        },
        tx,
      );

      return pod.id;
    });

    if (task.runId) await recalculateRunTotals(task.runId);

    return { ok: true, podId, duplicate: false };
  } catch (error) {
    // A unique-constraint hit here is the offline queue arriving twice at
    // once. Treat it as the success it is.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Unique constraint")) {
      const pod = await prisma.pod.findUnique({
        where: { taskId: task.id },
        select: { id: true },
      });
      if (pod) return { ok: true, podId: pod.id, duplicate: true };
    }
    console.error("[delivery] recordDelivery", error);
    return { ok: false, error: message };
  }
}

// ────────────────────────────────────────────────────────────
// Failed attempt
// ────────────────────────────────────────────────────────────

export type FailedAttemptInput = FieldContext & {
  taskId: string;
  reasonCodeId: string;
  remarks?: string | null;
  photoDataUrl?: string | null;
};

export type FailedAttemptResult =
  | {
      ok: true;
      attemptId: string;
      duplicate: boolean;
      /** What the reason row says happens next. Shown to the agent. */
      decision: NextAction;
      attemptCount: number;
    }
  | { ok: false; error: string; field?: string };

/**
 * Records a failed delivery attempt.
 *
 * This is the behaviour the whole module exists for. The shipment goes back
 * to `RECEIVED_AT_HUB` — it is physically at the branch again and still owed
 * a delivery — `attemptCount` goes up, and the attempt survives as its own
 * row forever. There is no "failed" status, because a failed attempt is not
 * a state the consignment is in.
 */
export async function recordFailedAttempt(
  input: FailedAttemptInput,
  actor: SessionUser,
): Promise<FailedAttemptResult> {
  if (!can(actor, "delivery.execute")) {
    return { ok: false, error: "You do not have permission to record attempts." };
  }

  const loaded = await loadTask(input.taskId, actor);
  if (!loaded.ok) return loaded;
  const { task } = loaded;

  const duplicate = await prisma.deliveryAttempt.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, shipment: { select: { attemptCount: true } } },
  });

  const reasonCode = await prisma.reasonCode.findUnique({
    where: { id: input.reasonCodeId },
    select: {
      id: true,
      code: true,
      name: true,
      category: true,
      isActive: true,
      isChargeable: true,
      triggersReattempt: true,
      triggersException: true,
      notifiesConsignor: true,
      notifiesConsignee: true,
      requiresPhoto: true,
      requiresRemarks: true,
    },
  });

  if (!reasonCode || !reasonCode.isActive || reasonCode.category !== "DELIVERY_FAILURE") {
    return { ok: false, error: "Choose a delivery failure reason.", field: "reasonCodeId" };
  }

  const { shipment } = task;

  if (duplicate) {
    return {
      ok: true,
      attemptId: duplicate.id,
      duplicate: true,
      attemptCount: duplicate.shipment.attemptCount,
      decision: nextAction(
        { attemptCount: duplicate.shipment.attemptCount },
        reasonCode,
        shipment.serviceType,
        { now: input.occurredAt },
      ),
    };
  }

  // ── Evidence the reason row demands ────────────────────────
  let photoAssetId: string | null = null;
  if (input.photoDataUrl) {
    try {
      const photo = await storeDataUrl(input.photoDataUrl, {
        kind: reasonCode.code.toUpperCase().includes("DAMAG") ? "DAMAGE_PHOTO" : "POD_PHOTO",
        fileName: `${shipment.lrNumber}-attempt-${task.attemptNumber}.jpg`,
        ownerEntity: "Shipment",
        ownerId: shipment.id,
        orgId: actor.orgId,
        uploadedById: actor.id,
        capturedAt: input.occurredAt,
        latitude: input.latitude,
        longitude: input.longitude,
      });
      photoAssetId = photo?.id ?? null;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "The photo could not be stored.",
        field: "photo",
      };
    }
  }

  const missing = validateAttemptCapture(reasonCode, {
    photoAssetId,
    remarks: input.remarks,
  });
  if (missing) {
    return { ok: false, error: missing, field: reasonCode.requiresPhoto && !photoAssetId ? "photo" : "remarks" };
  }

  const branchCalendar = await prisma.branch.findUnique({
    where: { id: task.branchId },
    select: { weeklyOffDays: true, openingTime: true },
  });

  try {
    const result = await prisma.$transaction(async (tx) => {
      await ensureOutForDelivery(task, actor, input, tx);

      const event = await appendShipmentEvent(
        {
          shipmentId: shipment.id,
          eventType: "DELIVERY_ATTEMPTED",
          branchId: task.branchId,
          occurredAt: input.occurredAt,
          latitude: input.latitude,
          longitude: input.longitude,
          deviceId: input.deviceId,
          reasonCodeId: reasonCode.id,
          remarks: input.remarks,
          attachmentId: photoAssetId ?? undefined,
          source: "FIELD_APP",
          idempotencyKey: `${input.idempotencyKey}:attempted`,
          payload: {
            attemptNumber: task.attemptNumber,
            reasonCode: reasonCode.code,
            reasonName: reasonCode.name,
          },
        },
        actor,
        tx,
      );

      if (!event.ok) throw new Error(event.error);

      const attempt = await tx.deliveryAttempt.create({
        data: {
          taskId: task.id,
          shipmentId: shipment.id,
          attemptNumber: task.attemptNumber,
          outcome: "FAILED",
          reasonCodeId: reasonCode.id,
          latitude: input.latitude ?? undefined,
          longitude: input.longitude ?? undefined,
          deviceId: input.deviceId ?? undefined,
          remarks: input.remarks ?? undefined,
          photoAssetId: photoAssetId ?? undefined,
          attemptedAt: input.occurredAt,
          agentId: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      });

      await tx.deliveryTask.update({
        where: { id: task.id },
        data: { status: "FAILED", completedAt: input.occurredAt },
      });

      // `attemptCount` was just incremented by the projection, so this is
      // the count including the attempt we have only now recorded.
      const attemptCount = shipment.attemptCount + 1;

      const decision = nextAction(
        { attemptCount },
        reasonCode,
        shipment.serviceType,
        {
          now: input.occurredAt,
          weeklyOffDays: branchCalendar?.weeklyOffDays ?? [],
          reattemptHour: parseHour(branchCalendar?.openingTime),
        },
      );

      // A reattempt is a new task carrying the next attempt number. It is
      // left unassigned for the branch to put on tomorrow's run.
      if (decision.action === "REATTEMPT") {
        await tx.deliveryTask.create({
          data: {
            shipmentId: shipment.id,
            branchId: task.branchId,
            status: "PENDING",
            attemptNumber: task.attemptNumber + 1,
            // Waiting longest sorts first on the next run.
            priority: 10 * (task.attemptNumber + 1),
            codAmount: task.codAmount ?? undefined,
          },
        });
      }

      await enqueueOutbox(
        {
          eventType: "delivery.attempt_failed",
          aggregate: "Shipment",
          aggregateId: shipment.id,
          payload: {
            lrNumber: shipment.lrNumber,
            attemptNumber: task.attemptNumber,
            attemptCount,
            reasonCode: reasonCode.code,
            reasonName: reasonCode.name,
            action: decision.action,
            scheduledFor: decision.scheduledFor?.toISOString() ?? null,
            notifyConsignor: decision.notifyConsignor,
            notifyConsignee: decision.notifyConsignee,
            chargeable: decision.chargeable,
            opensException: reasonCode.triggersException,
          },
        },
        tx,
      );

      return { attemptId: attempt.id, decision, attemptCount };
    });

    if (task.runId) await recalculateRunTotals(task.runId);

    return { ok: true, duplicate: false, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[delivery] recordFailedAttempt", error);
    return { ok: false, error: message };
  }
}

/**
 * Proposes the return to origin the attempt limit has earned.
 *
 * Separate permission, separate act. `nextAction` says RTO is due; a person
 * holding `delivery.rto` is what makes it happen, because a consignment
 * going back costs the customer money.
 */
export async function initiateRto(
  shipmentId: string,
  reasonCodeId: string,
  actor: SessionUser,
  remarks?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!can(actor, "delivery.rto")) {
    return { ok: false, error: "You do not have permission to return a shipment." };
  }

  const event = await appendShipmentEvent({
    shipmentId,
    eventType: "RTO_INITIATED",
    reasonCodeId,
    remarks,
    branchId: actor.primaryBranch?.id ?? null,
    idempotencyKey: crypto.randomUUID(),
  }, actor);

  if (!event.ok) return { ok: false, error: event.error };

  await prisma.deliveryTask.updateMany({
    where: { shipmentId, status: { in: ["PENDING", "OUT_FOR_DELIVERY"] } },
    data: { status: "RETURNED", completedAt: new Date() },
  });

  return { ok: true };
}

/**
 * Appends the out-scan if it never arrived.
 *
 * The agent taps "start run" in a loading bay with no signal, so that event
 * may still be sitting in the queue behind this one, or may have failed
 * permanently because someone closed the run at the desk. Either way the
 * parcel is demonstrably at the door: the missing `RUN_STARTED` is written
 * here rather than refusing the delivery, so the log stays complete and the
 * agent never has to care about the order things synced in.
 *
 * Keyed off the same client UUID, so a retry does not write it twice.
 */
async function ensureOutForDelivery(
  task: TaskForExecution,
  actor: SessionUser,
  input: FieldContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (task.shipment.currentStatus !== "ASSIGNED_FOR_DELIVERY") return;

  const outscan = await appendShipmentEvent(
    {
      shipmentId: task.shipment.id,
      eventType: "RUN_STARTED",
      branchId: task.branchId,
      occurredAt: input.occurredAt,
      deviceId: input.deviceId,
      source: "FIELD_APP",
      idempotencyKey: `${input.idempotencyKey}:outscan`,
      payload: { runId: task.runId, taskId: task.id, inferred: true },
    },
    actor,
    tx,
  );

  if (!outscan.ok) throw new Error(outscan.error);

  await tx.deliveryTask.update({
    where: { id: task.id },
    data: { status: "OUT_FOR_DELIVERY" },
  });
}

/** `"09:00"` → `9`. Falls back to the branch default. */
function parseHour(time: string | null | undefined): number {
  const hour = Number(time?.slice(0, 2));
  return Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : 9;
}
