"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Banknote, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { depositAction, verifyDepositAction, type CodActionState } from "./actions";

const MODES = [
  { value: "CASH", label: "Cash" },
  { value: "UPI", label: "UPI" },
  { value: "BANK_TRANSFER", label: "Transfer" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "CARD", label: "Card" },
];

/**
 * The handover.
 *
 * The amount is pre-filled with what the agent actually collected, but it
 * stays editable — the whole point of the screen is catching the day the
 * two numbers differ, and a field that cannot disagree cannot catch it.
 */
export function DepositForm({
  branchId,
  agentId,
  agentName,
  depositDate,
  collected,
}: {
  branchId: string;
  agentId: string;
  agentName: string;
  depositDate: string;
  collected: number;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(collected));
  const [mode, setMode] = useState("CASH");
  const [pending, startTransition] = useTransition();

  // `onSubmit` + `preventDefault`, not `<form action={fn}>`: React 19 resets
  // an uncontrolled form after an action, and a refused deposit wiped the
  // reference and the remarks — the two fields a disputed handover most
  // needs to keep — while the dialog stayed open.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result: CodActionState = await depositAction({}, formData);
      if (result.message) {
        toast.success(result.message);
        setOpen(false);
      }
      if (result.error) toast.error(result.error);
    });
  }

  const declared = Number(amount);
  const gap = collected - (Number.isFinite(declared) ? declared : 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Banknote />
        Record deposit
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <input type="hidden" name="branchId" value={branchId} />
          <input type="hidden" name="agentId" value={agentId} />
          <input type="hidden" name="depositDate" value={depositDate} />
          <input type="hidden" name="mode" value={mode} />

          <DialogHeader>
            <DialogTitle>Deposit from {agentName}</DialogTitle>
            <DialogDescription>
              ₹{collected.toLocaleString("en-IN")} is outstanding against what
              this agent took at the doors today.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amountDeclared">Amount handed over</Label>
              <Input
                id="amountDeclared"
                name="amountDeclared"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="h-10 text-base tabular"
              />
              {gap !== 0 && Number.isFinite(declared) && (
                <p className={gap > 0 ? "text-xs font-medium text-bad" : "text-xs text-warn"}>
                  {gap > 0
                    ? `₹${gap.toLocaleString("en-IN")} short of what was collected.`
                    : `₹${Math.abs(gap).toLocaleString("en-IN")} more than was collected — check the collections first.`}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Mode</Label>
              <div className="flex flex-wrap gap-2">
                {MODES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setMode(option.value)}
                    className={`h-8 rounded-lg border px-3 text-sm ${
                      mode === option.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "bg-card hover:bg-muted"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {mode !== "CASH" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reference">Reference</Label>
                <Input id="reference" name="reference" placeholder="Transaction or cheque number" />
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="remarks">Remarks</Label>
              <Textarea id="remarks" name="remarks" rows={2} placeholder="Optional" />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Recording…" : "Record deposit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Counting it. A count that disagrees with the declaration is a dispute. */
export function VerifyForm({
  depositId,
  agentName,
  declared,
}: {
  depositId: string;
  agentName: string;
  declared: number;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(declared));
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result: CodActionState = await verifyDepositAction({}, formData);
      if (result.message) {
        toast.success(result.message);
        setOpen(false);
      }
      if (result.error) toast.error(result.error);
    });
  }

  const counted = Number(amount);
  const gap = declared - (Number.isFinite(counted) ? counted : 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <ClipboardCheck />
        Count
      </DialogTrigger>

      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit}>
          <input type="hidden" name="depositId" value={depositId} />

          <DialogHeader>
            <DialogTitle>Count {agentName}’s deposit</DialogTitle>
            <DialogDescription>
              ₹{declared.toLocaleString("en-IN")} was declared.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amountVerified">Amount counted</Label>
              <Input
                id="amountVerified"
                name="amountVerified"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="h-10 text-base tabular"
              />
              {gap !== 0 && Number.isFinite(counted) && (
                <p className="text-xs font-medium text-bad">
                  ₹{Math.abs(gap).toLocaleString("en-IN")}{" "}
                  {gap > 0 ? "short" : "over"} — this will be marked disputed.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="verifyRemarks">Remarks</Label>
              <Textarea id="verifyRemarks" name="remarks" rows={2} placeholder="Optional" />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Confirm count"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
