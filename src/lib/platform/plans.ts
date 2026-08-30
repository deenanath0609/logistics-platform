import { platformDb } from "@/lib/platform/db";
import { changedFields, recordPlatformAudit, requestMeta } from "@/lib/platform/audit";
import {
  canonicalPlanFeatures,
  unknownModuleProblem,
} from "@/lib/platform/plan-modules";
import { fail, ok, type PlatformResult } from "@/lib/platform/result";
import type { PlatformOperator } from "@/lib/platform/session";

/**
 * Commercial plans.
 *
 * Limits are enforced at the point of use rather than by a nightly job, so
 * what is stored here is read by the tenant app the moment a user is
 * invited or a branch created — which is why an edit is audited like any
 * other operator action, and why a plan still attached to a carrier cannot
 * simply be deleted.
 */

export type PlanInput = {
  code: string;
  name: string;
  /** Null is unlimited. Zero switches the feature off. Both are meaningful. */
  maxUsers: number | null;
  maxBranches: number | null;
  maxShipmentsPerMonth: number | null;
  maxPortalUsers: number | null;
  features: string[];
  monthlyPrice: string | null;
  currency: string;
  isActive: boolean;
  sortOrder: number;
};

export async function listPlans() {
  return platformDb.tenantPlan.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { organizations: true } } },
  });
}

/** A plan plus the carriers on it — "who does this change affect?". */
export async function getPlan(planId: string) {
  const plan = await platformDb.tenantPlan.findUnique({
    where: { id: planId },
    include: {
      organizations: {
        orderBy: { name: "asc" },
        select: { id: true, name: true, subdomain: true, status: true },
      },
    },
  });
  return plan;
}

function normaliseCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "_");
}

export function validate(input: PlanInput): string | null {
  if (input.code.trim().length < 2) return "Give the plan a short code, e.g. GROWTH.";
  if (input.name.trim().length < 2) return "Give the plan a name.";
  // Refused, not filtered. A key nobody recognises grants nothing, and a
  // plan that silently grants nothing is indistinguishable on every screen
  // from one that works.
  const unknown = unknownModuleProblem(input.features);
  if (unknown) return unknown;
  if (input.monthlyPrice && Number.isNaN(Number(input.monthlyPrice))) {
    return "Monthly price must be a number, or blank for a plan that is not priced here.";
  }
  for (const limit of [
    input.maxUsers,
    input.maxBranches,
    input.maxShipmentsPerMonth,
    input.maxPortalUsers,
  ]) {
    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
      return "Limits must be whole numbers, zero to switch a feature off, or blank for unlimited.";
    }
  }
  return null;
}

export async function createPlan(
  input: PlanInput,
  actor: PlatformOperator,
): Promise<PlatformResult<{ id: string }>> {
  const problem = validate(input);
  if (problem) return fail(problem);

  const code = normaliseCode(input.code);
  const clash = await platformDb.tenantPlan.findUnique({
    where: { code },
    select: { id: true },
  });
  if (clash) return fail(`A plan with code ${code} already exists.`);

  const meta = await requestMeta();

  const plan = await platformDb.$transaction(async (tx) => {
    const created = await tx.tenantPlan.create({
      data: {
        ...input,
        code,
        name: input.name.trim(),
        // `alwaysOn` modules are added regardless of what was ticked: the
        // column should describe the plan, and `modulesForPlan` grants
        // them whether or not it says so.
        features: canonicalPlanFeatures(input.features),
      },
      select: { id: true, code: true, name: true },
    });
    await recordPlatformAudit(
      {
        action: "plan.create",
        actor,
        entity: "TenantPlan",
        entityId: created.id,
        after: { code: created.code, name: created.name },
        ...meta,
      },
      tx,
    );
    return created;
  });

  return ok({ id: plan.id });
}

export async function updatePlan(
  planId: string,
  input: PlanInput,
  actor: PlatformOperator,
): Promise<PlatformResult<null>> {
  const problem = validate(input);
  if (problem) return fail(problem);

  const existing = await platformDb.tenantPlan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      code: true,
      name: true,
      maxUsers: true,
      maxBranches: true,
      maxShipmentsPerMonth: true,
      maxPortalUsers: true,
      features: true,
      monthlyPrice: true,
      currency: true,
      isActive: true,
      sortOrder: true,
    },
  });
  if (!existing) return fail("That plan no longer exists.");

  const code = normaliseCode(input.code);
  if (code !== existing.code) {
    const clash = await platformDb.tenantPlan.findUnique({
      where: { code },
      select: { id: true },
    });
    if (clash) return fail(`A plan with code ${code} already exists.`);
  }

  const after = {
    ...input,
    code,
    name: input.name.trim(),
    features: canonicalPlanFeatures(input.features),
  };
  // Both sides are flattened to comparable scalars before diffing:
  // `features` is an array, and `monthlyPrice` is a Prisma `Decimal` on the
  // stored row but a string on the way in. Order counts as a change on
  // `features`, and it should — the list is shown in the order it is
  // stored.
  const diff = changedFields(
    {
      ...existing,
      features: existing.features.join(","),
      monthlyPrice: existing.monthlyPrice?.toString() ?? null,
    },
    { ...after, features: after.features.join(",") },
  );
  if (!diff) return ok(null);

  const meta = await requestMeta();

  await platformDb.$transaction(async (tx) => {
    await tx.tenantPlan.update({ where: { id: planId }, data: after });
    await recordPlatformAudit(
      {
        action: "plan.update",
        actor,
        entity: "TenantPlan",
        entityId: planId,
        before: diff.before,
        after: diff.after,
        ...meta,
      },
      tx,
    );
  });

  return ok(null);
}

/**
 * Removes a plan nobody is on.
 *
 * A plan with carriers attached is refused rather than cascaded: the
 * foreign key would null their `planId` and silently un-price a live
 * account. Retiring it (`isActive: false`) hides it from the picker while
 * leaving existing carriers exactly where they are, and that is almost
 * always the thing actually wanted.
 */
export async function deletePlan(
  planId: string,
  actor: PlatformOperator,
): Promise<PlatformResult<null>> {
  const plan = await platformDb.tenantPlan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      code: true,
      name: true,
      _count: { select: { organizations: true } },
    },
  });
  if (!plan) return fail("That plan no longer exists.");

  if (plan._count.organizations > 0) {
    return fail(
      `${plan._count.organizations} tenant(s) are on ${plan.name}. Move them first, or retire the plan instead.`,
    );
  }

  const meta = await requestMeta();

  await platformDb.$transaction(async (tx) => {
    await tx.tenantPlan.delete({ where: { id: planId } });
    await recordPlatformAudit(
      {
        action: "plan.delete",
        actor,
        entity: "TenantPlan",
        entityId: planId,
        before: { code: plan.code, name: plan.name },
        ...meta,
      },
      tx,
    );
  });

  return ok(null);
}
