import { platformDb } from "@/lib/platform/db";
import { recordPlatformAudit, requestMeta } from "@/lib/platform/audit";
import { fail, ok, type PlatformResult } from "@/lib/platform/result";
import type { PlatformOperator } from "@/lib/platform/session";

/**
 * What a new tenant must have before anyone signs in for real.
 *
 * This list used to live in `scripts/provision-tenant.ts`, which was the
 * only thing that could create a tenant. Now that the console provisions
 * too, it lives here — next to the notes below, which are keyed on exactly
 * these keys — and both the service and the CLI read it. Two copies of a
 * checklist is how a tenant provisioned from a terminal and one
 * provisioned from the console end up with different definitions of
 * "ready to hand over".
 *
 * `isBlocking` is the difference between "not done yet" and "cannot be
 * handed over": a carrier that goes live unable to send a delivery OTP has
 * a broken product, not an incomplete one.
 */
export const ONBOARDING_TASKS: ReadonlyArray<{
  key: string;
  label: string;
  isBlocking: boolean;
}> = [
  { key: "branches", label: "Confirm branch network and hub roles", isBlocking: true },
  { key: "pincodes", label: "Load the serviceability pincode master", isBlocking: true },
  { key: "rate-cards", label: "Load customer rate cards", isBlocking: true },
  { key: "owner-signin", label: "First owner has signed in and changed their password", isBlocking: true },
  { key: "dlt-sender", label: "DLT sender header registered and approved (1–3 weeks)", isBlocking: true },
  { key: "dlt-templates", label: "DLT templates approved for every SMS the platform sends", isBlocking: true },
  { key: "branding", label: "Logo, palette and document footer supplied", isBlocking: false },
  { key: "gstin", label: "GSTIN, PAN and invoice address confirmed", isBlocking: false },
  { key: "smtp", label: "Email sender domain verified", isBlocking: false },
  { key: "custom-domain", label: "Custom tracking domain pointed and certified", isBlocking: false },
];

/**
 * A sentence of context per task, because "dlt-sender" on its own does not
 * tell a new support engineer that they are looking at a three-week
 * external approval rather than a checkbox somebody forgot.
 *
 * A tenant provisioned before a key was added simply has no row for it.
 * That is deliberate: the checklist is the tenant's own list, not a view
 * over a global template, and back-filling one silently would mark a live
 * carrier as incomplete.
 */
export const TASK_NOTES: Record<string, string> = {
  branches: "Which branches exist, which are hubs, and what they connect to.",
  pincodes:
    "Serviceability is per-tenant (ADR 001 §4). The importer at /masters/pincodes/import handles the full ~19,000-row load.",
  "rate-cards": "Nothing can be billed until a customer has a rate card.",
  "owner-signin":
    "The seeded password must not survive the first session. This ticks when the owner has signed in and changed it.",
  "dlt-sender":
    "The long pole. Indian transactional SMS needs a sender header registered per tenant — one to three weeks of external approval, not a code task.",
  "dlt-templates":
    "Every SMS the platform sends needs its own approved template. A missing one means a delivery OTP that never arrives.",
  branding: "Logo, palette and document footer — set on this page.",
  gstin: "GSTIN, PAN and invoice address, as they must appear on documents.",
  smtp: "Sender domain verified, or email lands in spam.",
  "custom-domain": "Only when the carrier wants tracking on their own domain.",
};

export async function listOnboardingTasks(orgId: string) {
  return platformDb.tenantOnboardingTask.findMany({
    where: { orgId },
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
  });
}

/**
 * Ticks or un-ticks one task.
 *
 * Un-ticking is allowed and is not an oversight: a DLT template rejected
 * after approval has to be able to go back to not-done, and a checklist
 * that only moves one way stops being believed.
 */
export async function setTaskDone(
  orgId: string,
  taskId: string,
  isDone: boolean,
  actor: PlatformOperator,
): Promise<PlatformResult<null>> {
  const task = await platformDb.tenantOnboardingTask.findUnique({
    where: { id: taskId },
    select: { id: true, orgId: true, key: true, label: true, isDone: true },
  });
  if (!task) return fail("That task no longer exists.");
  // The id arrives from a hidden field on a checklist rendered for one
  // carrier, and `tenant_onboarding_task` is operator-owned and outside
  // row-level security — so nothing else would have noticed a task id from
  // another carrier's page. It cannot leak anything (the row is audited
  // against its own tenant either way), but a checklist that silently ticks
  // a different company's box is not a state worth leaving reachable.
  if (task.orgId !== orgId) return fail("That task belongs to another tenant.");
  if (task.isDone === isDone) return ok(null);

  const org = await platformDb.organization.findUnique({
    where: { id: task.orgId },
    select: { id: true, slug: true },
  });
  if (!org) return fail("That tenant no longer exists.");

  const meta = await requestMeta();

  await platformDb.$transaction(async (tx) => {
    await tx.tenantOnboardingTask.update({
      where: { id: taskId },
      data: {
        isDone,
        doneAt: isDone ? new Date() : null,
        // `doneBy` is a plain column, not a relation to `app_user`: the
        // person who ticked it is an operator, not tenant staff.
        doneBy: isDone ? actor.id : null,
      },
    });
    await recordPlatformAudit(
      {
        action: isDone ? "onboarding.task.done" : "onboarding.task.reopen",
        actor,
        org,
        entity: "TenantOnboardingTask",
        entityId: taskId,
        before: { key: task.key, isDone: task.isDone },
        after: { key: task.key, isDone },
        ...meta,
      },
      tx,
    );
  });

  return ok(null);
}
