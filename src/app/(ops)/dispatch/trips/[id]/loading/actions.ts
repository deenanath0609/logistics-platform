"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  openLoadingSheet,
  scanToLoad,
  closeLoadingSheet,
  unload,
} from "@/lib/transport/loading";
import type { ScanOutcome } from "@/lib/hub/scan";

export type LoadingState = { ok?: boolean; message?: string; error?: string };

export async function openSheetAction(
  _prev: LoadingState,
  formData: FormData,
): Promise<LoadingState> {
  let destination: string;

  try {
    const actor = await authorize("loading.execute");
    const tripId = String(formData.get("tripId") ?? "");

    const result = await openLoadingSheet({ tripId }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`/dispatch/trips/${tripId}/loading`);
    destination = `/dispatch/trips/${tripId}/loading`;
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to load vehicles." };
    }
    console.error("[dispatch/loading open]", error);
    return { error: "Could not open a loading sheet." };
  }

  redirect(destination);
}

const scanSchema = z.object({
  loadingSheetId: z.string().min(1),
  barcode: z.string().trim().min(1).max(120),
  idempotencyKey: z.string().uuid(),
  deviceId: z.string().nullish(),
  scannedAt: z.string().datetime().nullish(),
});

export type LoadScanActionResult =
  | { ok: true; outcome: ScanOutcome; loadedPackages: number; expectedPackages: number }
  | { ok: false; error: string };

export async function scanToLoadAction(
  input: z.input<typeof scanSchema>,
): Promise<LoadScanActionResult> {
  const parsed = scanSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Bad scan." };
  }

  try {
    const actor = await authorize("loading.execute");

    const result = await scanToLoad(
      {
        loadingSheetId: parsed.data.loadingSheetId,
        barcode: parsed.data.barcode,
        idempotencyKey: parsed.data.idempotencyKey,
        deviceId: parsed.data.deviceId ?? null,
        scannedAt: parsed.data.scannedAt ? new Date(parsed.data.scannedAt) : undefined,
      },
      actor,
    );

    if (!result.ok) return { ok: false, error: result.error };

    return {
      ok: true,
      outcome: result.result.outcome,
      loadedPackages: result.result.loadedPackages,
      expectedPackages: result.result.expectedPackages,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { ok: false, error: "You do not have permission to load vehicles." };
    }
    console.error("[dispatch/loading scan]", error);
    return { ok: false, error: "The scan could not be recorded. Try again." };
  }
}

export async function unloadAction(
  _prev: LoadingState,
  formData: FormData,
): Promise<LoadingState> {
  try {
    const actor = await authorize("loading.execute");

    const loadingSheetId = String(formData.get("loadingSheetId") ?? "");
    const packageId = String(formData.get("packageId") ?? "");
    const tripId = String(formData.get("tripId") ?? "");

    const result = await unload({ loadingSheetId, packageId }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`/dispatch/trips/${tripId}/loading`);
    return { ok: true, message: "Taken back off the vehicle." };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to load vehicles." };
    }
    console.error("[dispatch/loading unload]", error);
    return { error: "Could not remove that package." };
  }
}

export async function closeSheetAction(
  _prev: LoadingState,
  formData: FormData,
): Promise<LoadingState> {
  try {
    const actor = await authorize("loading.execute");

    const loadingSheetId = String(formData.get("loadingSheetId") ?? "");
    const tripId = String(formData.get("tripId") ?? "");

    const result = await closeLoadingSheet({ loadingSheetId }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`/dispatch/trips/${tripId}/loading`);
    revalidatePath(`/dispatch/trips/${tripId}`);

    return {
      ok: true,
      message: `Sheet closed — ${result.loadedPackages} package${result.loadedPackages === 1 ? "" : "s"} on the vehicle. The trip can gate out.`,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to load vehicles." };
    }
    console.error("[dispatch/loading close]", error);
    return { error: "Could not close the sheet." };
  }
}
