"use client";

import { useId, useState, useTransition } from "react";
import { Loader2, Scale, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableFrame } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { captureWeight, type WeighState } from "./actions";

const EMPTY: WeighState = {};

export type Weighable = {
  id: string;
  lrNumber: string;
  consignorName: string;
  consigneeName: string;
  packageCount: number;
  actualWeight: string;
  chargeableWeight: string;
  grandTotal: string;
  currentStatus: string;
};

export function WeighForm({
  shipments,
  branchId,
  branchCode,
}: {
  shipments: Weighable[];
  branchId: string | null;
  branchCode: string | null;
}) {
  const [state, setState] = useState<WeighState>(EMPTY);
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Weighable | null>(null);
  const formId = useId();

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await captureWeight(EMPTY, formData);
      setState(result);
      if (result.ok) setSelected(null);
    });
  }

  if (!branchId) {
    return (
      <p className="rounded-lg border border-warn/40 bg-warn-muted px-4 py-3 text-sm text-warn">
        Your account has no home branch, so there is no weighbridge to record
        against. An administrator can set one under Administration → Users.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {state.ok && state.delta && (
        <div
          className={`flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm ${
            state.delta.exceedsTolerance
              ? "border-warn/40 bg-warn-muted text-warn"
              : "border-ok/40 bg-ok-muted text-ok"
          }`}
        >
          <p className="flex items-start gap-2 font-medium">
            {state.delta.exceedsTolerance ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            ) : (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            )}
            {state.message}
          </p>
          <p className="tabular">
            <span className="font-mono">{state.delta.lrNumber}</span> ·{" "}
            {state.delta.fromKg} kg → <strong>{state.delta.toKg} kg</strong> · ₹
            {state.delta.fromAmount} → <strong>₹{state.delta.toAmount}</strong>{" "}
            (₹{state.delta.deltaAmount}, {state.delta.deltaPercent}%)
          </p>
          {(state.delta.debitNoteNumber || state.delta.exceptionNumber) && (
            <p className="text-xs">
              {state.delta.debitNoteNumber && (
                <>
                  Debit note{" "}
                  <span className="font-mono">
                    {state.delta.debitNoteNumber}
                  </span>
                  {state.delta.exceptionNumber && " · "}
                </>
              )}
              {state.delta.exceptionNumber && (
                <>
                  Exception{" "}
                  <span className="font-mono">
                    {state.delta.exceptionNumber}
                  </span>
                </>
              )}
            </p>
          )}
        </div>
      )}

      {state.warnings?.length ? (
        <ul className="flex flex-col gap-1 rounded-lg border border-warn/40 bg-warn-muted px-4 py-3 text-sm text-warn">
          {state.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {state.error && (
        <p
          role="alert"
          className="rounded-lg border border-bad/40 bg-bad-muted px-4 py-3 text-sm text-bad"
        >
          {state.error}
        </p>
      )}

      {selected ? (
        <form
          id={formId}
          action={submit}
          className="flex flex-col gap-4 rounded-lg border bg-card p-5"
        >
          <input type="hidden" name="shipmentId" value={selected.id} />
          <input type="hidden" name="branchId" value={branchId} />

          <div className="flex flex-col gap-1">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
              Weighing at {branchCode}
            </h2>
            <p className="text-lg font-semibold">
              <span className="font-mono">{selected.lrNumber}</span>
            </p>
            <p className="text-sm text-muted-foreground">
              {selected.consignorName} → {selected.consigneeName} ·{" "}
              {selected.packageCount} pkg · booked at{" "}
              <span className="tabular">{selected.chargeableWeight} kg</span>,
              ₹{selected.grandTotal}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-actual`}>Scale reading (kg)</Label>
              <Input
                id={`${formId}-actual`}
                name="actualWeight"
                type="number"
                step="0.001"
                min={0}
                className="font-mono"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                What the weighbridge shows.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-chargeable`}>
                Chargeable override (kg)
              </Label>
              <Input
                id={`${formId}-chargeable`}
                name="chargeableWeight"
                type="number"
                step="0.001"
                min={0}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Leave blank to recompute from the scale and the volumetric
                figure.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-reference`}>Weighbridge slip</Label>
              <Input id={`${formId}-reference`} name="reference" />
              <p className="text-xs text-muted-foreground">
                Ticket number, for the dispute six months from now.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <Scale />}
              Record weight and reprice
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSelected(null)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>

          <p className="max-w-prose text-xs text-muted-foreground">
            The booking figure is never overwritten — a second calculation is
            written alongside it, so what the customer was originally quoted
            survives. If the increase is past tolerance the consignor is told
            before the invoice reaches them.
          </p>
        </form>
      ) : (
        <TableFrame>
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>LR number</TableHead>
                <TableHead>Consignor → Consignee</TableHead>
                <TableHead className="text-right">Pkgs</TableHead>
                <TableHead className="text-right">Booked weight</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="w-28 text-right">Weigh</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shipments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    Nothing received here is waiting to be weighed.
                  </TableCell>
                </TableRow>
              )}
              {shipments.map((shipment) => (
                <TableRow key={shipment.id}>
                  <TableCell className="font-mono text-xs font-medium">
                    {shipment.lrNumber}
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate text-sm">
                    {shipment.consignorName} → {shipment.consigneeName}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {shipment.packageCount}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular">
                    {shipment.chargeableWeight} kg
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular">
                    ₹{shipment.grandTotal}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSelected(shipment)}
                    >
                      <Scale />
                      Weigh
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </div>
  );
}
