"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  recordDelivery,
  recordFailedAttempt,
  requestDeliveryOtp,
} from "@/lib/delivery/execute";
import { startRun, completeRun } from "@/lib/delivery/runs";

/**
 * The field surface's write path.
 *
 * Every action here is the far end of the offline queue: it arrives with a
 * client-generated `idempotencyKey` and an `occurredAt` from the device
 * clock, possibly hours after the agent tapped, and possibly twice. None of
 * it may fail on a repeat — see `src/lib/delivery/offline-queue.ts`.
 */

/** What the queue's transport hands back. Shapes `SendOutcome`. */
export type SyncOutcome =
  | { ok: true }
  | { ok: false; retry: false; error: string }
  | { ok: false; retry: true; error: string };

export type QueuedPayload = {
  id: string;
  kind: "DELIVER" | "FAILED_ATTEMPT" | "START_RUN" | "COMPLETE_RUN";
  occurredAt: string;
  payload: Record<string, unknown>;
};

const gps = z.object({
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  deviceId: z.string().nullable().optional(),
});

const deliverSchema = gps.extend({
  taskId: z.string().min(1),
  receiverName: z.string().trim().min(2, "Who received it?"),
  receiverRelation: z.string().trim().nullable().optional(),
  receiverPhone: z.string().trim().nullable().optional(),
  signatureDataUrl: z.string().nullable().optional(),
  photoDataUrl: z.string().nullable().optional(),
  otpCode: z.string().trim().nullable().optional(),
  remarks: z.string().trim().nullable().optional(),
  cod: z
    .object({
      amountCollected: z.number().nonnegative(),
      mode: z.enum(["CASH", "UPI", "CARD", "CHEQUE", "BANK_TRANSFER"]),
      reference: z.string().trim().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const failedSchema = gps.extend({
  taskId: z.string().min(1),
  reasonCodeId: z.string().min(1, "Choose a reason"),
  remarks: z.string().trim().nullable().optional(),
  photoDataUrl: z.string().nullable().optional(),
});

const runSchema = z.object({ runId: z.string().min(1) });

/**
 * Drains one queued action.
 *
 * The distinction that matters is `retry`. A closed run or a retired reason
 * code will never succeed however often it is sent, so it is reported back
 * as permanent and shown to the agent. Anything else — a dropped
 * connection, a restarting server — retries with backoff.
 */
export async function syncFieldAction(action: QueuedPayload): Promise<SyncOutcome> {
  try {
    const actor = await authorize("delivery.execute");
    const occurredAt = new Date(action.occurredAt);

    if (Number.isNaN(occurredAt.getTime())) {
      return { ok: false, retry: false, error: "That action has no valid timestamp." };
    }

    switch (action.kind) {
      case "DELIVER": {
        const parsed = deliverSchema.safeParse(action.payload);
        if (!parsed.success) {
          return { ok: false, retry: false, error: firstIssue(parsed.error) };
        }

        const result = await recordDelivery(
          {
            ...parsed.data,
            cod: parsed.data.cod ?? null,
            idempotencyKey: action.id,
            occurredAt,
          },
          actor,
        );

        if (!result.ok) return { ok: false, retry: false, error: result.error };

        revalidatePath("/delivery");
        revalidatePath(`/delivery/task/${parsed.data.taskId}`);
        return { ok: true };
      }

      case "FAILED_ATTEMPT": {
        const parsed = failedSchema.safeParse(action.payload);
        if (!parsed.success) {
          return { ok: false, retry: false, error: firstIssue(parsed.error) };
        }

        const result = await recordFailedAttempt(
          { ...parsed.data, idempotencyKey: action.id, occurredAt },
          actor,
        );

        if (!result.ok) return { ok: false, retry: false, error: result.error };

        revalidatePath("/delivery");
        revalidatePath(`/delivery/task/${parsed.data.taskId}`);
        return { ok: true };
      }

      case "START_RUN": {
        const parsed = runSchema.safeParse(action.payload);
        if (!parsed.success) {
          return { ok: false, retry: false, error: firstIssue(parsed.error) };
        }

        const result = await startRun(parsed.data.runId, actor);
        if (!result.ok) return { ok: false, retry: false, error: result.error };

        revalidatePath("/delivery");
        return { ok: true };
      }

      case "COMPLETE_RUN": {
        const parsed = runSchema.safeParse(action.payload);
        if (!parsed.success) {
          return { ok: false, retry: false, error: firstIssue(parsed.error) };
        }

        const result = await completeRun(parsed.data.runId, actor);
        if (!result.ok) return { ok: false, retry: false, error: result.error };

        revalidatePath("/delivery");
        return { ok: true };
      }

      default:
        return { ok: false, retry: false, error: "Unknown action." };
    }
  } catch (error) {
    if (error instanceof PermissionError) {
      return { ok: false, retry: false, error: "You are not allowed to do that." };
    }
    // Anything unhandled is assumed transient. Losing a delivery because a
    // pooled connection died is worse than syncing it twice.
    console.error("[field/sync]", error);
    return {
      ok: false,
      retry: true,
      error: error instanceof Error ? error.message : "Could not reach the server.",
    };
  }
}

/** Sends the consignee their delivery code. Needs a connection — no queue. */
export async function requestOtpAction(
  taskId: string,
): Promise<{ ok: true; sentTo: string; devCode?: string } | { ok: false; error: string }> {
  try {
    const actor = await authorize("delivery.execute");
    return await requestDeliveryOtp(taskId, actor);
  } catch (error) {
    if (error instanceof PermissionError) {
      return { ok: false, error: "You are not allowed to do that." };
    }
    console.error("[field/otp]", error);
    return { ok: false, error: "The code could not be sent. Try again in a moment." };
  }
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That action is not valid.";
}
