"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { recordAudit } from "@/server/services/audit";
import { invalidateFenceCache } from "@/lib/tracking/context";

/**
 * Geofence maintenance.
 *
 * Two numbers on this screen decide how much of the operation is automated
 * and how much of it is noise, and both need tuning against a real yard
 * rather than a default.
 *
 * The radius has to enclose the whole site — a fence drawn on the gate
 * misses a truck parked at the back of the yard, and the arrival never
 * fires. Too wide and it catches the highway, and every passing vehicle
 * arrives.
 *
 * The debounce decides how many consecutive agreeing fixes are believed. A
 * busy hub on a main road wants three or four; a quiet depot at the end of a
 * lane is fine on two. Raising it costs one polling interval of latency and
 * buys silence.
 *
 * Both invalidate the pipeline's fence cache on save, so a change applies on
 * the next ping rather than up to a minute later — which matters when
 * somebody is standing in the yard watching for the arrival to appear.
 */

export type GeofenceState = {
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

const schema = z.object({
  id: z.preprocess((v) => (v === "" ? null : v), z.string().nullable()),
  branchId: z.string().min(1, "Choose the node this fence wraps"),
  name: z.string().trim().min(2, "Give it a name").max(120),
  radiusMeters: z.coerce
    .number()
    .int()
    .min(50, "Below fifty metres, GPS noise alone decides whether a truck is inside")
    .max(20_000, "A twenty-kilometre fence is a region, not a site"),
  debouncePings: z.coerce
    .number()
    .int()
    .min(1, "At least one ping has to agree")
    .max(20, "Twenty pings is ten minutes of latency on an arrival"),
  isActive: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
});

export async function saveGeofenceAction(
  _prev: GeofenceState,
  formData: FormData,
): Promise<GeofenceState> {
  try {
    const actor = await authorize("geofence.manage");

    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const input = parsed.data;

    const branch = await prisma.branch.findFirst({
      where: { id: input.branchId, orgId: actor.orgId, deletedAt: null },
      select: { id: true, code: true, name: true, latitude: true, longitude: true },
    });
    if (!branch) return { error: "That branch does not exist." };

    // A fence with no centre contains nothing and is silently useless. The
    // coordinates live on the branch, so this is where the gap shows up.
    if (branch.latitude == null || branch.longitude == null) {
      return {
        error: `${branch.code} has no coordinates on file. Set them on the branch first — a fence without a centre would sit there containing nothing.`,
        fieldErrors: { branchId: "No coordinates on this branch" },
      };
    }

    const existing = input.id
      ? await prisma.geofence.findUnique({
          where: { id: input.id },
          select: {
            id: true,
            name: true,
            radiusMeters: true,
            debouncePings: true,
            isActive: true,
            branchId: true,
          },
        })
      : null;

    if (input.id && !existing) return { error: "That geofence does not exist." };

    const data = {
      name: input.name,
      type: "CIRCLE" as const,
      branchId: branch.id,
      centerLat: branch.latitude,
      centerLng: branch.longitude,
      radiusMeters: input.radiusMeters,
      debouncePings: input.debouncePings,
      isActive: input.isActive,
    };

    const saved = existing
      ? await prisma.geofence.update({
          where: { id: existing.id },
          data,
          select: { id: true, name: true },
        })
      : // `orgId` only on the create — an update must not be able to move an
        // existing fence between carriers, and the extension refuses that
        // anyway. Same source as the branch lookup above.
        await prisma.geofence.create({
          data: { ...data, orgId: actor.orgId },
          select: { id: true, name: true },
        });

    // The pipeline caches fences for a minute. Drop it now so the change
    // applies on the very next ping.
    invalidateFenceCache();

    await recordAudit({
      user: actor,
      action: existing ? "UPDATE" : "CREATE",
      entity: "Geofence",
      entityId: saved.id,
      entityRef: saved.name,
      branchId: branch.id,
      before: existing
        ? {
            name: existing.name,
            radiusMeters: existing.radiusMeters,
            debouncePings: existing.debouncePings,
            isActive: existing.isActive,
          }
        : undefined,
      after: {
        name: input.name,
        branch: branch.code,
        radiusMeters: input.radiusMeters,
        debouncePings: input.debouncePings,
        isActive: input.isActive,
      },
      reason: existing
        ? "Geofence edited — changes what generates automatic arrivals"
        : "Geofence created",
    });

    revalidatePath("/tracking/geofences");
    revalidatePath("/tracking");

    return {
      ok: true,
      message: existing
        ? `${saved.name} updated. It applies from the next position report.`
        : `${saved.name} created. Vehicles entering it will now generate arrivals automatically.`,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to manage geofences." };
    }
    console.error("[tracking/geofence save]", error);
    return { error: "Could not save that geofence." };
  }
}
