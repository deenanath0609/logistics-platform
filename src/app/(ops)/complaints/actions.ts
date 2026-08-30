"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  addMessage,
  createComplaint,
  transitionComplaint,
} from "@/lib/complaints/service";

/**
 * Server actions for the complaint screens.
 *
 * Thin: every one of them authorises, parses, and hands off to the service,
 * which owns the transaction and the audit row. Nothing here decides
 * whether a transition is legal — `workflow.ts` does, once, for both the
 * buttons and the guard.
 */

export type ComplaintActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Set on a successful create so the caller can navigate to it. */
  id?: string;
};

const PATH = "/complaints";

const CATEGORIES = [
  "DELAY",
  "DAMAGE",
  "MISSING",
  "WRONG_DELIVERY",
  "BILLING",
  "POD_ISSUE",
  "PICKUP_ISSUE",
  "BEHAVIOUR",
  "OTHER",
] as const;

const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;

const STATUSES = [
  "OPEN",
  "ASSIGNED",
  "INVESTIGATING",
  "ACTION_TAKEN",
  "RESOLVED",
  "CLOSED",
  "REOPENED",
] as const;

const optional = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().nullable(),
);

const createSchema = z.object({
  category: z.enum(CATEGORIES, { message: "Choose a category" }),
  priority: z.enum(PRIORITIES).default("NORMAL"),
  subject: z.string().trim().min(5, "Say what this is about").max(200),
  description: z.string().trim().min(10, "Describe what happened").max(4000),
  lrNumber: optional,
  assignedToId: optional,
});

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

export async function createComplaintAction(
  _prev: ComplaintActionState,
  formData: FormData,
): Promise<ComplaintActionState> {
  try {
    const actor = await authorize("complaint.create");

    const parsed = createSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    // The LR is typed, not picked: a complaint often arrives by phone with
    // the consignment note read out, and forcing a lookup first would make
    // logging it slower than not logging it.
    let shipmentId: string | null = null;
    if (parsed.data.lrNumber) {
      const { prisma } = await import("@/lib/prisma");
      // An LR number is unique per carrier rather than globally, so this is
      // a scoped lookup — the extension supplies the org.
      const shipment = await prisma.shipment.findFirst({
        where: { lrNumber: parsed.data.lrNumber.trim() },
        select: { id: true },
      });
      if (!shipment) {
        return {
          error: "No consignment with that LR number.",
          fieldErrors: { lrNumber: "Not found" },
        };
      }
      shipmentId = shipment.id;
    }

    const result = await createComplaint(
      {
        category: parsed.data.category,
        priority: parsed.data.priority,
        subject: parsed.data.subject,
        description: parsed.data.description,
        shipmentId,
        assignedToId: parsed.data.assignedToId,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(PATH);
    return {
      ok: true,
      id: result.data.id,
      message: `Complaint ${result.data.number} logged.`,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

const messageSchema = z.object({
  complaintId: z.string().min(1),
  body: z.string().trim().min(1, "Nothing to send").max(4000),
  // Absent means internal. The checkbox has to be ticked deliberately for a
  // message to reach the customer, which matches the column's default.
  visibility: z.enum(["internal", "customer"]).default("internal"),
});

export async function addMessageAction(
  _prev: ComplaintActionState,
  formData: FormData,
): Promise<ComplaintActionState> {
  try {
    const actor = await authorize("complaint.create");

    const parsed = messageSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await addMessage(
      {
        complaintId: parsed.data.complaintId,
        body: parsed.data.body,
        isInternal: parsed.data.visibility === "internal",
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${parsed.data.complaintId}`);
    return {
      ok: true,
      message:
        parsed.data.visibility === "internal"
          ? "Internal note added. The customer cannot see it."
          : "Reply sent to the customer.",
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

const transitionSchema = z.object({
  complaintId: z.string().min(1),
  to: z.enum(STATUSES),
  note: optional,
  assignedToId: optional,
});

export async function transitionAction(
  _prev: ComplaintActionState,
  formData: FormData,
): Promise<ComplaintActionState> {
  try {
    // The specific permission each transition needs is checked inside the
    // service against the workflow table; this is the floor.
    const actor = await authorize("complaint.read");

    const parsed = transitionSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await transitionComplaint(
      {
        complaintId: parsed.data.complaintId,
        to: parsed.data.to,
        note: parsed.data.note,
        assignedToId: parsed.data.assignedToId,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${parsed.data.complaintId}`);
    revalidatePath(PATH);
    return { ok: true, message: "Complaint updated." };
  } catch (error) {
    return { error: describe(error) };
  }
}

function describe(error: unknown): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to do that.";
  }
  console.error("[complaints/actions]", error);
  return "Something went wrong. Nothing was changed.";
}
