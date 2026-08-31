"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  recordPickupCollected,
  recordPickupFailed,
  startPickup,
} from "@/lib/pickup/execute";

/**
 * The pickup executive's write path.
 *
 * Shaped like `(field)/delivery/actions.ts` because it is the same job seen
 * from the other end of the day: somebody on a pavement with one thumb and
 * an unreliable signal. Every action carries the queue's own id as its
 * idempotency key and the device's clock as the moment it happened, so a
 * retry is ordinary rather than exceptional.
 *
 * The one difference from delivery is what a failure costs. A delivery that
 * fails leaves the goods with us; a pickup that fails leaves them with the
 * consignor, who is now waiting and was promised. So the reason is required
 * — the state machine insists on it too — and the request is put back on
 * this executive's list for the next working day rather than closed.
 */

const gps = z.object({
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  deviceId: z.string().nullable().optional(),
});

const collectSchema = gps.extend({
  assignmentId: z.string().min(1),
  packagesCollected: z.coerce
    .number({ message: "Enter how many packages you collected" })
    .int()
    .min(1, "At least one package"),
  weightCollected: z.coerce.number().nonnegative().nullable().optional(),
  receiverName: z.string().trim().nullable().optional(),
  remarks: z.string().trim().nullable().optional(),
});

const failedSchema = gps.extend({
  assignmentId: z.string().min(1),
  reasonCodeId: z.string().min(1, "Choose a reason"),
  remarks: z.string().trim().nullable().optional(),
});

export type PickupActionState = {
  ok?: true;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

function describe(error: unknown): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to do that.";
  }
  console.error("[field/pickups]", error);
  return "Something went wrong. Nothing was saved.";
}

/**
 * Marks the executive as on the way.
 *
 * Deliberately not queued. It carries no evidence and nothing depends on
 * the exact second, so a tap that fails is a tap the person repeats — and
 * one fewer thing to reconcile later.
 */
export async function startPickupAction(
  _prev: PickupActionState,
  formData: FormData,
): Promise<PickupActionState> {
  try {
    const actor = await authorize("pickup.execute");
    const assignmentId = String(formData.get("assignmentId") ?? "");

    const result = await startPickup({ assignmentId }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath("/pickups/today");
    revalidatePath(`/pickups/task/${assignmentId}`);
    return { ok: true, message: "On the way." };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function collectPickupAction(
  _prev: PickupActionState,
  formData: FormData,
): Promise<PickupActionState> {
  try {
    const actor = await authorize("pickup.execute");

    const parsed = collectSchema.safeParse({
      assignmentId: formData.get("assignmentId"),
      packagesCollected: formData.get("packagesCollected"),
      weightCollected: formData.get("weightCollected") || null,
      receiverName: formData.get("receiverName") || null,
      remarks: formData.get("remarks") || null,
      latitude: numeric(formData.get("latitude")),
      longitude: numeric(formData.get("longitude")),
      deviceId: formData.get("deviceId")?.toString() || null,
    });

    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await recordPickupCollected(
      {
        ...parsed.data,
        // The form's own submission id. A second submit of the same form —
        // a thumb on a slow connection, the classic double tap — carries
        // the same key and writes nothing twice.
        idempotencyKey: String(formData.get("idempotencyKey") ?? crypto.randomUUID()),
        occurredAt: new Date(),
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath("/pickups/today");
    revalidatePath(`/pickups/task/${parsed.data.assignmentId}`);
    return {
      ok: true,
      message: result.alreadyRecorded
        ? "Already recorded."
        : `Collected — attempt ${result.attemptNumber}.`,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function failPickupAction(
  _prev: PickupActionState,
  formData: FormData,
): Promise<PickupActionState> {
  try {
    const actor = await authorize("pickup.execute");

    const parsed = failedSchema.safeParse({
      assignmentId: formData.get("assignmentId"),
      reasonCodeId: formData.get("reasonCodeId"),
      remarks: formData.get("remarks") || null,
      latitude: numeric(formData.get("latitude")),
      longitude: numeric(formData.get("longitude")),
      deviceId: formData.get("deviceId")?.toString() || null,
    });

    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await recordPickupFailed(
      {
        ...parsed.data,
        idempotencyKey: String(formData.get("idempotencyKey") ?? crypto.randomUUID()),
        occurredAt: new Date(),
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath("/pickups/today");
    revalidatePath(`/pickups/task/${parsed.data.assignmentId}`);
    return {
      ok: true,
      message: result.alreadyRecorded
        ? "Already recorded."
        : "Recorded. It comes back to you on the next working day.",
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

/** A form field that is either a number or absent; never `NaN`. */
function numeric(value: FormDataEntryValue | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
