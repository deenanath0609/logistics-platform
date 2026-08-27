"use client";

import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, ListOrdered } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { resequenceAction, type RunActionState } from "../actions";

export type Stop = { id: string; label: string };

/**
 * Manual sequencing.
 *
 * Deliberately a list with up and down, not a drag surface: this gets used
 * on a branch desktop at seven in the morning by someone who knows the area
 * better than any optimiser would. Route optimisation arrives in Phase 8 as
 * a suggestion, not a replacement.
 */
export function StopSequencer({ runId, stops }: { runId: string; stops: Stop[] }) {
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState(stops);
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    startTransition(async () => {
      const result: RunActionState = await resequenceAction({}, formData);
      if (result.message) {
        toast.success(result.message);
        setOpen(false);
      }
      if (result.error) toast.error(result.error);
    });
  }

  // Opening the dialog is when the server's order becomes the starting
  // point, which keeps the props in sync without an effect watching them.
  function handleOpenChange(next: boolean) {
    if (next) setOrder(stops);
    setOpen(next);
  }

  function move(index: number, direction: -1 | 1) {
    setOrder((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <ListOrdered />
        Sequence stops
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <form action={submit}>
          <input type="hidden" name="runId" value={runId} />
          <input type="hidden" name="order" value={order.map((s) => s.id).join(",")} />

          <DialogHeader>
            <DialogTitle>Order of stops</DialogTitle>
            <DialogDescription>
              The agent works down this list. Put the far end of the area
              first if the traffic runs that way.
            </DialogDescription>
          </DialogHeader>

          <ol className="my-4 max-h-[50vh] overflow-y-auto rounded-lg border">
            {order.map((stop, index) => (
              <li
                key={stop.id}
                className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
              >
                <span className="w-6 shrink-0 font-mono text-xs tabular text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{stop.label}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label="Move earlier"
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === order.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label="Move later"
                >
                  <ArrowDown />
                </Button>
              </li>
            ))}
          </ol>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save order"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
