"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  MANUAL_MOVEMENT_PERMISSION,
  MANUAL_TRACKING_PERMISSION,
  recordManualArrival,
  recordManualDeparture,
  recordManualPosition,
  resolveAlert,
} from "@/lib/tracking/manual";
import { pollOnce } from "@/lib/tracking/runtime";

/**
 * The manual half of the tracking phase.
 *
 * Every automatic event has an equivalent here, audited the same way and
 * recorded through the same `appendShipmentEvent` — differing only in
 * `source`, which is what lets a report separate a geofence arrival from a
 * typed one (docs/BRD.html §A.9).
 *
 * Movements need `trip.dispatch`; a position report and an alert closure
 * need only the tracking read. See the two constants in
 * `@/lib/tracking/manual` for why they differ.
 */

export type TrackingState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Consignments whose event was refused, so the branch can see why. */
  refused?: Array<{ lrNumber: string; reason: string }>;
};

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

const optionalDate = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? null : new Date(String(v))),
  z.date().nullable(),
);

const optionalText = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().max(300).nullable(),
);

const movementSchema = z.object({
  tripId: z.string().min(1, "No trip on this vehicle"),
  branchId: z.string().min(1, "Choose the branch"),
  occurredAt: optionalDate,
  remarks: optionalText,
});

async function movement(
  formData: FormData,
  direction: "ARRIVAL" | "DEPARTURE",
): Promise<TrackingState> {
  try {
    const actor = await authorize(MANUAL_MOVEMENT_PERMISSION);

    const parsed = movementSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const input = {
      tripId: parsed.data.tripId,
      branchId: parsed.data.branchId,
      occurredAt: parsed.data.occurredAt ?? undefined,
      remarks: parsed.data.remarks,
    };

    const result =
      direction === "ARRIVAL"
        ? await recordManualArrival(input, actor)
        : await recordManualDeparture(input, actor);

    if (!result.ok) return { error: result.error };

    revalidatePath("/tracking");
    revalidatePath(`/dispatch/trips/${parsed.data.tripId}`);

    return {
      ok: true,
      message:
        result.moved === 0
          ? "Recorded. No consignment changed status — they were already past this point."
          : `Recorded against ${result.moved} consignment${result.moved === 1 ? "" : "s"}.`,
      refused: result.refused.length > 0 ? result.refused.slice(0, 10) : undefined,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to record vehicle movements." };
    }
    console.error("[tracking/manual movement]", error);
    return { error: "Could not record that movement." };
  }
}

export async function recordManualArrivalAction(
  _prev: TrackingState,
  formData: FormData,
): Promise<TrackingState> {
  return movement(formData, "ARRIVAL");
}

export async function recordManualDepartureAction(
  _prev: TrackingState,
  formData: FormData,
): Promise<TrackingState> {
  return movement(formData, "DEPARTURE");
}

const positionSchema = z.object({
  vehicleId: z.string().min(1),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  occurredAt: optionalDate,
  remarks: optionalText,
});

export async function recordManualPositionAction(
  _prev: TrackingState,
  formData: FormData,
): Promise<TrackingState> {
  try {
    const actor = await authorize(MANUAL_TRACKING_PERMISSION);

    const parsed = positionSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return {
        error: "Check the coordinates.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const result = await recordManualPosition(
      {
        vehicleId: parsed.data.vehicleId,
        latitude: parsed.data.latitude,
        longitude: parsed.data.longitude,
        occurredAt: parsed.data.occurredAt ?? undefined,
        remarks: parsed.data.remarks,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath("/tracking");

    return {
      ok: true,
      message: result.nearestBranchCode
        ? `Position recorded, ${result.distanceKm?.toFixed(0) ?? "?"} km from ${result.nearestBranchCode}.`
        : "Position recorded.",
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to record vehicle positions." };
    }
    console.error("[tracking/manual position]", error);
    return { error: "Could not record that position." };
  }
}

export async function resolveAlertAction(
  _prev: TrackingState,
  formData: FormData,
): Promise<TrackingState> {
  try {
    const actor = await authorize(MANUAL_TRACKING_PERMISSION);

    const alertId = String(formData.get("alertId") ?? "");
    const note = String(formData.get("note") ?? "").trim() || null;
    if (!alertId) return { error: "No alert given." };

    const result = await resolveAlert(alertId, note, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath("/tracking");
    return { ok: true, message: "Alert closed." };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to close tracking alerts." };
    }
    console.error("[tracking/resolve alert]", error);
    return { error: "Could not close that alert." };
  }
}

/**
 * Pulls from the provider once, now.
 *
 * Worth a button of its own: somebody standing beside a newly fitted device
 * should not have to wait out a polling interval to find out whether it
 * works, and "nothing happened for thirty seconds" is a very poor way to
 * diagnose a fitment.
 */
export async function pollNowAction(
  _prev: TrackingState,
  _formData: FormData,
): Promise<TrackingState> {
  try {
    await authorize("geofence.manage");

    // Forced: the button exists precisely to jump the vendor's own interval.
    const result = await pollOnce({ force: true });
    revalidatePath("/tracking");
    revalidatePath("/tracking/providers");

    if (result.devices === 0) {
      return {
        ok: true,
        message: "No vehicle has a GPS device id on file, so there was nothing to poll.",
      };
    }

    const polled =
      `Polled ${result.devices} device(s) through ${result.providers} provider(s): ` +
      `${result.accepted} new fix(es), ${result.duplicates} duplicate(s), ` +
      `${result.fenceEvents} fence event(s), ${result.shipmentEvents} consignment event(s).`;

    // A vendor that refused is reported here rather than left as a quiet
    // zero. Whoever pressed this is standing next to a device asking whether
    // it works, and "0 new fixes" with no reason is the wrong answer to give
    // them when the reason is known.
    if (result.failures.length > 0) {
      const detail = result.failures
        .map((failure) => `${failure.code}: ${failure.message}`)
        .join("; ");

      return result.providers === 0
        ? { error: `No provider answered — ${detail}` }
        : { ok: true, message: `${polled} Not answering — ${detail}` };
    }

    return { ok: true, message: polled };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to poll the tracking provider." };
    }
    console.error("[tracking/poll now]", error);
    return {
      error: error instanceof Error ? error.message : "The poll failed.",
    };
  }
}
