import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, TableFrame } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ModuleChips } from "@/components/platform/module-chips";
import { auditPlanModules } from "@/lib/platform/plan-modules";
import { listPlans } from "@/lib/platform/plans";
import { operatorCan, requireCapability } from "@/lib/platform/session";
import { PlanForm } from "./plan-form";

export const metadata: Metadata = { title: "Plans" };
export const dynamic = "force-dynamic";

function limitText(value: number | null): string {
  if (value === null) return "∞";
  return value === 0 ? "off" : String(value);
}

export default async function PlansPage() {
  const operator = await requireCapability("plan.read");
  const canWrite = operatorCan(operator, "plan.write");
  const plans = await listPlans();

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Plans"
        description="Limits are enforced where they bite — when a user is invited or a branch created — rather than by a nightly job, so a carrier is told at the moment rather than in an invoice."
      />

      <TableFrame>
        {plans.length === 0 ? (
          <EmptyState
            title="No plans yet"
            description="A tenant with no plan has no limits applied. Create the first one below."
          />
        ) : (
          <Table className="min-w-[1100px]">
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="text-right">Branches</TableHead>
                <TableHead className="text-right">Shipments / mo</TableHead>
                <TableHead className="text-right">Portal users</TableHead>
                <TableHead className="min-w-[22rem]">Modules</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Tenants</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((plan) => (
                <TableRow key={plan.id}>
                  <TableCell>
                    <Link
                      href={`/platform/plans/${plan.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {plan.name}
                    </Link>
                    <p className="font-mono text-[0.65rem] text-muted-foreground">
                      {plan.code}
                      {!plan.isActive && " · retired"}
                    </p>
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {limitText(plan.maxUsers)}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {limitText(plan.maxBranches)}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {limitText(plan.maxShipmentsPerMonth)}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {limitText(plan.maxPortalUsers)}
                  </TableCell>
                  <TableCell>
                    <ModuleChips {...auditPlanModules(plan.features)} />
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {plan.monthlyPrice
                      ? `${plan.currency} ${plan.monthlyPrice.toString()}`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {plan._count.organizations}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      {canWrite && (
        <section className="mt-8 flex flex-col gap-4 rounded-lg border bg-card p-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold tracking-tight">New plan</h2>
            <p className="text-xs text-muted-foreground">
              Codes are stable identifiers other systems quote; names are what
              a salesperson says out loud. What the plan actually grants is the
              modules ticked below — nothing else switches a capability on.
            </p>
          </div>
          <PlanForm />
        </section>
      )}
    </>
  );
}
