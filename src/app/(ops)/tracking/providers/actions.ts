"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { recordAudit } from "@/server/services/audit";
import { knownProviderCodes } from "@/lib/tracking/providers";

/**
 * Telematics provider configuration.
 *
 * Guarded by `geofence.manage`, the sensitive permission in the tracking
 * module: whoever can point the fleet at a different telematics endpoint
 * can decide what the whole system believes about where its trucks are.
 *
 * Secrets go in and never come out. `apiKey` and `webhookSecret` are
 * writable here and are never selected by the read path, so no page, prop
 * or serialised payload can carry them to a browser. A blank field on
 * update means "leave it as it is" rather than "clear it" — the alternative
 * silently wipes a working integration the first time somebody edits the
 * polling interval.
 */

export type ProviderState = {
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

const optionalSecret = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().min(16, "Use at least 16 characters").max(200).nullable(),
);

const optionalUrl = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().url("That is not a valid URL").max(300).nullable(),
);

const schema = z.object({
  id: z.preprocess((v) => (v === "" ? null : v), z.string().nullable()),
  code: z
    .string()
    .trim()
    .min(2, "Give it a code")
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Lower case letters, digits and hyphens only"),
  name: z.string().trim().min(2, "Give it a name").max(120),
  mode: z.enum(["poll", "webhook"]),
  baseUrl: optionalUrl,
  apiKey: optionalSecret,
  webhookSecret: optionalSecret,
  pollIntervalSeconds: z.coerce
    .number()
    .int()
    .min(10, "Ten seconds is the floor — anything faster is a denial of service on the vendor")
    .max(3_600),
  isActive: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
});

export async function saveProviderAction(
  _prev: ProviderState,
  formData: FormData,
): Promise<ProviderState> {
  try {
    const actor = await authorize("geofence.manage");

    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const input = parsed.data;

    // A code with no adapter behind it produces a configuration that looks
    // healthy and polls nothing. Better to refuse it here than to discover
    // it when somebody asks why a truck has not moved since Tuesday.
    if (!knownProviderCodes().includes(input.code)) {
      return {
        error: `No adapter exists for "${input.code}". Available: ${knownProviderCodes().join(", ")}.`,
        fieldErrors: { code: "No adapter for this code" },
      };
    }

    const existing = input.id
      ? await prisma.trackingProviderConfig.findFirst({
          where: { id: input.id, orgId: actor.orgId },
          select: {
            id: true,
            code: true,
            name: true,
            mode: true,
            baseUrl: true,
            pollIntervalSeconds: true,
            isActive: true,
            apiKey: true,
            webhookSecret: true,
          },
        })
      : null;

    if (input.id && !existing) return { error: "That provider does not exist." };

    // A webhook provider with no secret is worse than a broken one: it is
    // not polled, because it is a push vendor, and its deliveries are never
    // matched either, because the endpoint identifies a sender by whichever
    // stored secret verifies the body and this row has none. The screen
    // shows "no secret" in red afterwards, which is the wrong moment — by
    // then the carrier's live map has silently stopped. Checked against the
    // stored secret as well as the typed one, because a blank field on an
    // edit means "leave it as it is": switching an existing poll row to
    // push used to slip through this on the strength of having an id.
    if (input.mode === "webhook" && !input.webhookSecret && !existing?.webhookSecret) {
      return {
        error:
          "A webhook provider needs a shared secret — an unsigned endpoint accepts anything, so this one would accept nothing and the vendor's deliveries would all be rejected.",
        fieldErrors: { webhookSecret: "Required for a webhook provider" },
      };
    }

    const data = {
      code: input.code,
      name: input.name,
      mode: input.mode,
      baseUrl: input.baseUrl,
      pollIntervalSeconds: input.pollIntervalSeconds,
      isActive: input.isActive,
      // Blank means unchanged, not cleared.
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.webhookSecret ? { webhookSecret: input.webhookSecret } : {}),
    };

    const saved = existing
      ? await prisma.trackingProviderConfig.update({
          where: { id: existing.id },
          data,
          select: { id: true, code: true },
        })
      : await prisma.trackingProviderConfig.create({
          data: { ...data, orgId: actor.orgId },
          select: { id: true, code: true },
        });

    await recordAudit({
      user: actor,
      action: existing ? "UPDATE" : "CREATE",
      entity: "TrackingProviderConfig",
      entityId: saved.id,
      entityRef: saved.code,
      // The audit trail redacts anything that looks like a secret, but the
      // values are not put in front of it in the first place.
      before: existing
        ? {
            code: existing.code,
            name: existing.name,
            mode: existing.mode,
            baseUrl: existing.baseUrl,
            pollIntervalSeconds: existing.pollIntervalSeconds,
            isActive: existing.isActive,
            hasApiKey: Boolean(existing.apiKey),
            hasWebhookSecret: Boolean(existing.webhookSecret),
          }
        : undefined,
      after: {
        code: input.code,
        name: input.name,
        mode: input.mode,
        baseUrl: input.baseUrl,
        pollIntervalSeconds: input.pollIntervalSeconds,
        isActive: input.isActive,
        apiKeyChanged: Boolean(input.apiKey),
        webhookSecretChanged: Boolean(input.webhookSecret),
      },
      reason: existing ? "Telematics provider updated" : "Telematics provider configured",
    });

    revalidatePath("/tracking/providers");
    revalidatePath("/tracking");

    return {
      ok: true,
      message: existing ? `${saved.code} updated.` : `${saved.code} configured.`,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to configure tracking providers." };
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      return {
        error: "A provider with that code already exists for this organisation.",
        fieldErrors: { code: "Already in use" },
      };
    }
    console.error("[tracking/provider save]", error);
    return { error: "Could not save that provider." };
  }
}

