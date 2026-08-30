"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ConsoleFormState } from "@/components/platform/form-bits";
import {
  authorizeOperator,
  PlatformAuthError,
  PlatformPermissionError,
} from "@/lib/platform/session";
import { openGrant } from "@/lib/platform/impersonation";
import { setTaskDone } from "@/lib/platform/onboarding";
import {
  CREDENTIAL_SPECS,
  type CredentialKindCode,
} from "@/lib/platform/credential-specs";
import {
  clearTenantCredential,
  saveTenantCredential,
} from "@/lib/platform/tenant-credentials";
import {
  changeTenantStatus,
  updateTenantBranding,
  updateTenantIdentity,
  type LifecycleAction,
} from "@/lib/platform/tenants";

/**
 * Server actions for one tenant.
 *
 * Each does the same three things and nothing else: gate on a capability,
 * hand the work to a service, revalidate. No validation, no transaction
 * and no audit write lives here — those belong to `lib/platform`, which
 * owns them for every caller rather than for this page.
 */

function pathFor(orgId: string): string {
  return `/platform/tenants/${orgId}`;
}

/**
 * Turns the two ways an operator can be refused into something a form can
 * render. Anything else is a genuine fault and is left to throw.
 */
function describe(error: unknown): string {
  if (error instanceof PlatformPermissionError) {
    return "Your operator role does not allow that change.";
  }
  if (error instanceof PlatformAuthError) {
    return error.message;
  }
  console.error("[platform:tenant]", error);
  return "Something went wrong. The change was not applied.";
}

/** Empty string means "cleared", which for every one of these fields is null. */
const optional = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().nullable(),
);

const identitySchema = z.object({
  subdomain: z.string().trim().min(1, "A tenant must have a subdomain"),
  customDomain: optional,
  planId: optional,
});

export async function saveIdentity(
  orgId: string,
  _prev: ConsoleFormState,
  formData: FormData,
): Promise<ConsoleFormState> {
  try {
    const actor = await authorizeOperator("tenant.write");

    const parsed = identitySchema.safeParse({
      subdomain: formData.get("subdomain"),
      customDomain: formData.get("customDomain"),
      planId: formData.get("planId"),
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Check the details." };
    }

    const result = await updateTenantIdentity(orgId, parsed.data, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(pathFor(orgId));
    revalidatePath("/platform/tenants");
    return { ok: true, message: `Now served at ${result.data.subdomain}.` };
  } catch (error) {
    return { error: describe(error) };
  }
}

const brandingSchema = z.object({
  primaryColorHex: optional,
  accentColorHex: optional,
  logoUrl: optional,
  faviconUrl: optional,
  documentFooter: optional,
  termsText: optional,
  supportEmail: optional,
  supportPhone: optional,
  dltSenderId: optional,
  smtpFrom: optional,
  whatsappNumber: optional,
});

export async function saveBranding(
  orgId: string,
  _prev: ConsoleFormState,
  formData: FormData,
): Promise<ConsoleFormState> {
  try {
    const actor = await authorizeOperator("tenant.write");

    const parsed = brandingSchema.safeParse(
      Object.fromEntries(
        Object.keys(brandingSchema.shape).map((key) => [key, formData.get(key)]),
      ),
    );
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Check the details." };
    }

    const result = await updateTenantBranding(orgId, parsed.data, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(pathFor(orgId));
    return { ok: true, message: "White-label settings saved." };
  } catch (error) {
    return { error: describe(error) };
  }
}

/**
 * One carrier's account with one outside service.
 *
 * Save and clear share a form and an action, chosen by the button's own
 * value, because they share the fields: the confirmation an operator needs
 * before clearing is about the settings they are looking at.
 *
 * The secret is read from the form and passed straight through. It is not
 * logged, not put in the returned state, and not echoed into a message —
 * a server-action return value is serialised to the browser, which is the
 * one place a key must never come back to.
 */
export async function saveCredential(
  orgId: string,
  kind: CredentialKindCode,
  _prev: ConsoleFormState,
  formData: FormData,
): Promise<ConsoleFormState> {
  try {
    const actor = await authorizeOperator("tenant.write");
    const spec = CREDENTIAL_SPECS[kind];

    if (formData.get("intent") === "clear") {
      const result = await clearTenantCredential(orgId, kind, actor);
      if (!result.ok) return { error: result.error };

      revalidatePath(pathFor(orgId));
      return {
        ok: true,
        message: `${spec.title} cleared — this carrier is back on the platform's shared account.`,
      };
    }

    const settings = Object.fromEntries(
      spec.fields.map((field) => [field.name, String(formData.get(field.name) ?? "")]),
    );

    // An empty secret box means "leave the stored one alone", which is what
    // makes a settings edit possible without re-typing a key nobody can
    // read back off the screen.
    const typed = String(formData.get("secret") ?? "").trim();

    const result = await saveTenantCredential(
      orgId,
      kind,
      { settings, secret: typed || null },
      actor,
    );
    if (!result.ok) return { error: result.error };

    revalidatePath(pathFor(orgId));
    return {
      ok: true,
      message: result.data.rotated
        ? `${spec.title} saved, and the key was replaced.`
        : `${spec.title} saved.`,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

const LIFECYCLE = new Set<LifecycleAction>(["activate", "suspend", "close"]);

export async function runLifecycle(
  orgId: string,
  _prev: ConsoleFormState,
  formData: FormData,
): Promise<ConsoleFormState> {
  try {
    const actor = await authorizeOperator("tenant.lifecycle");

    const action = String(formData.get("action") ?? "") as LifecycleAction;
    if (!LIFECYCLE.has(action)) return { error: "Unknown lifecycle action." };

    const result = await changeTenantStatus(
      orgId,
      action,
      String(formData.get("reason") ?? ""),
      actor,
    );
    if (!result.ok) return { error: result.error };

    revalidatePath(pathFor(orgId));
    revalidatePath("/platform/tenants");
    revalidatePath("/platform");
    return { ok: true, message: `Tenant is now ${result.data.status.toLowerCase()}.` };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function toggleOnboardingTask(
  orgId: string,
  _prev: ConsoleFormState,
  formData: FormData,
): Promise<ConsoleFormState> {
  try {
    const actor = await authorizeOperator("onboarding.write");

    const taskId = String(formData.get("taskId") ?? "");
    const isDone = formData.get("isDone") === "true";
    if (!taskId) return { error: "Which task?" };

    const result = await setTaskDone(taskId, isDone, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(pathFor(orgId));
    revalidatePath("/platform/tenants");
    return { ok: true };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function openSupportSession(
  orgId: string,
  _prev: ConsoleFormState,
  formData: FormData,
): Promise<ConsoleFormState> {
  try {
    const actor = await authorizeOperator("impersonate");

    const asUserId = String(formData.get("asUserId") ?? "");

    const result = await openGrant(
      {
        orgId,
        reason: String(formData.get("reason") ?? ""),
        minutes: Number(formData.get("minutes") ?? 30),
        // Checkbox semantics: absent means unchecked means read-only. The
        // default has to be the safe one at every layer, not just in the
        // schema.
        allowWrites: formData.get("allowWrites") === "on",
        asUserId: asUserId || null,
      },
      actor,
    );
    if (!result.ok) return { error: result.error };

    revalidatePath(pathFor(orgId));
    revalidatePath("/platform/impersonation");
    revalidatePath("/platform");
    return {
      ok: true,
      message: `Support session open until ${result.data.expiresAt.toLocaleTimeString()}.`,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}
