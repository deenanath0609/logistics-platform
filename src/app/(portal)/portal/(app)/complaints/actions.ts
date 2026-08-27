"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  authorizeCustomer,
  canWrite,
  CustomerAuthError,
} from "@/lib/auth/customer-session";
import {
  isPortalCategory,
  raisePortalComplaint,
  replyToPortalComplaint,
} from "@/lib/portal/complaints";

/**
 * Complaint actions for the portal.
 *
 * Every one of them starts at `authorizeCustomer()`, which resolves the
 * account from the session and nowhere else. Nothing here reads a customer
 * id from the form — there is no field for one, and if there were it would
 * not be used: the scoping happens inside `src/lib/portal/complaints.ts`,
 * in the same query that finds the record.
 */

export type ComplaintState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

const PATH = "/portal/complaints";

const raiseSchema = z.object({
  category: z.string().refine(isPortalCategory, "Choose what it is about"),
  subject: z.string().trim().min(3, "A short summary, please").max(200),
  description: z
    .string()
    .trim()
    .min(10, "Tell us what happened")
    .max(4000, "That is longer than we can store — 4,000 characters"),
  shipmentId: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().nullable(),
  ),
});

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

export async function raiseComplaint(
  _prev: ComplaintState,
  formData: FormData,
): Promise<ComplaintState> {
  let destination: string;

  try {
    const session = await authorizeCustomer();
    if (!canWrite(session)) {
      return {
        error:
          "Your login can follow complaints but not raise them. Ask your account owner.",
      };
    }

    const parsed = raiseSchema.safeParse({
      category: formData.get("category"),
      subject: formData.get("subject"),
      description: formData.get("description"),
      shipmentId: formData.get("shipmentId"),
    });

    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const result = await raisePortalComplaint(session, {
      category: parsed.data.category,
      subject: parsed.data.subject,
      description: parsed.data.description,
      shipmentId: parsed.data.shipmentId,
    });

    if (!result.ok) {
      return {
        error: result.error,
        fieldErrors: result.field ? { [result.field]: result.error } : undefined,
      };
    }

    revalidatePath(PATH);
    revalidatePath("/portal");
    destination = `${PATH}/${result.id}`;
  } catch (error) {
    if (error instanceof CustomerAuthError) {
      return { error: "Your session has expired. Sign in again." };
    }
    console.error("[portal complaint]", error);
    return { error: "Something went wrong. Nothing was saved." };
  }

  // Outside the try: `redirect` signals by throwing, and catching it here
  // would turn a saved complaint into an error message.
  redirect(destination);
}

export async function replyToComplaint(
  _prev: ComplaintState,
  formData: FormData,
): Promise<ComplaintState> {
  try {
    const session = await authorizeCustomer();

    const complaintId = String(formData.get("complaintId") ?? "");
    if (!complaintId) return { error: "That complaint could not be identified." };

    const result = await replyToPortalComplaint(
      session,
      complaintId,
      String(formData.get("body") ?? ""),
    );
    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${complaintId}`);
    return { ok: true, message: "Sent. The team can see it." };
  } catch (error) {
    if (error instanceof CustomerAuthError) {
      return { error: "Your session has expired. Sign in again." };
    }
    console.error("[portal complaint reply]", error);
    return { error: "Your reply could not be sent." };
  }
}
