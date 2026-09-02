"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { recordAudit, changedFields } from "@/server/services/audit";
import type { ActionState } from "@/server/services/master-crud";
import { zBool, zCode } from "@/server/services/master-crud";
import { validateTemplate } from "@/lib/notifications/render";
import { variablesForEvent } from "@/lib/notifications/variables";

const PATH = "/notifications/templates";

/**
 * Templates are master data, so this reads like the other master screens —
 * with one addition the shared CRUD helper cannot express: the body is
 * checked against the variables its trigger actually supplies. A template
 * that saves cleanly and then renders `{{podUrl}}` at a consignee is the
 * failure this exists to prevent.
 */
const schema = z.object({
  code: zCode(2, 40),
  channel: z.enum(["SMS", "EMAIL", "WHATSAPP", "PUSH", "IN_APP"]),
  eventType: z.string().trim().min(3, "Choose a trigger"),
  name: z.string().trim().min(3, "Required").max(160),
  language: z.string().trim().min(2).max(8).default("en"),
  subject: z.string().trim().max(300).optional(),
  body: z.string().trim().min(3, "The message cannot be empty").max(4000),
  variables: z.string().default(""),
  recipientKind: z.enum([
    "CONSIGNOR",
    "CONSIGNEE",
    "CUSTOMER_USER",
    "STAFF",
    "BRANCH",
  ]),
  dltTemplateId: z.string().trim().max(60).optional(),
  dltSenderId: z.string().trim().max(20).optional(),
  isActive: zBool,
});

type Parsed = z.infer<typeof schema>;

function toData(parsed: Parsed) {
  const declared = parsed.variables
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  return {
    code: parsed.code,
    channel: parsed.channel,
    eventType: parsed.eventType,
    name: parsed.name,
    language: parsed.language,
    subject: parsed.channel === "EMAIL" ? (parsed.subject || null) : null,
    body: parsed.body,
    variables: declared,
    recipientKind: parsed.recipientKind,
    dltTemplateId: parsed.dltTemplateId?.trim() || null,
    dltSenderId: parsed.dltSenderId?.trim().toUpperCase() || null,
    isActive: parsed.isActive,
  };
}

/** Placeholder checks, run server-side so the client form is not the guard. */
function templateIssues(parsed: Parsed): string | null {
  const declared = parsed.variables.split(",").map((n) => n.trim()).filter(Boolean);
  const supplied = new Set(
    variablesForEvent(parsed.eventType).map((spec) => spec.name),
  );

  const combined = validateTemplate(
    `${parsed.body}\n${parsed.subject ?? ""}`,
    declared,
  );
  if (!combined.ok) {
    return `The message uses ${combined.unknown.join(", ")}, which is not declared.`;
  }

  const unsupported = declared.filter((name) => !supplied.has(name));
  if (unsupported.length > 0) {
    return `${unsupported.join(", ")} is not supplied by that trigger. It would be sent as literal text.`;
  }

  return null;
}

/**
 * The one rule the toggle already enforced and the form did not.
 *
 * `setTemplateActive` refuses to switch on an SMS template with no DLT id,
 * because an Indian operator accepts and then drops one without a delivery
 * report. The edit dialog carries the same switch and went straight past
 * that check — so the guard was one click wide, and the way round it was
 * the more obvious of the two. Same refusal, same words, both doors.
 */
function dltIssue(parsed: Parsed): string | null {
  if (parsed.isActive && parsed.channel === "SMS" && !parsed.dltTemplateId?.trim()) {
    return "This SMS template has no DLT id. Activating it would send messages the operator drops silently. Save it inactive, register the text on the DLT portal, then switch it on.";
  }
  return null;
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

export async function createTemplate(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const user = await authorize("master.manage");

    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const issue = templateIssues(parsed.data) ?? dltIssue(parsed.data);
    if (issue) return { error: issue };

    const created = await prisma.notificationTemplate.create({
      // Stamped here rather than inside `toData`, which `updateTemplate`
      // shares — an edit has no business restating the owner.
      data: { ...toData(parsed.data), orgId: user.orgId },
      select: { id: true, code: true, channel: true, dltTemplateId: true },
    });

    await recordAudit({
      user,
      action: "CREATE",
      entity: "NotificationTemplate",
      entityId: created.id,
      entityRef: `${created.code}/${created.channel}`,
      after: toData(parsed.data),
    });

    revalidatePath(PATH);
    return {
      ok: true,
      message:
        created.channel === "SMS" && !created.dltTemplateId
          ? "Template created. It has no DLT id, so SMS sends will be refused."
          : "Template created.",
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function updateTemplate(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const user = await authorize("master.manage");

    const id = String(formData.get("id") ?? "");
    if (!id) return { error: "Nothing selected to update." };

    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const issue = templateIssues(parsed.data) ?? dltIssue(parsed.data);
    if (issue) return { error: issue };

    const before = await prisma.notificationTemplate.findUnique({ where: { id } });
    if (!before) return { error: "That template no longer exists." };

    const data = toData(parsed.data);
    const after = await prisma.notificationTemplate.update({ where: { id }, data });
    const diff = changedFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );

    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        user,
        action: "UPDATE",
        entity: "NotificationTemplate",
        entityId: id,
        entityRef: `${after.code}/${after.channel}`,
        before: diff.before,
        after: diff.after,
      });
    }

    revalidatePath(PATH);
    return { ok: true, message: "Template updated." };
  } catch (error) {
    return { error: describe(error) };
  }
}

/** Templates are deactivated, never deleted — the send log points at them. */
export async function setTemplateActive(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const user = await authorize("master.manage");

    const id = String(formData.get("id") ?? "");
    const isActive = formData.get("isActive") === "true";
    if (!id) return { error: "Nothing selected." };

    const before = await prisma.notificationTemplate.findUnique({
      where: { id },
      select: { isActive: true, code: true, channel: true, dltTemplateId: true },
    });
    if (!before) return { error: "That template no longer exists." };

    if (isActive && before.channel === "SMS" && !before.dltTemplateId) {
      return {
        error:
          "This SMS template has no DLT id. Activating it would send messages the operator drops silently.",
      };
    }

    await prisma.notificationTemplate.update({ where: { id }, data: { isActive } });

    await recordAudit({
      user,
      action: "UPDATE",
      entity: "NotificationTemplate",
      entityId: id,
      entityRef: `${before.code}/${before.channel}`,
      before: { isActive: before.isActive },
      after: { isActive },
    });

    revalidatePath(PATH);
    return {
      ok: true,
      message: `Template ${isActive ? "activated" : "deactivated"}.`,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

function describe(error: unknown): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to change notification templates.";
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unique constraint")) {
    return "A template with that code already exists for this channel and language.";
  }

  console.error("[notifications/templates]", error);
  return "Something went wrong saving that. The change was not applied.";
}
