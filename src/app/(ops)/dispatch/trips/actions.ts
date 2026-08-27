"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  createTrip,
  gateOut,
  gateIn,
  closeTrip,
  markVehicleReported,
} from "@/lib/transport/trip";
import { setManifestTrip } from "@/lib/transport/manifest";

export type TripState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Consignments whose gate event was refused, so the yard can act. */
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

const optionalId = z.preprocess(
  (v) => (v === "" || v === undefined ? null : v),
  z.string().nullable(),
);

const optionalDate = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? null : new Date(String(v))),
  z.date().nullable(),
);

const optionalInt = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? null : Number(v)),
  z.number().int().min(0).max(9_999_999).nullable(),
);

const createSchema = z.object({
  vehicleId: z.string().min(1, "Choose a vehicle"),
  driverId: optionalId,
  routeId: optionalId,
  originBranchId: z.string().min(1, "Choose an origin"),
  destinationBranchId: z.string().min(1, "Choose a destination"),
  plannedDepartureAt: optionalDate,
  plannedArrivalAt: optionalDate,
  ftlShipmentId: optionalId,
  sealNumber: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(40).nullable(),
  ),
  remarks: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(300).nullable(),
  ),
});

export async function createTripAction(
  _prev: TripState,
  formData: FormData,
): Promise<TripState> {
  let destination: string;

  try {
    const actor = await authorize("trip.create");

    const parsed = createSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const result = await createTrip(parsed.data, actor);
    if (!result.ok) {
      return {
        error: result.error,
        fieldErrors: result.field ? { [result.field]: result.error } : undefined,
      };
    }

    revalidatePath("/dispatch/trips");
    destination = `/dispatch/trips/${result.tripId}`;
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to plan trips." };
    }
    console.error("[dispatch/trip create]", error);
    return { error: "Could not plan the trip." };
  }

  redirect(destination);
}

export async function markReportedAction(
  _prev: TripState,
  formData: FormData,
): Promise<TripState> {
  try {
    const actor = await authorize("trip.dispatch");
    const tripId = String(formData.get("tripId") ?? "");

    const result = await markVehicleReported({ tripId }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`/dispatch/trips/${tripId}`);
    return { ok: true, message: "Vehicle reported at the gate." };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to update trips." };
    }
    console.error("[dispatch/trip reported]", error);
    return { error: "Could not update the trip." };
  }
}

const gateOutSchema = z.object({
  tripId: z.string().min(1),
  odometerKm: optionalInt,
  sealNumber: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(40).nullable(),
  ),
  remarks: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(300).nullable(),
  ),
});

export async function gateOutAction(
  _prev: TripState,
  formData: FormData,
): Promise<TripState> {
  try {
    const actor = await authorize("trip.dispatch");

    const parsed = gateOutSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the form.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await gateOut(parsed.data, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`/dispatch/trips/${parsed.data.tripId}`);
    revalidatePath("/dispatch/trips");
    revalidatePath("/dispatch/manifests");
    revalidatePath("/hub");

    return {
      ok: true,
      message: `${result.number} dispatched — ${result.moved} consignment${result.moved === 1 ? "" : "s"} on board.`,
      refused: result.refused,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to dispatch trips." };
    }
    console.error("[dispatch/trip gate-out]", error);
    return { error: "Gate-out failed. Nothing was dispatched." };
  }
}

const gateInSchema = z.object({
  tripId: z.string().min(1),
  branchId: z.string().min(1, "Which branch is receiving?"),
  odometerKm: optionalInt,
  sealIntact: z.enum(["yes", "no", "unknown"]).default("unknown"),
  remarks: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(300).nullable(),
  ),
});

export async function gateInAction(
  _prev: TripState,
  formData: FormData,
): Promise<TripState> {
  try {
    const actor = await authorize("trip.dispatch");

    const parsed = gateInSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the form.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await gateIn(
      {
        tripId: parsed.data.tripId,
        branchId: parsed.data.branchId,
        odometerKm: parsed.data.odometerKm,
        sealIntact:
          parsed.data.sealIntact === "unknown"
            ? undefined
            : parsed.data.sealIntact === "yes",
        remarks: parsed.data.remarks,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(`/dispatch/trips/${parsed.data.tripId}`);
    revalidatePath("/dispatch/trips");
    revalidatePath("/hub/inbound");
    revalidatePath("/hub");

    return {
      ok: true,
      message: `${result.number} arrived — ${result.moved} consignment${result.moved === 1 ? "" : "s"} at the gate. Open an inbound receipt to scan them off.`,
      refused: result.refused,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to receive trips." };
    }
    console.error("[dispatch/trip gate-in]", error);
    return { error: "Gate-in failed. Nothing was changed." };
  }
}

export async function closeTripAction(
  _prev: TripState,
  formData: FormData,
): Promise<TripState> {
  try {
    const actor = await authorize("trip.close");

    const tripId = String(formData.get("tripId") ?? "");
    const remarks = String(formData.get("remarks") ?? "").trim() || null;

    const result = await closeTrip({ tripId, remarks }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`/dispatch/trips/${tripId}`);
    revalidatePath("/dispatch/trips");
    return { ok: true, message: `${result.number} closed.` };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to close trips." };
    }
    console.error("[dispatch/trip close]", error);
    return { error: "Could not close the trip." };
  }
}

export async function attachManifestAction(
  _prev: TripState,
  formData: FormData,
): Promise<TripState> {
  try {
    const actor = await authorize("manifest.update");

    const tripId = String(formData.get("tripId") ?? "");
    const manifestId = String(formData.get("manifestId") ?? "");
    const detach = formData.get("detach") === "true";

    const result = await setManifestTrip(
      { manifestId, tripId: detach ? null : tripId },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(`/dispatch/trips/${tripId}`);
    revalidatePath(`/dispatch/manifests/${manifestId}`);
    return { ok: true, message: detach ? "Manifest detached." : "Manifest attached." };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to edit manifests." };
    }
    console.error("[dispatch/trip attach]", error);
    return { error: "Could not change the manifest." };
  }
}
