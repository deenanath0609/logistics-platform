"use client";

import { useState, useTransition } from "react";
import { Loader2, Lock, Unlock } from "lucide-react";
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
import {
  closeManifestAction,
  reopenManifestAction,
  type ManifestState,
} from "../actions";

const IDLE: ManifestState = {};

/**
 * Close and reopen.
 *
 * Closing shows the utilisation one last time, because this is the last
 * moment anyone can decide the truck is too empty to be worth sending.
 */
export function ManifestActions({
  manifestId,
  canClose,
  canReopen,
  lineCount,
  utilisationPercent,
  utilisationLabel,
}: {
  manifestId: string;
  canClose: boolean;
  canReopen: boolean;
  lineCount: number;
  utilisationPercent: number | null;
  utilisationLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ManifestState>(IDLE);
  const [pending, startTransition] = useTransition();

  function run(
    action: (prev: ManifestState, formData: FormData) => Promise<ManifestState>,
  ) {
    return (formData: FormData) => {
      startTransition(async () => {
        const result = await action(IDLE, formData);
        setState(result);
        if (result.ok) {
          toast.success(result.message ?? "Done.");
          setOpen(false);
        } else if (result.error) {
          toast.error(result.error);
        }
      });
    };
  }

  if (canClose) {
    const lightLoad = utilisationPercent !== null && utilisationPercent < 60;

    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button disabled={lineCount === 0} />}>
          <Lock />
          Close for dispatch
        </DialogTrigger>

        <DialogContent>
          <form action={run(closeManifestAction)}>
            <input type="hidden" name="manifestId" value={manifestId} />

            <DialogHeader>
              <DialogTitle>Close for dispatch</DialogTitle>
              <DialogDescription>
                {lineCount} consignment{lineCount === 1 ? "" : "s"} on the
                truck. After this the lines are frozen — they are what the
                receiving hub reconciles against.
              </DialogDescription>
            </DialogHeader>

            {utilisationPercent !== null && (
              <div
                className={
                  lightLoad
                    ? "my-4 rounded-md bg-warn-muted px-3 py-2 text-sm text-warn"
                    : "my-4 rounded-md bg-ok-muted px-3 py-2 text-sm text-ok"
                }
              >
                <span className="font-mono font-semibold">{utilisationPercent}%</span>{" "}
                of the vehicle&rsquo;s payload. {utilisationLabel}.
              </div>
            )}

            {state.error && <p className="pb-2 text-sm text-bad">{state.error}</p>}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Keep loading
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                Close manifest
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  if (canReopen) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button variant="outline" />}>
          <Unlock />
          Reopen
        </DialogTrigger>

        <DialogContent>
          <form action={run(reopenManifestAction)}>
            <input type="hidden" name="manifestId" value={manifestId} />

            <DialogHeader>
              <DialogTitle>Reopen this manifest</DialogTitle>
              <DialogDescription>
                Only possible before the vehicle gates out. The reason is
                written to the audit trail.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-1.5 py-4">
              <Label htmlFor="reopen-reason">Why?</Label>
              <Textarea
                id="reopen-reason"
                name="reason"
                rows={3}
                required
                maxLength={300}
                placeholder="Two consignments were loaded on the wrong truck and need removing."
              />
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
                Reopen
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  return null;
}
