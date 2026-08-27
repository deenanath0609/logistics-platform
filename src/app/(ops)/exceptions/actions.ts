"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  addExceptionNote,
  assignException,
  transitionException,
} from "@/lib/exceptions/service";

/**
 * Server actions for the exception tower.
 *
 * Thin: authorise, parse, hand off. Nothing here decides whether a
 * transition is legal — `kinds.ts` does, once, for both the buttons and
 * the guard, so a button can never offer something the action refuses.
 */

export type ExceptionActionState =
  | { ok: true; message: string }
  | { ok: false; error: string };

const STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
  "DISMISSED",
] as const;

const transitionSchema = z.object({
  exceptionId: z.string().min(1),
  to: z.enum(STATUSES),
  note: z.string().default(""),
});

const assignSchema = z.object({
  exceptionId: z.string().min(1),
  assignedToId: z.string().default(""),
});

const noteSchema = z.object({
  exceptionId: z.string().min(1),
  note: z.string().trim().min(1, "Say something."),
});

function refused(error: unknown): ExceptionActionState {
  if (error instanceof PermissionError) {
    return { ok: false, error: "You do not have permission to do that." };
  }
  console.error("[exceptions] action failed", error);
  return { ok: false, error: "Something went wrong. Try again." };
}

export async function transitionExceptionAction(
  formData: FormData,
): Promise<ExceptionActionState> {
  try {
    // The wider of the two permissions: `transitionException` re-checks
    // the specific one this transition needs, so acknowledging does not
    // require the right to resolve.
    const actor = await authorize("exception.assign").catch(() =>
      authorize("exception.resolve"),
    );

    const parsed = transitionSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) return { ok: false, error: "That request made no sense." };

    const result = await transitionException(parsed.data, actor);
    if (result.ok) {
      revalidatePath("/exceptions");
      revalidatePath(`/exceptions/${parsed.data.exceptionId}`);
    }
    return result;
  } catch (error) {
    return refused(error);
  }
}

export async function assignExceptionAction(
  formData: FormData,
): Promise<ExceptionActionState> {
  try {
    const actor = await authorize("exception.assign");

    const parsed = assignSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) return { ok: false, error: "That request made no sense." };

    const result = await assignException(
      parsed.data.exceptionId,
      parsed.data.assignedToId || null,
      actor,
    );

    if (result.ok) {
      revalidatePath("/exceptions");
      revalidatePath(`/exceptions/${parsed.data.exceptionId}`);
    }
    return result;
  } catch (error) {
    return refused(error);
  }
}

export async function addNoteAction(
  formData: FormData,
): Promise<ExceptionActionState> {
  try {
    const actor = await authorize("exception.read");

    const parsed = noteSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) return { ok: false, error: "Say something." };

    const result = await addExceptionNote(
      parsed.data.exceptionId,
      parsed.data.note,
      actor,
    );

    if (result.ok) revalidatePath(`/exceptions/${parsed.data.exceptionId}`);
    return result;
  } catch (error) {
    return refused(error);
  }
}
