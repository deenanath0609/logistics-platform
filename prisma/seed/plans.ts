import { db, step, done } from "./client";
import { MODULE_KEYS } from "../../src/lib/modules/registry";

/**
 * The commercial plans a carrier can be put on.
 *
 * Seeded at the platform level, beside the permission catalogue, not per
 * organisation — a plan is the operator's price list, not a tenant's data.
 *
 * Without this a fresh deployment has no plans at all, and since a tenant
 * with no plan gets only the always-on modules, the first carrier
 * provisioned onto a new platform would come up with the product switched
 * off. That is a bad first impression of a working install and looks
 * exactly like a bug.
 *
 * Idempotent, and deliberately **not** an overwrite of a plan an operator
 * has edited: the upsert below only fills in a plan that does not exist.
 * Re-running the seed must not quietly put a carrier back on terms nobody
 * agreed to.
 */

type PlanSeed = {
  code: string;
  name: string;
  description: string;
  modules: string[];
  maxUsers: number | null;
  maxBranches: number | null;
  maxShipmentsPerMonth: number | null;
  maxPortalUsers: number | null;
  monthlyPrice: number | null;
  sortOrder: number;
};

const PLANS: PlanSeed[] = [
  {
    code: "STARTER",
    name: "Starter",
    description:
      "One branch network moving freight. Booking, the dock, and delivery — no billing, no customer portal.",
    modules: ["hub", "lastmile"],
    maxUsers: 10,
    maxBranches: 3,
    maxShipmentsPerMonth: 1_000,
    // Zero, not null: the portal is not merely unlimited-at-zero, it is not
    // part of this plan. The limit and the module say the same thing from
    // two directions, which is what makes the refusal read correctly.
    maxPortalUsers: 0,
    monthlyPrice: 4_999,
    sortOrder: 10,
  },
  {
    code: "GROWTH",
    name: "Growth",
    description:
      "A carrier running line-haul and billing for it, with a portal for their customers.",
    modules: ["hub", "dispatch", "lastmile", "cod", "billing", "portal", "sla", "tracking"],
    maxUsers: 50,
    maxBranches: 15,
    maxShipmentsPerMonth: 20_000,
    maxPortalUsers: 50,
    monthlyPrice: 19_999,
    sortOrder: 20,
  },
  {
    code: "ENTERPRISE",
    name: "Enterprise",
    description: "Everything, and no ceilings.",
    // Every module, read from the registry rather than listed here, so a
    // module added next quarter is on the top plan without anyone
    // remembering to come back.
    modules: [...MODULE_KEYS],
    maxUsers: null,
    maxBranches: null,
    maxShipmentsPerMonth: null,
    maxPortalUsers: null,
    monthlyPrice: null,
    sortOrder: 30,
  },
];

export async function seedPlans() {
  step("commercial plans");

  let created = 0;

  for (const plan of PLANS) {
    const existing = await db.tenantPlan.findUnique({
      where: { code: plan.code },
      select: { id: true },
    });

    if (existing) continue;

    await db.tenantPlan.create({
      data: {
        code: plan.code,
        name: plan.name,
        features: plan.modules,
        maxUsers: plan.maxUsers,
        maxBranches: plan.maxBranches,
        maxShipmentsPerMonth: plan.maxShipmentsPerMonth,
        maxPortalUsers: plan.maxPortalUsers,
        monthlyPrice: plan.monthlyPrice,
        sortOrder: plan.sortOrder,
      },
    });
    created += 1;
  }

  done(`${created} new, ${PLANS.length - created} kept`);
}
