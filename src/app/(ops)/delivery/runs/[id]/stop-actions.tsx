"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CornerUpLeft, Undo2 } from "lucide-react";
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
import { initiateRtoAction, removeStopAction, type RunActionState } from "../actions";

/**
 * The two things a desk does to a stop that the agent cannot.
 *
 * Both server actions existed, validated and audited, with no control
 * anywhere in the product that reached them. `removeStopAction` meant a
 * parcel loaded onto the wrong run had to stay there; `initiateRtoAction`
 * meant the end of the attempt ladder — the thing the whole attempt policy
 * counts towards — could not actually be taken. `nextAction` returned
 * `RTO`, the outbox announced `RTO`, and nobody could do it.
 */

export type RtoReason = { id: string; code: string; name: string };

/** Takes a stop off the run. The consignment stays at the branch. */
export function RemoveStopButton({
  taskId,
  runId,
  lrNumber,
}: {
  taskId: string;
  runId: string;
  lrNumber: string;
}) {
  const [pending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("taskId", taskId);
      formData.set("runId", runId);
      const result: RunActionState = await removeStopAction({}, formData);
      if (result.message) toast.success(result.message);
      if (result.error) toast.error(result.error);
    });
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={pending}
      onClick={remove}
      aria-label={`Take ${lrNumber} off this run`}
      title={`Take ${lrNumber} off this run`}
    >
      <Undo2 />
    </Button>
  );
}

/**
 * Sending it back to the sender.
 *
 * A separate permission and a reason code, because a consignment going back
 * costs the customer money and somebody has to own the decision. The
 * attempt ladder proposes it; this is where a person takes it.
 */
export function RtoDialog({
  shipmentId,
  lrNumber,
  consigneeName,
  attemptCount,
  maxAttempts,
  reasons,
}: {
  shipmentId: string;
  lrNumber: string;
  consigneeName: string;
  attemptCount: number;
  maxAttempts: number;
  reasons: RtoReason[];
}) {
  const [open, setOpen] = useState(false);
  const [reasonCodeId, setReasonCodeId] = useState(reasons[0]?.id ?? "");
  const [remarks, setRemarks] = useState("");
  const [pending, startTransition] = useTransition();

  // `onSubmit` with `preventDefault`, not `<form action>`: React 19 resets
  // an uncontrolled form after an action, and a refused return would empty
  // the note the person had just written.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reasonCodeId) {
      toast.error("Choose a return reason.");
      return;
    }

    startTransition(async () => {
      const formData = new FormData();
      formData.set("shipmentId", shipmentId);
      formData.set("reasonCodeId", reasonCodeId);
      formData.set("remarks", remarks);

      const result: RunActionState = await initiateRtoAction({}, formData);
      if (result.message) {
        toast.success(result.message);
        setRemarks("");
        setOpen(false);
      }
      if (result.error) toast.error(result.error);
    });
  }

  const exhausted = attemptCount >= maxAttempts;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant={exhausted ? "outline" : "ghost"}
            size="sm"
            className={exhausted ? "border-bad/50 text-bad" : undefined}
            title={`Send ${lrNumber} back to the sender`}
          />
        }
      >
        <CornerUpLeft />
        Return
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Send {lrNumber} back to the sender</DialogTitle>
            <DialogDescription>
              {attemptCount} of {maxAttempts} attempts made on{" "}
              {consigneeName}
              {exhausted
                ? ". The allowance is spent — a return is what the policy proposes."
                : ". The allowance is not spent yet; returning early is a decision you own."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <Label>Reason</Label>
              {reasons.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                  No return reasons are configured. Add one under Masters →
                  Reason codes first.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {reasons.map((reason) => (
                    <button
                      key={reason.id}
                      type="button"
                      onClick={() => setReasonCodeId(reason.id)}
                      className={`rounded-lg border px-3 py-2 text-left text-sm ${
                        reasonCodeId === reason.id
                          ? "border-primary bg-accent"
                          : "bg-card hover:bg-muted"
                      }`}
                    >
                      {reason.name}
                      <span className="ml-2 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                        {reason.code}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rtoRemarks">Note</Label>
              <Textarea
                id="rtoRemarks"
                value={remarks}
                onChange={(event) => setRemarks(event.target.value)}
                rows={2}
                placeholder="What the consignor will be told"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending || reasons.length === 0}>
              {pending ? "Returning…" : "Initiate return"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
