"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { recordAudit } from "@/server/services/audit";
import { generateApiKey } from "@/lib/webhooks/api-key";
import { generateWebhookSecret, redeliver } from "@/lib/webhooks/dispatch";
import { ALLOWED_API_SCOPES } from "./scopes";
import type { ActionState } from "@/server/services/master-crud";

/**
 * Integration administration.
 *
 * Two secrets are minted here — an API key and a webhook signing secret —
 * and neither is ever readable again. The value is returned to the browser
 * once, in the action's result, and only its digest (or, for the webhook
 * secret, the value we must keep in order to sign) reaches the database.
 * Both actions are audited: issuing credentials is exactly the kind of
 * event somebody will want to reconstruct a year later.
 */

const KEYS_PATH = "/integrations/api-keys";
const HOOKS_PATH = "/integrations/webhooks";

export type KeyIssueState = ActionState & {
  /** The only time this value exists outside the partner's own store. */
  issuedKey?: string;
  issuedFor?: string;
};

export type HookState = ActionState & {
  secret?: string;
  secretFor?: string;
};

function describe(error: unknown, fallback: string): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to manage integrations.";
  }
  console.error("[integrations]", error);
  return fallback;
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

/** Comma, space or newline separated — however the operator pasted it. */
function splitList(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

// ────────────────────────────────────────────────────────────
// API keys
// ────────────────────────────────────────────────────────────

const keySchema = z.object({
  name: z.string().trim().min(3, "Name the integration").max(120),
  customerId: z
    .string()
    .trim()
    .max(40)
    .nullish()
    .transform((value) => (value ? value : null)),
  expiresAt: z
    .string()
    .trim()
    .nullish()
    .transform((value) => (value ? new Date(`${value}T23:59:59.999Z`) : null)),
});

export async function issueApiKey(
  _prev: KeyIssueState,
  formData: FormData,
): Promise<KeyIssueState> {
  try {
    const actor = await authorize("apikey.manage");

    const parsed = keySchema.safeParse({
      name: formData.get("name"),
      customerId: formData.get("customerId"),
      expiresAt: formData.get("expiresAt"),
    });

    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const scopes = splitList(formData.get("scopes")).filter((scope) =>
      ALLOWED_API_SCOPES.has(scope),
    );
    if (scopes.length === 0) {
      return { error: "Choose at least one scope. A key with none can do nothing." };
    }

    const ipAllowlist = splitList(formData.get("ipAllowlist"));
    const bad = ipAllowlist.find(
      (entry) => !/^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(entry),
    );
    if (bad) {
      return { error: `"${bad}" is not an address or CIDR block.` };
    }

    if (parsed.data.expiresAt && parsed.data.expiresAt.getTime() <= Date.now()) {
      return { error: "That expiry is already in the past." };
    }

    const generated = generateApiKey();

    const created = await prisma.apiKey.create({
      data: {
        orgId: actor.orgId,
        name: parsed.data.name,
        keyHash: generated.keyHash,
        keyPrefix: generated.keyPrefix,
        scopes,
        ipAllowlist,
        customerId: parsed.data.customerId ?? undefined,
        expiresAt: parsed.data.expiresAt ?? undefined,
        createdById: actor.id,
      },
      select: { id: true, name: true, keyPrefix: true },
    });

    // Sensitive by definition. The audit sanitiser redacts `keyHash`, so
    // the trail records that a key was issued and never its material.
    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "ApiKey",
      entityId: created.id,
      entityRef: created.keyPrefix,
      after: {
        name: created.name,
        keyPrefix: created.keyPrefix,
        scopes,
        ipAllowlist,
        customerId: parsed.data.customerId,
        expiresAt: parsed.data.expiresAt?.toISOString() ?? null,
      },
    });

    revalidatePath(KEYS_PATH);

    return {
      ok: true,
      message: `Key issued for ${created.name}. Copy it now — it cannot be shown again.`,
      issuedKey: generated.key,
      issuedFor: created.name,
    };
  } catch (error) {
    return { error: describe(error, "The key could not be issued.") };
  }
}

export async function revokeApiKey(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("apikey.manage");

    const id = String(formData.get("id") ?? "").trim();
    if (!id) return { error: "That key could not be identified." };

    const key = await prisma.apiKey.findUnique({
      where: { id },
      select: { id: true, name: true, keyPrefix: true, revokedAt: true },
    });
    if (!key) return { error: "That key no longer exists." };
    if (key.revokedAt) return { error: "That key is already revoked." };

    // Revoked, not deleted: the row is what explains a 401 in six months'
    // time, and what ties past calls to a named integration.
    await prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });

    await recordAudit({
      user: actor,
      action: "DELETE",
      entity: "ApiKey",
      entityId: key.id,
      entityRef: key.keyPrefix,
      before: { name: key.name, revokedAt: null },
      after: { name: key.name, revokedAt: new Date().toISOString() },
      reason: String(formData.get("reason") ?? "").trim() || undefined,
    });

    revalidatePath(KEYS_PATH);
    return { ok: true, message: `${key.name} is revoked. It stops working immediately.` };
  } catch (error) {
    return { error: describe(error, "The key could not be revoked.") };
  }
}

// ────────────────────────────────────────────────────────────
// Webhook subscriptions
// ────────────────────────────────────────────────────────────

