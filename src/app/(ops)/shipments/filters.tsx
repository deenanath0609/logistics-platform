"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SHIPMENT_MODES, SHIPMENT_MODE_SHORT } from "@/lib/shipment/modes";

export function ShipmentFilters({
  groups,
  selectedGroup,
  selectedMode,
}: {
  groups: Array<{ key: string; label: string; count: number }>;
  selectedGroup?: string;
  selectedMode?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    router.replace(`${pathname}?${next}`);
  }

  const filtered = Boolean(selectedGroup || selectedMode);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {groups.map((group) => {
        const active = selectedGroup === group.key;
        return (
          <button
            key={group.key}
            type="button"
            onClick={() => setParam("group", active ? null : group.key)}
            aria-pressed={active}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition-colors",
              active
                ? "border-primary bg-accent text-accent-foreground"
                : "bg-card hover:bg-muted",
              group.count === 0 && !active && "opacity-55",
            )}
          >
            <span>{group.label}</span>
            <span className="font-mono text-xs tabular text-muted-foreground">
              {group.count}
            </span>
          </button>
        );
      })}

      <select
        aria-label="Filter by mode"
        value={selectedMode ?? ""}
        onChange={(e) => setParam("mode", e.target.value || null)}
        className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value="">All modes</option>
        {SHIPMENT_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {SHIPMENT_MODE_SHORT[mode]}
          </option>
        ))}
      </select>

      {filtered && (
        <Button variant="ghost" size="sm" onClick={() => router.replace(pathname)}>
          <X />
          Clear
        </Button>
      )}
    </div>
  );
}
