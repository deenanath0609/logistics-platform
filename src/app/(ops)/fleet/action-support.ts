import type { z } from "zod";
import { PermissionError } from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";

/**
 * Shared plumbing for the bespoke fleet actions.
 *
 * The vehicle and driver forms cannot go through `createMasterCrud` — both
 * need branch-scope enforcement on write and both normalise a field before
 * it is stored — but they should still fail in exactly the same shape the
 * master screens do, so the dialogs can render errors without special cases.
 */

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

export function describeFleetError(error: unknown, label: string): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to change this.";
  }

  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Unique constraint")) {
    if (message.includes("registrationNumber")) {
      return "That registration number is already on another vehicle.";
    }
    if (message.includes("mobile")) {
      return "That mobile number belongs to another driver.";
    }
    if (message.includes("code")) {
      return "That code is already used by another driver.";
    }
    return `Another ${label.toLowerCase()} already uses one of these values.`;
  }

  if (message.includes("Foreign key constraint")) {
    return "A referenced record is missing or has been removed.";
  }

  console.error(`[fleet] ${label}`, error);
  return "Something went wrong saving that. The change was not applied.";
}

/**
 * Home-branch check for fleet records.
 *
 * A branch-scoped user must not be able to park a vehicle at a branch they
 * cannot see — the form only offers permitted branches, and this makes that
 * hold when the form is bypassed. A network-scoped user may leave the branch
 * empty; a scoped one may not, or they would create a record that
 * immediately disappears from their own list.
 */
export function checkHomeBranch(
  user: SessionUser,
  branchId: string | null,
): string | null {
  if (branchId) {
    return coversBranch(user, branchId) ? null : "That branch is outside your scope.";
  }
  if (user.branchIds === null) return null;
  return "Choose a home branch.";
}
