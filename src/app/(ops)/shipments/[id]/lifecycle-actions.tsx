"use client";

import { useState, useTransition } from "react";
import {
  Ban,
  Loader2,
  PauseCircle,
  PlayCircle,
  PencilLine,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
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
import type { ActionState } from "@/server/services/master-crud";
import {
  amendBookingAction,
  cancelShipmentAction,
  correctStatusAction,
  holdShipmentAction,
  releaseHoldAction,
} from "./actions";

/**
 * Everything a branch can do to a consignment as a booking, rather than to
 * the freight.
 *
 * Four controls, each behind the permission its transition rule names, and
 * each rendered only when the consignment is actually in a state that
 * accepts it — a Cancel button on something already dispatched is a promise
 * the server is going to break.
 *
 * Prisma enums arrive here as `import type` only. The status list is passed
 * in from the page rather than imported, so nothing in the generated client
 * is pulled into the browser bundle.
 */

export type ReasonOption = { id: string; code: string; name: string };

export type LifecycleFields = {
  consignorName: string;
  consignorCompany: string;
  consignorPhone: string;
  consignorEmail: string;
  consignorAddress: string;
  consigneeName: string;
  consigneeCompany: string;
  consigneePhone: string;
  consigneeEmail: string;
  consigneeAddress: string;
  consigneeLandmark: string;
  goodsDescription: string;
  specialInstructions: string;
  packageCount: number;
  actualWeight: string;
};

const IDLE: ActionState = {};

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm";

export function ShipmentLifecycleActions({
  shipmentId,
  lrNumber,
  statusLabel,
  isOnHold,
  inCustody,
  canCancel,
  canHoldOrRelease,
  canAmend,
  canCorrect,
  cancellationReasons,
  holdReasons,
  correctionReasons,
  correctableStatuses,
  fields,
}: {
  shipmentId: string;
  lrNumber: string;
  statusLabel: string;
  isOnHold: boolean;
  /** The goods are with us. Narrows what an amendment may touch. */
  inCustody: boolean;
  canCancel: boolean;
  canHoldOrRelease: boolean;
  canAmend: boolean;
  canCorrect: boolean;
  cancellationReasons: ReasonOption[];
  holdReasons: ReasonOption[];
  correctionReasons: ReasonOption[];
  correctableStatuses: Array<{ value: string; label: string }>;
  fields: LifecycleFields;
}) {
  return (
    <>
      {canAmend && (
        <AmendDialog
          shipmentId={shipmentId}
          lrNumber={lrNumber}
          inCustody={inCustody}
          fields={fields}
        />
      )}

      {canHoldOrRelease &&
        (isOnHold ? (
          <ReleaseDialog shipmentId={shipmentId} lrNumber={lrNumber} />
        ) : (
          <HoldDialog
            shipmentId={shipmentId}
            lrNumber={lrNumber}
            reasons={holdReasons}
          />
        ))}

      {canCancel && (
        <CancelDialog
          shipmentId={shipmentId}
          lrNumber={lrNumber}
          reasons={cancellationReasons}
        />
      )}

      {canCorrect && (
        <CorrectStatusDialog
          shipmentId={shipmentId}
          lrNumber={lrNumber}
          statusLabel={statusLabel}
          reasons={correctionReasons}
          statuses={correctableStatuses}
        />
      )}
    </>
  );
}

/**
 * One submit path for all four.
 *
 * The dialog closes from the action's result rather than from an effect
 * watching it — the close is a consequence of the submit, not of a render.
 *
 * `onSubmit` with `preventDefault`, not `<form action={…}>`: React 19
 * resets an uncontrolled form as soon as a form action returns, and these
 * are uncontrolled forms. On Amend that is fifteen boxes — a ten-digit
 * phone typed with nine used to wipe the corrected consignee address, the
 * landmark and the explanation along with it. On Correct status it threw
 * away the written account of what went wrong, which the service demands
 * ten characters of and which is the only explanation that record will
 * ever carry.
 */
function useAction(
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>,
  onDone: () => void,
) {
  const [state, setState] = useState<ActionState>(IDLE);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await action(IDLE, formData);
      setState(result);
      if (result.ok) {
        if (result.message) toast.success(result.message, { duration: 8000 });
        onDone();
      } else if (result.error) {
        toast.error(result.error, { duration: 8000 });
      }
    });
  }

  return { state, pending, submit, reset: () => setState(IDLE) };
}

