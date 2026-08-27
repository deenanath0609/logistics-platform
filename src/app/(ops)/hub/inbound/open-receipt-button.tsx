"use client";

import { useActionState, useState } from "react";
import { Loader2, PackageOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { openInboundReceipt, type OpenReceiptState } from "./actions";

const IDLE: OpenReceiptState = {};

/**
 * Opening a receipt asks one question first: was the seal intact?
 *
 * It is asked here, before the doors come open, because after forty boxes
 * are on the floor nobody can honestly say. A broken seal becomes its own
 * discrepancy at close.
 */
export function OpenReceiptButton({
  manifestId,
  manifestNumber,
  branchId,
  originCode,
  sealNumber,
  packages,
}: {
  manifestId: string;
  manifestNumber: string;
  branchId: string;
  originCode: string;
  sealNumber: string | null;
  packages: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(openInboundReceipt, IDLE);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <PackageOpen />
            Receive
          </Button>
        }
      />
      <DialogContent>
        <form action={formAction}>
          <input type="hidden" name="manifestId" value={manifestId} />
          <input type="hidden" name="branchId" value={branchId} />

          <DialogHeader>
            <DialogTitle>Receive {manifestNumber}</DialogTitle>
            <DialogDescription>
              {packages} package{packages === 1 ? "" : "s"} from {originCode}.
              {sealNumber ? ` Seal ${sealNumber} was applied at gate-out.` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 py-4">
            <Label>Seal on arrival</Label>
            <div className="flex flex-col gap-1.5">
              {[
                { value: "yes", label: "Intact — matches the number on the paperwork" },
                { value: "no", label: "Broken or missing" },
                { value: "unknown", label: "Not checked" },
              ].map((option) => (
                <label
                  key={option.value}
                  className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
                >
                  <input
                    type="radio"
                    name="sealIntact"
                    value={option.value}
                    defaultChecked={option.value === "unknown"}
                    className="accent-primary"
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              A broken seal is recorded as a discrepancy against{" "}
              {originCode} when the receipt closes.
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
              Open receipt
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