export async function toggleProviderAction(
  _prev: ProviderState,
  formData: FormData,
): Promise<ProviderState> {
  try {
    const actor = await authorize("geofence.manage");

    const id = String(formData.get("id") ?? "");
    const existing = await prisma.trackingProviderConfig.findFirst({
      where: { id, orgId: actor.orgId },
      select: { id: true, code: true, isActive: true },
    });
    if (!existing) return { error: "That provider does not exist." };

    await prisma.trackingProviderConfig.update({
      where: { id: existing.id },
      data: { isActive: !existing.isActive },
    });

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "TrackingProviderConfig",
      entityId: existing.id,
      entityRef: existing.code,
      before: { isActive: existing.isActive },
      after: { isActive: !existing.isActive },
      reason: existing.isActive
        ? "Telematics provider disabled"
        : "Telematics provider enabled",
    });

    revalidatePath("/tracking/providers");
    return {
      ok: true,
      message: existing.isActive ? `${existing.code} disabled.` : `${existing.code} enabled.`,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to configure tracking providers." };
    }
    console.error("[tracking/provider toggle]", error);
    return { error: "Could not change that provider." };
  }
}

/**
 * Replaces a webhook secret.
 *
 * Separate from the edit form on purpose. Rotating a shared secret breaks
 * every delivery until the vendor is updated too, and that is not something
 * to do by accident while changing a polling interval.
 */
export async function rotateWebhookSecretAction(
  _prev: ProviderState,
  formData: FormData,
): Promise<ProviderState> {
  try {
    const actor = await authorize("geofence.manage");

    const id = String(formData.get("id") ?? "");
    const secret = String(formData.get("webhookSecret") ?? "").trim();

    if (secret.length < 16) {
      return {
        error: "A shared secret needs at least 16 characters.",
        fieldErrors: { webhookSecret: "Too short" },
      };
    }

    const existing = await prisma.trackingProviderConfig.findFirst({
      where: { id, orgId: actor.orgId },
      select: { id: true, code: true, webhookSecret: true },
    });
    if (!existing) return { error: "That provider does not exist." };

    await prisma.trackingProviderConfig.update({
      where: { id: existing.id },
      data: { webhookSecret: secret },
    });

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "TrackingProviderConfig",
      entityId: existing.id,
      entityRef: existing.code,
      before: { hasWebhookSecret: Boolean(existing.webhookSecret) },
      after: { hasWebhookSecret: true, rotated: true },
      reason: "Webhook shared secret rotated",
    });

    revalidatePath("/tracking/providers");
    return {
      ok: true,
      message: `Secret rotated. Deliveries signed with the old one will be rejected from now on — update ${existing.code} at the vendor.`,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to configure tracking providers." };
    }
    console.error("[tracking/provider rotate]", error);
    return { error: "Could not rotate that secret." };
  }
}
