"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FilterKey } from "@/lib/reports/types";
import { SHIPMENT_MODES, SHIPMENT_MODE_SHORT } from "@/lib/shipment/modes";

/**
 * The filter bar every report shares.
 *
 * State lives in the query string rather than in the component, so a
 * filtered report is shareable by pasting the URL — which is how these
 * actually get passed around an operations floor, and it is also what
 * makes the export link correct without any extra plumbing.
 *
 * Applying is a button rather than a change handler. A date range needs
 * both ends before it means anything, and firing a query on every
 * keystroke of "2026-08-2" produces four wrong reports on the way to the
 * right one.
 */

export type Option = { value: string; label: string };

export type FilterOptions = {
  branches: Option[];
  customers: Option[];
  serviceTypes: Option[];
};

const MODES: Option[] = SHIPMENT_MODES.map((mode) => ({
  value: mode,
  label: SHIPMENT_MODE_SHORT[mode],
}));

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function ReportFilterBar({
  filters,
  options,
  current,
}: {
  /** Which controls this report actually honours. */
  filters: FilterKey[];
  options: FilterOptions;
  current: Record<string, string>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Record<string, string>>(current);

  const show = (key: FilterKey) => filters.includes(key);

  function set(key: string, value: string) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  function apply() {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(draft)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    // A new filter set is a new first page. Keeping the page number is
    // how somebody lands on "page 7 of 2" and assumes the report is broken.
    next.delete("page");
    startTransition(() => router.replace(`${pathname}?${next}`));
  }

  function clear() {
    setDraft({});
    startTransition(() => router.replace(pathname));
  }

  const dirty = Object.entries(draft).some(
    ([key, value]) => (current[key] ?? "") !== value,
  );

  return (
    <section
      aria-label="Report filters"
      className="mb-5 flex flex-col gap-3 rounded-lg border bg-card p-3"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {show("dates") && (
          <>
            <Field label="From" htmlFor="filter-from">
              <Input
                id="filter-from"
                type="date"
                value={draft.from ?? ""}
                onChange={(event) => set("from", event.target.value)}
              />
            </Field>
            <Field label="To" htmlFor="filter-to">
              <Input
                id="filter-to"
                type="date"
                value={draft.to ?? ""}
                onChange={(event) => set("to", event.target.value)}
              />
            </Field>
          </>
        )}

        {show("branch") && (
          <Field label="Branch" htmlFor="filter-branch">
            <Select
              id="filter-branch"
              placeholder="All branches you can see"
              value={draft.branchId ?? ""}
              options={options.branches}
              onChange={(value) => set("branchId", value)}
            />
          </Field>
        )}

        {show("customer") && (
          <Field label="Customer" htmlFor="filter-customer">
            <Select
              id="filter-customer"
              placeholder="Every customer"
              value={draft.customerId ?? ""}
              options={options.customers}
              onChange={(value) => set("customerId", value)}
            />
          </Field>
        )}

        {show("lane") && (
          <>
            <Field label="Lane origin" htmlFor="filter-origin">
              <Select
                id="filter-origin"
                placeholder="Anywhere"
                value={draft.originBranchId ?? ""}
                options={options.branches}
                onChange={(value) => set("originBranchId", value)}
              />
            </Field>
            <Field label="Lane destination" htmlFor="filter-destination">
              <Select
                id="filter-destination"
                placeholder="Anywhere"
                value={draft.destinationBranchId ?? ""}
                options={options.branches}
                onChange={(value) => set("destinationBranchId", value)}
              />
            </Field>
          </>
        )}

        {show("serviceType") && (
          <Field label="Service type" htmlFor="filter-service">
            <Select
              id="filter-service"
              placeholder="Every service"
              value={draft.serviceTypeId ?? ""}
              options={options.serviceTypes}
              onChange={(value) => set("serviceTypeId", value)}
            />
          </Field>
        )}

        {show("mode") && (
          <Field label="Mode" htmlFor="filter-mode">
            <Select
              id="filter-mode"
              placeholder="Every mode"
              value={draft.mode ?? ""}
              options={MODES}
              onChange={(value) => set("mode", value)}
            />
          </Field>
        )}

        {show("search") && (
          <Field label="Search" htmlFor="filter-q">
            <Input
              id="filter-q"
              value={draft.q ?? ""}
              placeholder="LR, reference or consignee"
              onChange={(event) => set("q", event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") apply();
              }}
            />
          </Field>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        {Object.values(current).some(Boolean) && (
          <Button variant="ghost" size="sm" onClick={clear} disabled={pending}>
            <X />
            Clear
          </Button>
        )}
        <Button size="sm" onClick={apply} disabled={pending || !dirty}>
          {pending && <Loader2 className="animate-spin" />}
          Apply filters
        </Button>
      </div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label
        htmlFor={htmlFor}
        className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground"
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

function Select({
  id,
  value,
  options,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  options: Option[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
