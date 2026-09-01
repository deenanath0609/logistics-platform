"use client";

import { useId, useState, useTransition } from "react";
import {
  Loader2,
  Scale,
  AlertTriangle,
  CheckCircle2,
  Calculator,
} from "lucide-react";
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
import {
  captureWeight,
  previewWeight,
  type PreviewState,
  type WeighState,
} from "./actions";

const EMPTY: WeighState = {};

/** Field labels, so a rejected field can be named where it is not shown. */
const FIELD_LABEL: Record<string, string> = {
  shipmentId: "Consignment",
  branchId: "Branch",
  actualWeight: "Scale reading",
  chargeableWeight: "Chargeable override",
  reference: "Weighbridge slip",
};

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
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Weighable | null>(null);
  const formId = useId();

  const fieldError = (field: string) => state.fieldErrors?.[field];

  // Submitted by hand rather than through `<form action={…}>`: React 19
  // resets an uncontrolled form the moment the action returns, and a
  // rejected reading would take the weighbridge slip number with it.
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await captureWeight(EMPTY, formData);
      setState(result);
      setPreview(null);
      if (result.ok) setSelected(null);
    });
  }

  /**
   * Prices the reading without applying it.
   *
   * Recording a weight reprices the consignment, raises a debit note and
   * tells the customer, all at once and none of it reversible from here.
   * The person holding the scale is the one who can catch a mistyped
   * figure, so they get to see the money first.
   */
  function check(form: HTMLFormElement | null) {
    if (!form || !selected) return;
    const formData = new FormData(form);

    startTransition(async () => {
      const result = await previewWeight({
        shipmentId: selected.id,
        actualWeight: (formData.get("actualWeight") as string) || null,
        chargeableWeight: (formData.get("chargeableWeight") as string) || null,
      });
      setPreview(result);
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
        <div
          role="alert"
          className="rounded-lg border border-bad/40 bg-bad-muted px-4 py-3 text-sm text-bad"
        >
          <p>{state.error}</p>
          {/*
            The action has always computed `fieldErrors` and nothing ever
            rendered them: a slip number one character too long, or a
            negative reading, produced "Check the highlighted fields" with
            nothing highlighted anywhere on the screen.
          */}
          {state.fieldErrors && Object.keys(state.fieldErrors).length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs">
              {Object.entries(state.fieldErrors).map(([field, message]) => (
                <li key={field}>
                  {FIELD_LABEL[field] ?? field}: {message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {selected ? (
        <form
          id={formId}
          onSubmit={submit}
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
              {fieldError("actualWeight") && (
                <p className="text-xs text-bad">{fieldError("actualWeight")}</p>
              )}
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
              {fieldError("chargeableWeight") && (
                <p className="text-xs text-bad">
                  {fieldError("chargeableWeight")}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-reference`}>Weighbridge slip</Label>
              {/* The action refuses past 80 characters; say so here. */}
              <Input
                id={`${formId}-reference`}
                name="reference"
                maxLength={80}
              />
              <p className="text-xs text-muted-foreground">
                Ticket number, for the dispute six months from now.
              </p>
              {fieldError("reference") && (
                <p className="text-xs text-bad">{fieldError("reference")}</p>
              )}
            </div>
          </div>

          {preview && (
            <div
              className={`flex flex-col gap-1 rounded-lg border px-4 py-3 text-sm ${
                !preview.ok
                  ? "border-bad/40 bg-bad-muted text-bad"
                  : preview.exceedsTolerance
                    ? "border-warn/40 bg-warn-muted text-warn"
                    : "border-border bg-muted"
              }`}
            >
              {!preview.ok ? (
                <p>{preview.error}</p>
              ) : (
                <>
                  <p className="tabular">
                    Would charge{" "}
                    <strong>{preview.chargeableWeight} kg</strong> · ₹
                    {preview.fromAmount} → <strong>₹{preview.toAmount}</strong>{" "}
                    (₹{preview.deltaAmount}, {preview.deltaPercent}%)
                  </p>
                  <p className="text-xs">
                    {preview.exceedsTolerance
                      ? `Past the ${preview.tolerancePercent}% tolerance — recording this opens an exception and notifies the consignor.`
                      : "Nothing has been applied to the consignment yet."}
                  </p>
                  {preview.unrated && (
                    <p className="text-xs">
                      No rate rule matches this lane, so the revision would
                      price at zero.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <Scale />}
              Record weight and reprice
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={(event) =>
                check(event.currentTarget.closest("form"))
              }
            >
              <Calculator />
              Check the price first
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSelected(null);
                setPreview(null);
              }}
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
                      onClick={() => {
                        setSelected(shipment);
                        setPreview(null);
                        setState(EMPTY);
                      }}
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
