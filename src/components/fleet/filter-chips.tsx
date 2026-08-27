"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type Chip = {
  key: string;
  label: string;
  count: number;
  /** Semantic tone applied when the chip is selected. */
  tone?: "default" | "bad" | "warn";
};

/**
 * Status filter chips carrying their own counts.
 *
 * The count is on the chip rather than behind it: a fleet controller opening
 * this screen wants "three blocked" before deciding what to click, and a
 * chip that reads zero saves them the click entirely.
 */
export function FilterChips({
  param,
  chips,
  selected,
  extra,
}: {
  param: string;
  chips: Chip[];
  selected?: string;
  extra?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function setParam(value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(param, value);
    else next.delete(param);
    next.delete("page");
    router.replace(`${pathname}?${next}`);
  }

  function clearAll() {
    const next = new URLSearchParams(params);
    const q = next.get("q");
    const cleared = new URLSearchParams();
    if (q) cleared.set("q", q);
    router.replace(cleared.size ? `${pathname}?${cleared}` : pathname);
  }

  const anyFiltered = [...params.keys()].some((key) => key !== "q" && key !== "page");

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {chips.map((chip) => {
        const active = selected === chip.key;
        return (
          <button
            key={chip.key}
            type="button"
            onClick={() => setParam(active ? null : chip.key)}
            aria-pressed={active}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition-colors",
              active
                ? chip.tone === "bad"
                  ? "border-bad/50 bg-bad-muted text-bad"
                  : chip.tone === "warn"
                    ? "border-warn/50 bg-warn-muted text-warn"
                    : "border-primary bg-accent text-accent-foreground"
                : "bg-card hover:bg-muted",
              chip.count === 0 && !active && "opacity-55",
            )}
          >
            <span>{chip.label}</span>
            <span
              className={cn(
                "font-mono text-xs tabular",
                active ? "" : "text-muted-foreground",
              )}
            >
              {chip.count}
            </span>
          </button>
        );
      })}

      {extra}

      {anyFiltered && (
        <Button variant="ghost" size="sm" onClick={clearAll}>
          <X />
          Clear
        </Button>
      )}
    </div>
  );
}

/** A plain select that writes one search param. Pairs with the chips above. */
export function FilterSelect({
  param,
  label,
  value,
  options,
}: {
  param: string;
  label: string;
  value?: string;
  options: Array<{ value: string; label: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  return (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(event) => {
        const next = new URLSearchParams(params);
        if (event.target.value) next.set(param, event.target.value);
        else next.delete(param);
        next.delete("page");
        router.replace(`${pathname}?${next}`);
      }}
      className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
