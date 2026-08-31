"use client";

import { useId, useState, useTransition } from "react";
import { Loader2, Ban } from "lucide-react";
import { toast } from "sonner";
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
import { cancelPickup } from "./actions";
import type { ActionState } from "@/server/services/master-crud";

const EMPTY: ActionState = {};

/**
 * Calling a collection off.
 *
 * The reason is mandatory and goes into the request's own `cancelReason`
 * column — it used to be written over `notes`, which is where the branch
 * keeps the gate code and whom to ask for. Cancelling also takes the stop
 * off the executive's run; the dialog says so, because an executive already
 * driving there is the thing this is meant to prevent.
 */
export function CancelPickupDialog({
  pickupId,
  pickupNumber,
  assigneeName,
}: {
  pickupId: string;
  pickupNumber: string;
  assigneeName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ActionState>(EMPTY);
  const [pending, startTransition] = useTransition();
  const formId = useId();

  // By hand, so a rejected reason is still in the box to correct rather
  // than wiped by React 19's automatic reset after a form action.
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await cancelPickup(EMPTY, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Cancelled.");
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
        render={<Button variant="ghost" size="sm" title="Cancel this pickup" />}
      >
        <Ban />
        Cancel
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel {pickupNumber}</DialogTitle>
          <DialogDescription>
            {assigneeName
              ? `${assigneeName} is carrying this stop. Cancelling takes it off their run.`
              : "Nobody is carrying this stop yet."}{" "}
            The reason is kept against the request; the branch&rsquo;s notes
            for the executive are left alone.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={pickupId} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-reason`}>Why</Label>
            <Textarea
              id={`${formId}-reason`}
              name="reason"
              rows={3}
              maxLength={300}
              required
              placeholder="Consignor postponed to next week"
            />
            {state.fieldErrors?.reason && (
              <p className="text-xs text-bad">{state.fieldErrors.reason}</p>
            )}
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
            Keep it
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="destructive"
            disabled={pending}
          >
            {pending && <Loader2 className="animate-spin" />}
            Cancel pickup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
