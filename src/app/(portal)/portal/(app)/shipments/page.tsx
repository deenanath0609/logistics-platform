import type { Metadata } from "next";
import Link from "next/link";
import { requireCustomerUser } from "@/lib/auth/customer-session";
import { listPortalShipments } from "@/lib/portal/queries";
import { PageHeader } from "@/components/shell/page-header";
import { Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { PortalShipmentTable } from "@/components/portal/shipment-table";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Shipments",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const GROUPS = [
  { value: undefined, label: "All" },
  { value: "pending", label: "Awaiting pickup" },
  { value: "moving", label: "In transit" },
  { value: "lastMile", label: "Last mile" },
  { value: "done", label: "Delivered" },
  { value: "exception", label: "Exceptions" },
] as const;

export default async function PortalShipmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; group?: string; page?: string }>;
}) {
  const session = await requireCustomerUser();
  const { q, group, page: pageParam } = await searchParams;

  const validGroup = GROUPS.find((g) => g.value === group)?.value;

  const { rows, total, page, pageSize } = await listPortalShipments(session, {
    q,
    group: validGroup,
    page: Math.max(1, Number(pageParam ?? 1) || 1),
  });

  return (
    <>
      <PageHeader
        title="Shipments"
        description={`Every consignment booked under ${session.customerName}.`}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput placeholder="LR number, reference or consignee" />
        <div className="flex flex-wrap gap-1.5">
          {GROUPS.map((option) => {
            const params = new URLSearchParams();
            if (q) params.set("q", q);
            if (option.value) params.set("group", option.value);
            const active = validGroup === option.value;

            return (
              <Link
                key={option.label}
                href={`/portal/shipments${params.size ? `?${params}` : ""}`}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs transition-colors",
                  active
                    ? "border-primary bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {option.label}
              </Link>
            );
          })}
        </div>
      </div>

      <PortalShipmentTable
        rows={rows}
        emptyTitle={q ? "Nothing matched" : "No shipments yet"}
        emptyDescription={
          q ? "Try a different number or name." : undefined
        }
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        baseParams={{ q, group: validGroup }}
        pathname="/portal/shipments"
      />
    </>
  );
}
