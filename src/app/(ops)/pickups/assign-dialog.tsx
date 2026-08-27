"use client";

import { useId, useState, useTransition } from "react";
import { Loader2, UserPlus, Sparkles } from "lucide-react";
import { toast } from "sonner";
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
import { assignPickup } from "./actions";
import type { ActionState } from "@/server/services/master-crud";

const EMPTY: ActionState = {};

export type ExecutiveChoice = {
  id: string;
  name: string;
  assigned: number;
  packages: number;
  /** The lightest load, computed on the server. */
  suggested: boolean;
};

export function AssignDialog({
  pickupId,
  pickupNumber,
  executives,
  currentAssigneeId,
  nextSequence,
}: {
  pickupId: string;
  pickupNumber: string;
  executives: ExecutiveChoice[];
  currentAssigneeId?: string | null;
  nextSequence: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ActionState>(EMPTY);
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState(
    currentAssigneeId ?? executives.find((e) => e.suggested)?.id ?? "",
  );
  const formId = useId();

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await assignPickup(EMPTY, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Assigned.");
        setOpen(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setState(EMPTY);
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={<Button variant="outline" size="sm" />}
      >
        <UserPlus />
        {currentAssigneeId ? "Reassign" : "Assign"}
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign {pickupNumber}</DialogTitle>
          <DialogDescription>
            Load is measured in packages, not stops — ten single-carton
            collections are not the same job as one forty-package load.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} action={submit} className="flex flex-col gap-3">
          <input type="hidden" name="pickupRequestId" value={pickupId} />
          <input type="hidden" name="assignedToId" value={selected} />

          <div className="flex flex-col gap-1.5">
            {executives.length === 0 && (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                No pickup executives at this branch. Add one under
                Administration → Users with the Pickup Executive role.
              </p>
            )}

            {executives.map((executive) => {
              const active = selected === executive.id;
              return (
                <button
                  key={executive.id}
                  type="button"
                  onClick={() => setSelected(executive.id)}
                  aria-pressed={active}
                  className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                    active
                      ? "border-primary bg-accent"
                      : "hover:bg-muted"
                  }`}
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {executive.name}
                      {executive.suggested && (
                        <span
                          className="inline-flex items-center gap-1 rounded-sm bg-ok-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-ok"
                          title="Lightest load today"
                        >
                          <Sparkles className="size-2.5" />
                          Suggested
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground tabular">
                      {executive.assigned} stop
                      {executive.assigned === 1 ? "" : "s"} ·{" "}
                      {executive.packages} package
                      {executive.packages === 1 ? "" : "s"} today
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-seq`}>Stop number</Label>
            <Input
              id={`${formId}-seq`}
              name="sequence"
              type="number"
              min={0}
              defaultValue={nextSequence}
              className="w-28 font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Order in the executive&rsquo;s run. Route optimisation arrives
              in Phase 8.
            </p>
          </div>

          {state.error && (
            <p
              role="alert"
              className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
            >
              {state.error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={pending || !selected}
          >
            {pending && <Loader2 className="animate-spin" />}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