function ReasonRadios({
  reasons,
  name = "reasonCodeId",
  emptyHint,
}: {
  reasons: ReasonOption[];
  name?: string;
  emptyHint: string;
}) {
  if (reasons.length === 0) {
    return <p className="text-sm text-warn">{emptyHint}</p>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {reasons.map((reason) => (
        <label
          key={reason.id}
          className="flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm has-checked:border-primary has-checked:bg-primary/5"
        >
          <input type="radio" name={name} value={reason.id} required className="size-4" />
          <span>{reason.name}</span>
          <span className="ml-auto font-mono text-[0.6rem] uppercase text-muted-foreground">
            {reason.code}
          </span>
        </label>
      ))}
    </div>
  );
}

function Problem({ state }: { state: ActionState }) {
  if (!state.error) return null;
  return <p className="pb-2 text-sm text-bad">{state.error}</p>;
}

// ────────────────────────────────────────────────────────────
// Cancel
// ────────────────────────────────────────────────────────────

function CancelDialog({
  shipmentId,
  lrNumber,
  reasons,
}: {
  shipmentId: string;
  lrNumber: string;
  reasons: ReasonOption[];
}) {
  const [open, setOpen] = useState(false);
  const { state, pending, submit } = useAction(cancelShipmentAction, () =>
    setOpen(false),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="destructive" />}>
        <Ban />
        Cancel booking
      </DialogTrigger>

      <DialogContent>
        <form onSubmit={submit}>
          <input type="hidden" name="shipmentId" value={shipmentId} />

          <DialogHeader>
            <DialogTitle>Cancel {lrNumber}</DialogTitle>
            <DialogDescription>
              The booking is not deleted and the number is not reissued — it
              stays on the record as cancelled, with this reason against it.
              Any collection raised for it is called off.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <Label>Why</Label>
              <ReasonRadios
                reasons={reasons}
                emptyHint="No cancellation reasons are set up. Add them in masters before a booking can be cancelled."
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cancel-remarks">Anything to add</Label>
              <Textarea id="cancel-remarks" name="remarks" rows={2} maxLength={300} />
            </div>
          </div>

          <Problem state={state} />

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Keep it
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={pending || reasons.length === 0}
            >
              {pending && <Loader2 className="animate-spin" />}
              Cancel this booking
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────
// Hold and release
// ────────────────────────────────────────────────────────────

function HoldDialog({
  shipmentId,
  lrNumber,
  reasons,
}: {
  shipmentId: string;
  lrNumber: string;
  reasons: ReasonOption[];
}) {
  const [open, setOpen] = useState(false);
  const { state, pending, submit } = useAction(holdShipmentAction, () =>
    setOpen(false),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        <PauseCircle />
        Hold
      </DialogTrigger>

      <DialogContent>
        <form onSubmit={submit}>
          <input type="hidden" name="shipmentId" value={shipmentId} />

          <DialogHeader>
            <DialogTitle>Hold {lrNumber}</DialogTitle>
            <DialogDescription>
              The consignment stays exactly where it is and keeps its status.
              A hold is what stops it being loaded onto the next vehicle.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <Label>Why</Label>
              <ReasonRadios
                reasons={reasons}
                emptyHint="No hold reasons are set up. Add them in masters first."
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hold-remarks">Detail</Label>
              <Textarea
                id="hold-remarks"
                name="remarks"
                rows={2}
                maxLength={300}
                placeholder="Consignor's account is 40 days past terms. Accounts asked for it to be stopped at Delhi."
              />
            </div>
          </div>

          <Problem state={state} />

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Not now
            </Button>
            <Button type="submit" disabled={pending || reasons.length === 0}>
              {pending && <Loader2 className="animate-spin" />}
              Place on hold
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReleaseDialog({
  shipmentId,
  lrNumber,
}: {
  shipmentId: string;
  lrNumber: string;
}) {
  const [open, setOpen] = useState(false);
  const { state, pending, submit } = useAction(releaseHoldAction, () =>
    setOpen(false),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <PlayCircle />
        Release hold
      </DialogTrigger>

      <DialogContent>
        <form onSubmit={submit}>
          <input type="hidden" name="shipmentId" value={shipmentId} />

          <DialogHeader>
            <DialogTitle>Release {lrNumber}</DialogTitle>
            <DialogDescription>
              The consignment goes back into the flow from wherever it is
              standing. Say what changed — the hold was placed for a reason
              and the record should show why it no longer applies.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5 py-4">
            <Label htmlFor="release-remarks">What changed</Label>
            <Textarea
              id="release-remarks"
              name="remarks"
              rows={3}
              maxLength={300}
              required
              placeholder="Payment received against invoice INV/2026/DEL/0412. Accounts confirmed release."
            />
            {state.fieldErrors?.remarks && (
              <p className="text-xs text-bad">{state.fieldErrors.remarks}</p>
            )}
          </div>

          <Problem state={state} />

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Leave it held
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Release
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────
// Amend
// ────────────────────────────────────────────────────────────

function AmendField({
  id,
  name,
  label,
  defaultValue,
  hint,
  error,
  ...rest
}: {
  id: string;
  name: string;
  label: string;
  defaultValue: string | number;
  hint?: string;
  error?: string;
} & React.ComponentProps<typeof Input>) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} defaultValue={defaultValue} {...rest} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}

function AmendDialog({
  shipmentId,
  lrNumber,
  inCustody,
  fields,
}: {
  shipmentId: string;
  lrNumber: string;
  inCustody: boolean;
  fields: LifecycleFields;
}) {
  const [open, setOpen] = useState(false);
  const { state, pending, submit } = useAction(amendBookingAction, () =>
    setOpen(false),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        <PencilLine />
        Amend
      </DialogTrigger>

      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit} className="flex max-h-[75vh] flex-col">
          <input type="hidden" name="shipmentId" value={shipmentId} />

          <DialogHeader>
            <DialogTitle>Amend {lrNumber}</DialogTitle>
            <DialogDescription>
              {inCustody
                ? "The goods are already with us, so only the details that describe people can still be corrected. The count, the weight, the pickup address and the description of the goods are now physical facts — they are revised at the dock, not here."
                : "Nothing has been collected yet, so the whole booking is still a piece of paper and every figure on it can be corrected. Changing the weight or the package count reprices the consignment."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-4">
            <section className="flex flex-col gap-3">
              <h3 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
                Consignor
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <AmendField
                  id="amend-cnor-name"
                  name="consignorName"
                  label="Name"
                  defaultValue={fields.consignorName}
                  maxLength={120}
                />
                <AmendField
                  id="amend-cnor-company"
                  name="consignorCompany"
                  label="Company"
                  defaultValue={fields.consignorCompany}
                  maxLength={160}
                />
                <AmendField
                  id="amend-cnor-phone"
                  name="consignorPhone"
                  label="Phone"
                  defaultValue={fields.consignorPhone}
                  inputMode="numeric"
                  maxLength={10}
                  error={state.fieldErrors?.consignorPhone}
                />
                <AmendField
                  id="amend-cnor-email"
                  name="consignorEmail"
                  label="Email"
                  defaultValue={fields.consignorEmail}
                  type="email"
                  maxLength={160}
                />
              </div>
              {!inCustody && (
                <AmendField
                  id="amend-cnor-address"
                  name="consignorAddress"
                  label="Pickup address"
                  defaultValue={fields.consignorAddress}
                  maxLength={300}
                  hint="The city and PIN cannot change here — a different lane is a different booking."
                />
              )}
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
                Consignee
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <AmendField
                  id="amend-cnee-name"
                  name="consigneeName"
                  label="Name"
                  defaultValue={fields.consigneeName}
                  maxLength={120}
                />
                <AmendField
                  id="amend-cnee-company"
                  name="consigneeCompany"
                  label="Company"
                  defaultValue={fields.consigneeCompany}
                  maxLength={160}
                />
                <AmendField
                  id="amend-cnee-phone"
                  name="consigneePhone"
                  label="Phone"
                  defaultValue={fields.consigneePhone}
                  inputMode="numeric"
                  maxLength={10}
                  error={state.fieldErrors?.consigneePhone}
                />
                <AmendField
                  id="amend-cnee-email"
                  name="consigneeEmail"
                  label="Email"
                  defaultValue={fields.consigneeEmail}
                  type="email"
                  maxLength={160}
                />
              </div>
              <AmendField
                id="amend-cnee-address"
                name="consigneeAddress"
                label="Delivery address"
                defaultValue={fields.consigneeAddress}
                maxLength={300}
                hint="Correctable right up to dispatch — a consignee who has moved is the commonest amendment there is. The city and PIN are fixed."
              />
              <AmendField
                id="amend-cnee-landmark"
                name="consigneeLandmark"
                label="Landmark"
                defaultValue={fields.consigneeLandmark}
                maxLength={120}
              />
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
                Goods
              </h3>
              {inCustody ? (
                <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {fields.packageCount} package
                  {fields.packageCount === 1 ? "" : "s"}, {fields.actualWeight} kg
                  — counted and weighed by us. A different count is a shortage
                  or an excess on the inbound receipt; a different weight goes
                  through hub weighment, which reprices and raises a debit
                  note.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <AmendField
                    id="amend-packages"
                    name="packageCount"
                    label="Packages"
                    defaultValue={fields.packageCount}
                    type="number"
                    min={1}
                    inputMode="numeric"
                    error={state.fieldErrors?.packageCount}
                    hint="Adding boxes mints new barcodes. Removing takes them off the end, and only while none has been scanned."
                  />
                  <AmendField
                    id="amend-weight"
                    name="actualWeight"
                    label="Actual weight (kg)"
                    defaultValue={fields.actualWeight}
                    type="number"
                    min={0}
                    step="0.001"
                    inputMode="decimal"
                    error={state.fieldErrors?.actualWeight}
                    hint="Reprices the consignment off the rate card."
                  />
                </div>
              )}
              {!inCustody && (
                <AmendField
                  id="amend-goods"
                  name="goodsDescription"
                  label="Goods"
                  defaultValue={fields.goodsDescription}
                  maxLength={300}
                />
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="amend-instructions">Special instructions</Label>
                <Textarea
                  id="amend-instructions"
                  name="specialInstructions"
                  rows={2}
                  maxLength={300}
                  defaultValue={fields.specialInstructions}
                />
              </div>
            </section>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amend-remarks">Why</Label>
              <Textarea
                id="amend-remarks"
                name="remarks"
                rows={2}
                maxLength={300}
                placeholder="Consignee rang — they have moved to the second floor of the same building."
              />
              <p className="text-xs text-muted-foreground">
                Every change goes on the timeline as an amendment, with the old
                value beside the new one.
              </p>
            </div>
          </div>

          <Problem state={state} />

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Discard
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Save amendment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────
// Status correction
// ────────────────────────────────────────────────────────────

function CorrectStatusDialog({
  shipmentId,
  lrNumber,
  statusLabel,
  reasons,
  statuses,
}: {
  shipmentId: string;
  lrNumber: string;
  statusLabel: string;
  reasons: ReasonOption[];
  statuses: Array<{ value: string; label: string }>;
}) {
  const [open, setOpen] = useState(false);
  const { state, pending, submit } = useAction(correctStatusAction, () =>
    setOpen(false),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="destructive" />}>
        <ShieldAlert />
        Correct status
      </DialogTrigger>

      <DialogContent>
        <form onSubmit={submit}>
          <input type="hidden" name="shipmentId" value={shipmentId} />

          <DialogHeader>
            <DialogTitle>Correct the status of {lrNumber}</DialogTitle>
            <DialogDescription>
              This moves the consignment to a status nothing that happened
              would have taken it to. Use it when a scan went onto the wrong
              LR or a device replayed a stale queue — never to record
              something that has actually happened, which belongs on its own
              screen.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <p className="rounded-md bg-bad-muted px-3 py-2 text-xs text-bad">
              The correction is written to the chain of custody as its own
              entry naming you, both statuses and your explanation, and to the
              audit trail as an override. Neither can be edited or removed.
            </p>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correct-to">
                It should be — currently {statusLabel}
              </Label>
              <select
                id="correct-to"
                name="correctedTo"
                required
                defaultValue=""
                className={SELECT_CLASS}
              >
                <option value="" disabled>
                  Choose the true status…
                </option>
                {statuses.map((status) => (
                  <option key={status.value} value={status.value}>
                    {status.label}
                  </option>
                ))}
              </select>
              {state.fieldErrors?.correctedTo && (
                <p className="text-xs text-bad">{state.fieldErrors.correctedTo}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Delivered, POD uploaded and RTO delivered are not offered. Those
                carry a receiver and proof, and a correction cannot manufacture
                either.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Why</Label>
              <ReasonRadios
                reasons={reasons}
                emptyHint="No status-correction reasons are set up. Add them in masters first."
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correct-remarks">What went wrong</Label>
              <Textarea
                id="correct-remarks"
                name="remarks"
                rows={3}
                minLength={10}
                maxLength={300}
                required
                placeholder="Inbound scan at JAI was made against this LR instead of CL20260830-0044. The consignment never left DEL."
              />
              {state.fieldErrors?.remarks && (
                <p className="text-xs text-bad">{state.fieldErrors.remarks}</p>
              )}
            </div>
          </div>

          <Problem state={state} />

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Leave it alone
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={pending || reasons.length === 0}
            >
              {pending && <Loader2 className="animate-spin" />}
              Post the correction
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
