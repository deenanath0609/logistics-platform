"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
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
import { resolveReceiptDiscrepancy, type ResolveState } from "../actions";

const IDLE: ResolveState = {};

/**
 * Settling a discrepancy.
 *
 * The row is never deleted — a shortage that turns out to have been found
 * behind a pallet is still a shortage that happened, and the branch
 * performance report needs to know it occurred as well as how it ended.
 */
export function ResolveDiscrepancyButton({
  discrepancyId,
  label,
}: {
  discrepancyId: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ResolveState>(IDLE);
  const [pending, startTransition] = useTransition();

  // The dialog closes from the action's result rather than from an effect
  // watching it: the close is a consequence of the submit, not of a render.
  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await resolveReceiptDiscrepancy(IDLE, formData);
      setState(result);
      if (result.ok) {
        toast.success("Discrepancy resolved.");
        setOpen(false);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="xs">
            Resolve
          </Button>
        }
      />
      <DialogContent>
        <form action={submit}>
          <input type="hidden" name="discrepancyId" value={discrepancyId} />

          <DialogHeader>
            <DialogTitle>Resolve discrepancy</DialogTitle>
            <DialogDescription>{label}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5 py-4">
            <Label htmlFor="resolution">What was the outcome?</Label>
            <Textarea
              id="resolution"
              name="resolution"
              rows={3}
              maxLength={500}
              required
              placeholder="Found in the sort area and scanned in. Origin branch confirmed it was loaded."
            />
            <p className="text-xs text-muted-foreground">
              The discrepancy stays on the record. This adds the outcome
              beside it.
            </p>
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
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
