"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
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
import { createRunAction, type RunActionState } from "./actions";

export type Option = { id: string; label: string; hint?: string };

/**
 * Building a run starts with three facts: who is driving it, out of which
 * branch, and on what day. The stops come next, on the run's own screen,
 * because choosing them needs the whole list of what is sitting at the hub.
 */
export function NewRunForm({
  branches,
  agents,
  vehicles,
  defaultBranchId,
  defaultDate,
}: {
  branches: Option[];
  agents: Option[];
  vehicles: Option[];
  defaultBranchId: string;
  defaultDate: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RunActionState>({});
  const [pending, startTransition] = useTransition();

  // A transition rather than `useActionState`: closing on success belongs
  // at the call site, not in an effect that fires an extra render every
  // time the action returns.
  //
  // And `onSubmit` with `preventDefault` rather than `<form action={fn}>`:
  // React 19 resets an uncontrolled form once an action returns, so a
  // refused run — a missing number series is the common one — emptied the
  // branch, the agent and the date the dispatcher had just chosen while
  // leaving the dialog open in front of them.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await createRunAction({}, formData);
      setState(result);
      if (result.message) {
        toast.success(result.message);
        setOpen(false);
      }
      if (result.error) toast.error(result.error);
    });
  }

  function handleOpenChange(next: boolean) {
    if (next) setState({});
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button />}>
        <Plus />
        New run
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Build a delivery run</DialogTitle>
            <DialogDescription>
              One agent, one day. Add the stops once it exists.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <Field label="Branch" error={state.fieldErrors?.branchId}>
              <select
                name="branchId"
                defaultValue={defaultBranchId}
                className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
              >
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Agent" error={state.fieldErrors?.agentId}>
              <select
                name="agentId"
                className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
              >
                <option value="">Choose an agent…</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                    {agent.hint ? ` · ${agent.hint}` : ""}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Vehicle" hint="Optional — many runs go out on foot or on a two-wheeler that is not on the fleet.">
              <select
                name="vehicleId"
                className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
              >
                <option value="">No vehicle</option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicle.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Date" error={state.fieldErrors?.runDate}>
              <Input type="date" name="runDate" defaultValue={defaultDate} />
            </Field>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create run"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
