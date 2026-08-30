"use server";

import { redirect } from "next/navigation";
import { changeOwnPassword } from "@/lib/platform/credentials";
import { getCurrentOperator, endPlatformSession } from "@/lib/platform/session";
import type { ConsoleFormState } from "@/components/platform/form-bits";

/**
 * Changing your own password.
 *
 * Deliberately not gated by `authorizeOperator`: that guard refuses an
 * operator who still carries `mustChangePassword`, and this is the screen
 * that clears it. It resolves the operator directly instead — the only
 * action in the console that does.
 */
export async function changeOperatorPassword(
  _prev: ConsoleFormState,
  formData: FormData,
): Promise<ConsoleFormState> {
  const operator = await getCurrentOperator();
  if (!operator) redirect("/platform/login");

  const current = String(formData.get("currentPassword") ?? "");
  const next = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  if (next !== confirm) return { error: "The two new passwords do not match." };

  const result = await changeOwnPassword(operator.id, current, next);
  if (!result.ok) return { error: result.error };

  redirect("/platform");
}

export async function signOutOperator(): Promise<void> {
  await endPlatformSession();
  redirect("/platform/login");
}
