import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/shell/page-header";
import { TenantStatusBadge } from "@/components/platform/status-badge";
import { getPlan } from "@/lib/platform/plans";
import { operatorCan, requireCapability } from "@/lib/platform/session";
import { PlanForm } from "../plan-form";
import { DeletePlanButton } from "./delete-plan-button";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ planId: string }>;
}): Promise<Metadata> {
  const { planId } = await params;
  const plan = await getPlan(planId);
  return { title: plan?.name ?? "Plan" };
}

/**
 * One plan, and — the part that matters before editing it — everybody it
 * would affect. A limit lowered here starts refusing invitations at every
 * carrier in the list below.
 */
export default async function PlanDetailPage({
  params,
}: {
  params: Promise<{ planId: string }>;
}) {
  const operator = await requireCapability("plan.read");
  const { planId } = await params;

  const plan = await getPlan(planId);
  if (!plan) notFound();

  const canWrite = operatorCan(operator, "plan.write");

  return (
    <>
      <PageHeader
        eyebrow="Plan"
        title={plan.name}
        description={`${plan.code}${plan.isActive ? "" : " · retired, not offered to new tenants"}`}
      />

      <Link
        href="/platform/plans"
        className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" /> All plans
      </Link>

      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold tracking-tight">
            On this plan ({plan.organizations.length})
          </h2>
          {plan.organizations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No carrier is on this plan.
            </p>
          ) : (
            <ul className="divide-y">
              {plan.organizations.map((org) => (
                <li
                  key={org.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <Link
                    href={`/platform/tenants/${org.id}`}
                    className="text-sm font-medium underline-offset-4 hover:underline"
                  >
                    {org.name}
                  </Link>
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-xs text-muted-foreground">
                      {org.subdomain}
                    </span>
                    <TenantStatusBadge status={org.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold tracking-tight">
            {canWrite ? "Edit plan" : "Plan settings"}
          </h2>
          {canWrite ? (
            <PlanForm
              planId={plan.id}
              values={{
                code: plan.code,
                name: plan.name,
                maxUsers: plan.maxUsers,
                maxBranches: plan.maxBranches,
                maxShipmentsPerMonth: plan.maxShipmentsPerMonth,
                maxPortalUsers: plan.maxPortalUsers,
                features: plan.features,
                monthlyPrice: plan.monthlyPrice?.toString() ?? null,
                currency: plan.currency,
                isActive: plan.isActive,
                sortOrder: plan.sortOrder,
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Your operator role can read plans but not change them.
            </p>
          )}
        </section>

        {canWrite && (
          <section className="flex flex-col gap-3 rounded-lg border border-bad/30 bg-card p-5">
            <h2 className="text-sm font-semibold tracking-tight">Remove</h2>
            <DeletePlanButton
              planId={plan.id}
              planName={plan.name}
              tenantCount={plan.organizations.length}
            />
          </section>
        )}
      </div>
    </>
  );
}