/**
 * Endpoints we refuse to call.
 *
 * A webhook URL is a request our server makes on someone else's
 * instruction, which is the shape of every server-side request forgery.
 * Loopback, link-local and the cloud metadata address are refused
 * outright.
 */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "169.254.169.254",
  "metadata.google.internal",
]);

const PRIVATE_V4 =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function checkUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "That is not a valid URL." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Webhook endpoints must be https." };
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || PRIVATE_V4.test(host) || host.endsWith(".internal")) {
    return { ok: false, error: "That address is inside our own network." };
  }

  return { ok: true, url: parsed.toString() };
}

const hookSchema = z.object({
  name: z.string().trim().min(3, "Name the subscription").max(120),
  url: z.string().trim().min(8, "Give the endpoint URL"),
  customerId: z
    .string()
    .trim()
    .max(40)
    .nullish()
    .transform((value) => (value ? value : null)),
});

export async function createWebhookSubscription(
  _prev: HookState,
  formData: FormData,
): Promise<HookState> {
  try {
    const actor = await authorize("apikey.manage");

    const parsed = hookSchema.safeParse({
      name: formData.get("name"),
      url: formData.get("url"),
      customerId: formData.get("customerId"),
    });
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const url = checkUrl(parsed.data.url);
    if (!url.ok) return { error: url.error, fieldErrors: { url: url.error } };

    const events = splitList(formData.get("events"));
    if (events.length === 0) {
      return { error: "Subscribe to at least one event, or to `*` for everything." };
    }

    const secret = generateWebhookSecret();

    const created = await prisma.webhookSubscription.create({
      data: {
        orgId: actor.orgId,
        name: parsed.data.name,
        url: url.url,
        secret,
        events,
        customerId: parsed.data.customerId ?? undefined,
        createdById: actor.id,
      },
      select: { id: true, name: true },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "WebhookSubscription",
      entityId: created.id,
      entityRef: created.name,
      after: { name: created.name, url: url.url, events, customerId: parsed.data.customerId },
    });

    revalidatePath(HOOKS_PATH);

    return {
      ok: true,
      message: `${created.name} is subscribed. Copy the signing secret now.`,
      secret,
      secretFor: created.name,
    };
  } catch (error) {
    return { error: describe(error, "The subscription could not be created.") };
  }
}

export async function setWebhookPaused(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("apikey.manage");

    const id = String(formData.get("id") ?? "").trim();
    const paused = String(formData.get("paused") ?? "") === "true";
    if (!id) return { error: "That subscription could not be identified." };

    const subscription = await prisma.webhookSubscription.findUnique({
      where: { id },
      select: { id: true, name: true, pausedAt: true, failureCount: true },
    });
    if (!subscription) return { error: "That subscription no longer exists." };

    await prisma.webhookSubscription.update({
      where: { id },
      data: paused
        ? { pausedAt: new Date() }
        : // Resuming clears the streak, or the next failure would pause it
          // again immediately and the button would look broken.
          { pausedAt: null, failureCount: 0 },
    });

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "WebhookSubscription",
      entityId: id,
      entityRef: subscription.name,
      before: { pausedAt: subscription.pausedAt?.toISOString() ?? null },
      after: { pausedAt: paused ? new Date().toISOString() : null },
    });

    revalidatePath(HOOKS_PATH);
    revalidatePath(`${HOOKS_PATH}/${id}`);
    return {
      ok: true,
      message: paused
        ? `${subscription.name} is paused. Queued deliveries wait.`
        : `${subscription.name} is live again.`,
    };
  } catch (error) {
    return { error: describe(error, "The subscription could not be changed.") };
  }
}

export async function rotateWebhookSecret(
  _prev: HookState,
  formData: FormData,
): Promise<HookState> {
  try {
    const actor = await authorize("apikey.manage");

    const id = String(formData.get("id") ?? "").trim();
    if (!id) return { error: "That subscription could not be identified." };

    const subscription = await prisma.webhookSubscription.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!subscription) return { error: "That subscription no longer exists." };

    const secret = generateWebhookSecret();
    await prisma.webhookSubscription.update({ where: { id }, data: { secret } });

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "WebhookSubscription",
      entityId: id,
      entityRef: subscription.name,
      after: { secretRotated: true },
    });

    revalidatePath(`${HOOKS_PATH}/${id}`);
    return {
      ok: true,
      message: "Secret rotated. Deliveries signed with the old one will now fail verification.",
      secret,
      secretFor: subscription.name,
    };
  } catch (error) {
    return { error: describe(error, "The secret could not be rotated.") };
  }
}

export async function retryWebhookDelivery(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await authorize("apikey.manage");

    const id = String(formData.get("id") ?? "").trim();
    if (!id) return { error: "That delivery could not be identified." };

    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id },
      select: { id: true, subscriptionId: true, eventType: true },
    });
    if (!delivery) return { error: "That delivery no longer exists." };

    await redeliver(id);

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "WebhookDelivery",
      entityId: id,
      entityRef: delivery.eventType,
      after: { requeued: true },
    });

    revalidatePath(`${HOOKS_PATH}/${delivery.subscriptionId}`);
    return { ok: true, message: "Queued for another attempt." };
  } catch (error) {
    return { error: describe(error, "That delivery could not be re-queued.") };
  }
}
