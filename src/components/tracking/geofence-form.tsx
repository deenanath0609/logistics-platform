"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  saveGeofenceAction,
  type GeofenceState,
} from "@/app/(ops)/tracking/geofences/actions";

const IDLE: GeofenceState = {};

export type FenceRow = {
  id: string;
  name: string;
  branchId: string | null;
  radiusMeters: number | null;
  debouncePings: number;
  isActive: boolean;
};

export type BranchChoice = { id: string; code: string; name: string; hasCoordinates: boolean };

/**
 * Editing the two numbers that decide how much of the operation automates
 * itself: the radius that has to enclose the yard, and the debounce that
 * decides how many agreeing fixes are believed before an arrival fires.
 */
export function GeofenceDialog({
  fence,
  branches,
  pollSeconds,
}: {
  fence?: FenceRow;
  branches: BranchChoice[];
  /**
   * The process tick, in seconds, so the latency arithmetic below is this
   * deployment's rather than a hard-coded thirty. A fence tuned against the
   * wrong number is tuned against nothing.
   */
  pollSeconds: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<GeofenceState>(IDLE);
  const [pending, startTransition] = useTransition();
  const [debounce, setDebounce] = useState(fence?.debouncePings ?? 2);

  /**
   * Submitted by hand rather than through `<form action={…}>`.
   *
   * React 19 resets an uncontrolled form the moment a form action returns,
   * and every field here but the debounce is uncontrolled. A radius of ten
   * metres used to answer "check the highlighted fields" over a form that
   * had just thrown away the node, the name and the radius — the highlight
   * pointing at a box that had been refilled with its default. Same shape
   * as `components/data/master-form.tsx`, for the same reason.
   */
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      setState(await saveGeofenceAction(IDLE, formData));
    });
  }

  function handleOpenChange(next: boolean) {
    // Reopening starts clean rather than showing the last save's outcome.
    if (next) setState(IDLE);
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          fence ? (
            <Button variant="outline" size="sm">
              Edit
            </Button>
          ) : (
            <Button>
              <Plus />
              New fence
            </Button>
          )
        }
      />
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit}>
          <input type="hidden" name="id" value={fence?.id ?? ""} />

          <DialogHeader>
            <DialogTitle>{fence ? `Edit ${fence.name}` : "New site geofence"}</DialogTitle>
            <DialogDescription>
              A circle around one of our own nodes. Entering it generates an
              arrival on every consignment aboard, which is where most manual
              status updating disappears.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fence-branch">Node</Label>
              <select
                id="fence-branch"
                name="branchId"
                defaultValue={fence?.branchId ?? ""}
                required
                className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="" disabled>
                  Choose a branch or hub
                </option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id} disabled={!branch.hasCoordinates}>
                    {branch.code} — {branch.name}
                    {branch.hasCoordinates ? "" : " (no coordinates)"}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                The centre comes from the branch&apos;s own coordinates, so the
                fence and the node can never drift apart.
              </p>
              {state.fieldErrors?.branchId && (
                <p className="text-xs text-destructive">{state.fieldErrors.branchId}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fence-name">Name</Label>
              <Input
                id="fence-name"
                name="name"
                defaultValue={fence?.name ?? ""}
                placeholder="Delhi hub — site"
                required
              />
              {state.fieldErrors?.name && (
                <p className="text-xs text-destructive">{state.fieldErrors.name}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fence-radius">Radius (metres)</Label>
                <Input
                  id="fence-radius"
                  name="radiusMeters"
                  type="number"
                  min={50}
                  max={20000}
                  step={10}
                  defaultValue={fence?.radiusMeters ?? 300}
                />
                {state.fieldErrors?.radiusMeters && (
                  <p className="text-xs text-destructive">{state.fieldErrors.radiusMeters}</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fence-debounce">Consecutive pings</Label>
                <Input
                  id="fence-debounce"
                  name="debouncePings"
                  type="number"
                  min={1}
                  max={20}
                  value={debounce}
                  onChange={(event) => setDebounce(Number(event.target.value) || 1)}
                />
                {state.fieldErrors?.debouncePings && (
                  <p className="text-xs text-destructive">{state.fieldErrors.debouncePings}</p>
                )}
              </div>
            </div>

            <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              At {debounce} agreeing fix{debounce === 1 ? "" : "es"} and a{" "}
              {pollSeconds}-second poll, an arrival lands about{" "}
              <span className="tabular text-foreground">
                {debounce * pollSeconds}
              </span>{" "}
              seconds after the truck is genuinely inside. That delay is what
              stops a vehicle idling on the boundary generating an arrival on
              every consignment aboard, over and over.
            </p>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="isActive"
                defaultChecked={fence?.isActive ?? true}
                className="size-4 accent-primary"
              />
              Active
            </label>

            {state.error && <p className="text-sm text-destructive">{state.error}</p>}
            {state.ok && <p className="text-sm text-ok">{state.message}</p>}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              {fence ? "Save" : "Create fence"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
