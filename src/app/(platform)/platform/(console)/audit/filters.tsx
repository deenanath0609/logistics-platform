"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

const SELECT_CLASS =
  "h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The two questions this log is actually asked — "what was done to this
 * carrier?" and "what has this operator done?" — are the first two
 * selects. Action is third because it is a refinement of either.
 */
export function PlatformAuditFilters({
  orgs,
  admins,
  actions,
  selectedOrg,
  selectedAdmin,
  selectedAction,
}: {
  orgs: Array<{ id: string; name: string }>;
  admins: Array<{ id: string; name: string }>;
  actions: string[];
  selectedOrg?: string;
  selectedAdmin?: string;
  selectedAction?: string;
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

  const filtered = Boolean(selectedOrg || selectedAdmin || selectedAction);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <select
        aria-label="Filter by tenant"
        value={selectedOrg ?? ""}
        onChange={(event) => setParam("org", event.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">All tenants</option>
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by operator"
        value={selectedAdmin ?? ""}
        onChange={(event) => setParam("admin", event.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">All operators</option>
        {admins.map((admin) => (
          <option key={admin.id} value={admin.id}>
            {admin.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by action"
        value={selectedAction ?? ""}
        onChange={(event) => setParam("action", event.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">All actions</option>
        {actions.map((action) => (
          <option key={action} value={action}>
            {action}
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
