"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { STATUS_ORDER } from "@/components/platform/status-badge";

const SORTS = [
  { value: "name", label: "Name" },
  { value: "status", label: "Status" },
  { value: "created", label: "Newest first" },
  { value: "plan", label: "Plan" },
];

/**
 * Filters as URL state rather than component state.
 *
 * A support engineer pastes "every suspended tenant" into a ticket, and it
 * has to open the same list for whoever reads it.
 */
export function TenantFilters({
  plans,
  selectedStatus,
  selectedPlan,
  selectedSort,
}: {
  plans: Array<{ id: string; name: string }>;
  selectedStatus?: string;
  selectedPlan?: string;
  selectedSort?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    router.replace(`${pathname}?${next}`);
  }

  const filtered = Boolean(selectedStatus || selectedPlan);
  const selectClass =
    "h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <select
        aria-label="Filter by status"
        value={selectedStatus ?? ""}
        onChange={(e) => setParam("status", e.target.value)}
        className={selectClass}
      >
        <option value="">All statuses</option>
        {STATUS_ORDER.map((status) => (
          <option key={status} value={status}>
            {status.charAt(0) + status.slice(1).toLowerCase()}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by plan"
        value={selectedPlan ?? ""}
        onChange={(e) => setParam("plan", e.target.value)}
        className={selectClass}
      >
        <option value="">All plans</option>
        {plans.map((plan) => (
          <option key={plan.id} value={plan.id}>
            {plan.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Sort by"
        value={selectedSort ?? "name"}
        onChange={(e) => setParam("sort", e.target.value)}
        className={selectClass}
      >
        {SORTS.map((sort) => (
          <option key={sort.value} value={sort.value}>
            Sort: {sort.label}
          </option>
        ))}
      </select>

      {filtered && (
        <Button variant="ghost" size="sm" onClick={() => router.replace(pathname)}>
          <X />
          Clear filters
        </Button>
      )}
    </div>
  );
}
