import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { PageHeader } from "@/components/shell/page-header";
import { SearchInput } from "@/components/data/search-input";
import { EmptyState, Pagination, TableFrame } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TenantStatusBadge } from "@/components/platform/status-badge";
import { Button } from "@/components/ui/button";
import { listPlans } from "@/lib/platform/plans";
import {
  listTenants,
  TENANT_PAGE_SIZE,
  type TenantSort,
} from "@/lib/platform/tenants";
import { operatorCan, requireCapability } from "@/lib/platform/session";
import type { TenantStatus } from "@/generated/prisma/client";
import { TenantFilters } from "./filters";

export const metadata: Metadata = { title: "Tenants" };
export const dynamic = "force-dynamic";

const SORTS = new Set<TenantSort>(["name", "status", "created", "plan"]);

/**
 * Every carrier on the platform.
 *
 * The headline numbers come from `TenantUsageSnapshot` rather than from
 * counting operational tables across every org — that is the whole reason
 * the snapshot exists. A tenant with no snapshot yet shows a dash, which
 * is honest: it means the nightly pass has not run for them, not that they
 * shipped nothing.
 */
export default async function TenantsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    plan?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const operator = await requireCapability("tenant.read");
  const canProvision = operatorCan(operator, "tenant.write");

  const params = await searchParams;
  const sort = SORTS.has(params.sort as TenantSort)
    ? (params.sort as TenantSort)
    : "name";

  const [{ rows, total, page }, plans] = await Promise.all([
    listTenants({
      q: params.q,
      status: params.status as TenantStatus | undefined,
      planId: params.plan,
      sort,
      page: Number(params.page ?? 1) || 1,
    }),
    listPlans(),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Tenants"
        description="Carriers on the platform. Usage is the most recent daily snapshot, not a live count."
        actions={
          <>
            <SearchInput placeholder="Search name, slug or host" />
            {/* Only OWNER holds `tenant.write`. Support and billing see
                every carrier here and can create none. */}
            {canProvision && (
              <Button render={<Link href="/platform/tenants/new" />}>
                New tenant
              </Button>
            )}
          </>
        }
      />

      <TenantFilters
        plans={plans.map((plan) => ({ id: plan.id, name: plan.name }))}
        selectedStatus={params.status}
        selectedPlan={params.plan}
        selectedSort={sort}
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title="No tenants match"
            description="Carriers are provisioned from “New tenant”, or with scripts/provision-tenant.ts — both run the same service and write the onboarding checklist at the same time."
          />
        ) : (
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead>Carrier</TableHead>
                <TableHead>Host</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Shipments</TableHead>
                <TableHead className="text-right">Deliveries</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="text-right">Branches</TableHead>
                <TableHead>Snapshot</TableHead>
                <TableHead>Handover</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={`/platform/tenants/${row.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {row.name}
                    </Link>
                    <p className="font-mono text-[0.65rem] text-muted-foreground">
                      {row.slug}
                    </p>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.subdomain}
                    {row.customDomain && (
                      <p className="text-muted-foreground">{row.customDomain}</p>
                    )}
                  </TableCell>
                  <TableCell>
                    <TenantStatusBadge status={row.status} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.plan?.name ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {row.usage?.shipments ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {row.usage?.deliveries ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {row.usage?.activeUsers ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {row.usage?.branches ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.usage ? format(row.usage.onDate, "dd MMM") : "never"}
                  </TableCell>
                  <TableCell>
                    {row.blockingTasks === 0 ? (
                      <span className="text-xs text-muted-foreground">ready</span>
                    ) : (
                      <span className="rounded-4xl bg-warn-muted px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.1em] text-warn">
                        {row.blockingTasks} blocking
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      <Pagination
        page={page}
        pageSize={TENANT_PAGE_SIZE}
        total={total}
        pathname="/platform/tenants"
        baseParams={{
          q: params.q,
          status: params.status,
          plan: params.plan,
          sort,
        }}
      />
    </>
  );
}
