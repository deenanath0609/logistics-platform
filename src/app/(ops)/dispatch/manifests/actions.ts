"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  createManifest,
  addShipmentsToManifest,
  removeShipmentFromManifest,
  closeManifest,
  reopenManifest,
  setManifestTrip,
} from "@/lib/transport/manifest";

export type ManifestState = {
  ok?: boolean;
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

const createSchema = z.object({
  originBranchId: z.string().min(1, "Choose an origin"),
  destinationBranchId: z.string().min(1, "Choose a destination"),
  tripId: z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.string().nullable(),
  ),
  remarks: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(300).nullable(),
  ),
});

export async function createManifestAction(
  _prev: ManifestState,
  formData: FormData,
): Promise<ManifestState> {
  let destination: string;

  try {
    const actor = await authorize("manifest.create");

    const parsed = createSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const result = await createManifest(parsed.data, actor);
    if (!result.ok) {
      return {
        error: result.error,
        fieldErrors: result.field ? { [result.field]: result.error } : undefined,
      };
    }

    revalidatePath("/dispatch/manifests");
    destination = `/dispatch/manifests/${result.manifestId}`;
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to create manifests." };
    }
    console.error("[dispatch/manifest create]", error);
    return { error: "Could not create the manifest." };
  }

  redirect(destination);
}

const addSchema = z.object({
  manifestId: z.string().min(1),
  shipmentIds: z.array(z.string().min(1)).min(1, "Pick at least one consignment"),
});

export async function addShipmentsAction(
  _prev: ManifestState,
  formData: FormData,
): Promise<ManifestState> {
  try {
    const actor = await authorize("manifest.update");

    const parsed = addSchema.safeParse({
      manifestId: formData.get("manifestId"),
      shipmentIds: formData.getAll("shipmentIds").map(String),
    });

    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Pick a consignment." };
    }

    const result = await addShipmentsToManifest(parsed.data, actor);
    if (result.error) return { error: result.error };

    revalidatePath(`/dispatch/manifests/${parsed.data.manifestId}`);

    if (result.added.length === 0) {
      return {
        error: `Nothing was added. ${result.rejected.map((r) => `${r.lrNumber}: ${r.reason}`).join(" · ")}`,
      };
    }

    return {
      ok: true,
      message:
        result.rejected.length === 0
          ? `${result.added.length} consignment${result.added.length === 1 ? "" : "s"} added.`
          : `${result.added.length} added. Skipped — ${result.rejected.map((r) => `${r.lrNumber}: ${r.reason}`).join(" · ")}`,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to edit manifests." };
    }
    console.error("[dispatch/manifest add]", error);
    return { error: "Could not add those consignments." };
  }
}

const removeSchema = z.object({
  manifestId: z.string().min(1),
  shipmentId: z.string().min(1),
});

export async function removeShipmentAction(
  _prev: ManifestState,
  formData: FormData,
): Promise<ManifestState> {
  try {
    const actor = await authorize("manifest.update");

    const parsed = removeSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) return { error: "Check the form." };

    const result = await removeShipmentFromManifest(parsed.data, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`/dispatch/manifests/${parsed.data.manifestId}`);
    return { ok: true, message: `${result.lrNumber} removed.` };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to edit manifests." };
    }
    console.error("[dispatch/manifest remove]", error);
    return { error: "Could not remove that consignment." };
  }
}

export async function closeManifestAction(
  _prev: ManifestState,
  formData: FormData,
): Promise<ManifestState> {
  try {
    const actor = await authorize("manifest.close");

    const manifestId = String(formData.get("manifestId") ?? "");
    if (!manifestId) return { error: "Which manifest?" };

    const result = await closeManifest({ manifestId }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`/dispatch/manifests/${manifestId}`);
    revalidatePath("/dispatch/manifests");
    return { ok: true, message: `${result.number} closed for dispatch.` };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to close manifests." };
    }
    console.error("[dispatch/manifest close]", error);
    return { error: "Could not close the manifest." };
  }
}

export async function reopenManifestAction(
  _prev: ManifestState,
  formData: FormData,
): Promise<ManifestState> {
  try {
    const actor = await authorize("manifest.reopen");

    const manifestId = String(formData.get("manifestId") ?? "");
    const reason = String(formData.get("reason") ?? "");

    const result = await reopenManifest({ manifestId, reason }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`/dispatch/manifests/${manifestId}`);
    return { ok: true, message: "Reopened." };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to reopen manifests." };
    }
    console.error("[dispatch/manifest reopen]", error);
    return { error: "Could not reopen the manifest." };
  }
}

export async function setManifestTripAction(
  _prev: ManifestState,
  formData: FormData,
): Promise<ManifestState> {
  try {
    const actor = await authorize("manifest.update");

    const manifestId = String(formData.get("manifestId") ?? "");
    const rawTripId = String(formData.get("tripId") ?? "");

    const result = await setManifestTrip(
      { manifestId, tripId: rawTripId === "" ? null : rawTripId },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(`/dispatch/manifests/${manifestId}`);
    return { ok: true, message: rawTripId ? "Vehicle assigned." : "Vehicle removed." };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to edit manifests." };
    }
    console.error("[dispatch/manifest trip]", error);
    return { error: "Could not assign that trip." };
  }
}
