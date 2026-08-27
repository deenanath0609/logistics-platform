"use client";

import { useMemo, useState, useTransition } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { utilisation } from "@/lib/transport/capacity";
import { cn } from "@/lib/utils";
import { addShipmentsAction, type ManifestState } from "../actions";

const IDLE: ManifestState = {};

export type CandidateShipment = {
  id: string;
  lrNumber: string;
  consigneeName: string;
  packageCount: number;
  weightKg: number;
  destinationCode: string;
  /** True when this leg is the consignment's last one. */
  isDirect: boolean;
};

/**
 * Picking freight for the truck.
 *
 * The projected utilisation updates as boxes are ticked, so the decision
 * "is this enough to send" is made while selecting rather than discovered
 * after closing. Consignments transshipping onward are marked, because
 * putting one on the wrong leg is the expensive kind of mistake.
 */
export function AddShipments({
  manifestId,
  destinationCode,
  candidates,
  capacityKg,
  currentWeightKg,
}: {
  manifestId: string;
  destinationCode: string;
  candidates: CandidateShipment[];
  capacityKg: number | null;
  currentWeightKg: number;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();

  // Clearing the selection is a consequence of a successful submit, so it
  // happens where the result arrives rather than in an effect watching it.
  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await addShipmentsAction(IDLE, formData);
      if (result.ok && result.message) {
        toast.success(result.message);
        setSelected(new Set());
      } else if (result.error) {
        toast.error(result.error, { duration: 10_000 });
      }
    });
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (c) =>
        c.lrNumber.toLowerCase().includes(q) ||
        c.consigneeName.toLowerCase().includes(q) ||
        c.destinationCode.toLowerCase().includes(q),
    );
  }, [candidates, query]);

  const projected = useMemo(() => {
    const added = candidates
      .filter((c) => selected.has(c.id))
      .reduce((sum, c) => sum + c.weightKg, 0);
    return utilisation(currentWeightKg + added, capacityKg);
  }, [candidates, selected, currentWeightKg, capacityKg]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (candidates.length === 0) {
    return (
      <section className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        Nothing is sorted and waiting at this branch. Consignments appear here
        once they are processed on the floor — a booking that has not been
        sorted has no confirmed route, and manifesting it is how freight ends
        up in the wrong city.
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Awaiting dispatch — {candidates.length}
        </h2>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="LR, consignee, destination"
          className="h-7 w-56"
        />
      </div>

      <form action={submit} className="flex flex-col gap-3">
        <input type="hidden" name="manifestId" value={manifestId} />
        {[...selected].map((id) => (
          <input key={id} type="hidden" name="shipmentIds" value={id} />
        ))}

        <div className="max-h-72 overflow-y-auto rounded-md border">
          <ul className="divide-y">
            {filtered.map((candidate) => {
              const isSelected = selected.has(candidate.id);
              return (
                <li key={candidate.id}>
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors",
                      isSelected ? "bg-accent" : "hover:bg-muted",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(candidate.id)}
                      className="accent-primary"
                    />
                    <span className="w-40 shrink-0 font-mono text-xs font-medium">
                      {candidate.lrNumber}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {candidate.consigneeName}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider",
                        candidate.isDirect
                          ? "bg-ok-muted text-ok"
                          : "bg-warn-muted text-warn",
                      )}
                      title={
                        candidate.isDirect
                          ? `Final destination is ${destinationCode}`
                          : "Transships onward from the destination of this leg"
                      }
                    >
                      {candidate.destinationCode}
                    </span>
                    <span className="w-16 shrink-0 text-right font-mono text-xs tabular">
                      {candidate.packageCount} pkg
                    </span>
                    <span className="w-20 shrink-0 text-right font-mono text-xs tabular">
                      {candidate.weightKg} kg
                    </span>
                  </label>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing matches “{query}”.
              </li>
            )}
          </ul>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {selected.size === 0 ? (
              "Tick the consignments going on this truck."
            ) : (
              <>
                <span className="font-semibold text-foreground">
                  {selected.size} selected
                </span>
                {projected.percent !== null && (
                  <>
                    {" · would take the truck to "}
                    <span
                      className={
                        projected.tone === "bad"
                          ? "font-semibold text-bad"
                          : projected.tone === "warn"
                            ? "font-semibold text-warn"
                            : "font-semibold text-ok"
                      }
                    >
                      {projected.percent}%
                    </span>
                  </>
                )}
              </>
            )}
          </p>

          <Button type="submit" size="sm" disabled={pending || selected.size === 0}>
            {pending ? <Loader2 className="animate-spin" /> : <Plus />}
            Add to manifest
          </Button>
        </div>
      </form>
    </section>
  );
}
