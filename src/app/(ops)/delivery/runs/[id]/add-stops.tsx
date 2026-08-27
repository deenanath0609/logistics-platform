"use client";

import { useMemo, useState, useTransition } from "react";
import { PackagePlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { addStopsAction, type RunActionState } from "../actions";

export type Candidate = {
  id: string;
  lrNumber: string;
  consigneeName: string;
  address: string;
  packageCount: number;
  codAmount: number;
  attemptCount: number;
};

/**
 * Choosing the stops.
 *
 * The running COD total is shown as shipments are ticked, because that is
 * the number the agent signs for — finding it out at day end is too late.
 */
export function AddStopsPanel({
  runId,
  branchCode,
  candidates,
}: {
  runId: string;
  branchCode: string;
  candidates: Candidate[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    startTransition(async () => {
      const result: RunActionState = await addStopsAction({}, formData);
      if (result.message) {
        toast.success(result.message);
        setSelected(new Set());
      }
      if (result.error) toast.error(result.error);
    });
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter(
      (row) =>
        row.lrNumber.toLowerCase().includes(needle) ||
        row.consigneeName.toLowerCase().includes(needle) ||
        row.address.toLowerCase().includes(needle),
    );
  }, [candidates, query]);

  const codTotal = candidates
    .filter((row) => selected.has(row.id))
    .reduce((sum, row) => sum + row.codAmount, 0);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Waiting at {branchCode} — {candidates.length}
        </h2>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="LR, consignee, address"
          className="h-8 w-56"
        />
      </div>

      {candidates.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Nothing is sitting at {branchCode} awaiting delivery.
        </p>
      ) : (
        <form action={submit} className="flex flex-col gap-3">
          <input type="hidden" name="runId" value={runId} />

          <div className="max-h-[420px] overflow-y-auto rounded-lg border bg-card">
            <ul className="divide-y">
              {visible.map((row) => {
                const checked = selected.has(row.id);
                return (
                  <li key={row.id}>
                    <label className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-muted/50">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(row.id)}
                        className="mt-0.5"
                      />
                      {checked && (
                        <input type="hidden" name="shipmentIds" value={row.id} />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-xs font-medium">
                            {row.lrNumber}
                          </span>
                          <span className="text-sm">{row.consigneeName}</span>
                          {row.attemptCount > 0 && (
                            <span className="rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-warn">
                              {row.attemptCount} failed attempt
                              {row.attemptCount > 1 ? "s" : ""}
                            </span>
                          )}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {row.address}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
                        <span className="tabular text-muted-foreground">
                          {row.packageCount} pkg
                        </span>
                        {row.codAmount > 0 && (
                          <span className="tabular font-medium text-warn">
                            ₹{row.codAmount.toLocaleString("en-IN")}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
              {visible.length === 0 && (
                <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Nothing matches “{query}”.
                </li>
              )}
            </ul>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {selected.size} selected
              {codTotal > 0 && (
                <>
                  {" · "}
                  <span className="font-medium text-warn tabular">
                    ₹{codTotal.toLocaleString("en-IN")} COD
                  </span>{" "}
                  the agent will be accountable for
                </>
              )}
            </p>
            <Button type="submit" disabled={pending || selected.size === 0}>
              <PackagePlus />
              {pending ? "Adding…" : `Add ${selected.size || ""} to run`}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
