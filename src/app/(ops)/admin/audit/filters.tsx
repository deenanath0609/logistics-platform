"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

const ACTIONS = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "STATUS_CHANGE",
  "PERMISSION_CHANGE",
  "OVERRIDE",
  "APPROVE",
  "CANCEL",
  "EXPORT",
  "LOGIN",
  "LOGOUT",
];

export function AuditFilters({
  entities,
  selectedEntity,
  selectedAction,
}: {
  entities: string[];
  selectedEntity?: string;
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

  const filtered = Boolean(selectedEntity || selectedAction);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <select
        aria-label="Filter by entity"
        value={selectedEntity ?? ""}
        onChange={(e) => setParam("entity", e.target.value)}
        className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value="">All entities</option>
        {entities.map((entity) => (
          <option key={entity} value={entity}>
            {entity}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by action"
        value={selectedAction ?? ""}
        onChange={(e) => setParam("action", e.target.value)}
        className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value="">All actions</option>
        {ACTIONS.map((action) => (
          <option key={action} value={action}>
            {action.replace(/_/g, " ")}
          </option>
        ))}
      </select>

      {filtered && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.replace(pathname)}
        >
          <X />
          Clear filters
        </Button>
      )}
    </div>
  );
}
