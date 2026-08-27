"use client";

import { useActionState, useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createManifestAction, type ManifestState } from "./actions";

const IDLE: ManifestState = {};

export type BranchOption = { id: string; code: string; name: string };
export type TripOption = {
  id: string;
  number: string;
  originBranchId: string;
  destinationBranchId: string;
  vehicle: string;
};

/**
 * Creating a manifest is three decisions: which lane, and optionally which
 * vehicle. The vehicle list narrows to trips that actually start where the
 * manifest starts, because offering the rest is offering a mistake.
 */
export function CreateManifestDialog({
  branches,
  originBranches,
  defaultOriginId,
  trips,
}: {
  branches: BranchOption[];
  originBranches: BranchOption[];
  defaultOriginId: string | null;
  trips: TripOption[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createManifestAction, IDLE);
  const [originId, setOriginId] = useState(
    defaultOriginId ?? originBranches[0]?.id ?? "",
  );

  const eligibleTrips = useMemo(
    () => trips.filter((trip) => trip.originBranchId === originId),
    [trips, originId],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <Plus />
            New manifest
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <form action={formAction}>
          <DialogHeader>
            <DialogTitle>New manifest</DialogTitle>
            <DialogDescription>
              One leg, one document. You can add consignments and assign a
              vehicle after it exists.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="originBranchId">From</Label>
              <select
                id="originBranchId"
                name="originBranchId"
                value={originId}
                onChange={(event) => setOriginId(event.target.value)}
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
              >
                {originBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.code} — {branch.name}
                  </option>
                ))}
              </select>
              {state.fieldErrors?.originBranchId && (
                <p className="text-xs text-bad">{state.fieldErrors.originBranchId}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="destinationBranchId">To</Label>
              <select
                id="destinationBranchId"
                name="destinationBranchId"
                defaultValue=""
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
              >
                <option value="" disabled>
                  Choose a destination
                </option>
                {branches
                  .filter((branch) => branch.id !== originId)
                  .map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.code} — {branch.name}
                    </option>
                  ))}
              </select>
              {state.fieldErrors?.destinationBranchId && (
                <p className="text-xs text-bad">
                  {state.fieldErrors.destinationBranchId}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tripId">Vehicle (optional)</Label>
              <select
                id="tripId"
                name="tripId"
                defaultValue=""
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
              >
                <option value="">Decide later</option>
                {eligibleTrips.map((trip) => (
                  <option key={trip.id} value={trip.id}>
                    {trip.number} · {trip.vehicle}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {eligibleTrips.length === 0
                  ? "No planned trip leaves that branch yet. Utilisation appears once a vehicle is attached."
                  : "Attaching a vehicle now is what makes the capacity bar meaningful."}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="remarks">Remarks</Label>
              <Textarea id="remarks" name="remarks" rows={2} maxLength={300} />
            </div>
          </div>

          {state.error && <p className="pb-2 text-sm text-bad">{state.error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
