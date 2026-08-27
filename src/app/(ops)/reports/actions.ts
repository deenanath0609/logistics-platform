"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser, PermissionError } from "@/lib/auth/session";
import { parseFilters } from "@/lib/reports/filters";
import { reportFor } from "@/lib/reports/registry";
import { createSavedReport, deleteSavedReport } from "@/lib/reports/saved";

/**
 * Saving and removing report views.
 *
 * The filters arrive as the query string the user is actually looking at
 * and are re-parsed here rather than trusted — the same parser the page
 * uses, so a saved view can never encode a filter the live screen would
 * have rejected.
 */

export type SaveState =
  | { ok: true; message: string }
  | { ok: false; error: string };

const saveSchema = z.object({
  reportKey: z.string().min(1),
  name: z.string().trim().min(2, "Give it a name").max(80),
  query: z.string().default(""),
  isShared: z.string().optional(),
});

export async function saveReportViewAction(
  formData: FormData,
): Promise<SaveState> {
  try {
    const user = await getCurrentUser();
    if (!user) throw new PermissionError("report.operations");

    const parsed = saveSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Check that." };
    }

    const report = reportFor(parsed.data.reportKey);
    if (!report) return { ok: false, error: "No such report." };
    if (!user.permissions.has(report.permission)) {
      return { ok: false, error: "You cannot run that report." };
    }

    const params = Object.fromEntries(
      new URLSearchParams(parsed.data.query).entries(),
    );

    const result = await createSavedReport(
      {
        reportKey: parsed.data.reportKey,
        name: parsed.data.name,
        filters: parseFilters(params),
        isShared: Boolean(parsed.data.isShared),
      },
      user,
    );

    if (result.ok) revalidatePath("/reports");
    return result.ok
      ? { ok: true, message: result.message }
      : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { ok: false, error: "You do not have permission to do that." };
    }
    console.error("[reports] save failed", error);
    return { ok: false, error: "Could not save that view." };
  }
}

export async function deleteSavedReportAction(
  formData: FormData,
): Promise<SaveState> {
  try {
    const user = await getCurrentUser();
    if (!user) throw new PermissionError("report.operations");

    const id = String(formData.get("id") ?? "");
    if (!id) return { ok: false, error: "Nothing to remove." };

    const result = await deleteSavedReport(id, user);
    if (result.ok) revalidatePath("/reports");

    return result.ok
      ? { ok: true, message: result.message }
      : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { ok: false, error: "You do not have permission to do that." };
    }
    console.error("[reports] delete failed", error);
    return { ok: false, error: "Could not remove that view." };
  }
}
