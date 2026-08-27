"use client";

import { useState, useTransition } from "react";
import { ArrowRightLeft, Loader2, LogIn, LogOut, Truck } from "lucide-react";
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
import {
  markReportedAction,
  gateOutAction,
  gateInAction,
  closeTripAction,
  type TripState,
} from "../actions";

const IDLE: TripState = {};

/**
 * The gate.
 *
 * Gate-out and gate-in are the only two moments a whole truckload of
 * consignments changes status at once, so both ask for the odometer and
 * the seal — the two facts that are impossible to reconstruct afterwards
 * and the two that settle arguments.
 */
export function TripGateActions({
  tripId,
  status,
  canDispatch,
  canClose,
  destinationBranchId,
  destinationCode,
  sealNumber,
  startOdometerKm,
  hasOpenLoadingSheet,
  carrying,
}: {
  tripId: string;
  status: string;
  canDispatch: boolean;
  canClose: boolean;
  destinationBranchId: string;
  destinationCode: string;
  sealNumber: string | null;
  startOdometerKm: number | null;
  hasOpenLoadingSheet: boolean;
  carrying: number;
}) {
  const [outOpen, setOutOpen] = useState(false);
  const [inOpen, setInOpen] = useState(false);
  const [outState, setOutState] = useState<TripState>(IDLE);
  const [inState, setInState] = useState<TripState>(IDLE);
  const [pending, startTransition] = useTransition();

  /**
   * Runs a gate action and reports what happened.
   *
   * A gate event that moves forty consignments can still refuse one — a
   * shipment already cancelled, or corrected out from under the manifest.
   * Those are surfaced individually and left on screen long enough to
   * write down, because the yard has to physically deal with the box.
   */
  function run(
    action: (prev: TripState, formData: FormData) => Promise<TripState>,
    onResult?: (result: TripState) => void,
  ) {
    return (formData: FormData) => {
      startTransition(async () => {
        const result = await action(IDLE, formData);
        onResult?.(result);

        if (result.ok && result.message) {
          toast.success(result.message);
          if (result.refused && result.refused.length > 0) {
            toast.warning(
              `${result.refused.length} consignment${result.refused.length === 1 ? "" : "s"} could not move: ${result.refused
                .map((r) => `${r.lrNumber} — ${r.reason}`)
                .join("; ")}`,
              { duration: 12_000 },
            );
          }
        } else if (result.error) {
          toast.error(result.error);
        }
      });
    };
  }

  const reporting = pending;
  const gatingOut = pending;
  const gatingIn = pending;
  const closingTrip = pending;

  return (
    <>
      {status === "PLANNED" && canDispatch && (
        <form action={run(markReportedAction)}>
          <input type="hidden" name="tripId" value={tripId} />
          <Button type="submit" variant="outline" disabled={reporting}>
            {reporting ? <Loader2 className="animate-spin" /> : <Truck />}
            Vehicle at gate
          </Button>
        </form>
      )}

      {(status === "PLANNED" || status === "VEHICLE_REPORTED" || status === "LOADING") &&
        canDispatch && (
          <Dialog open={outOpen} onOpenChange={setOutOpen}>
            <DialogTrigger render={<Button disabled={carrying === 0} />}>
              <LogOut />
              Gate out
            </DialogTrigger>

            <DialogContent>
              <form
                action={run(gateOutAction, (result) => {
                  setOutState(result);
                  if (result.ok) setOutOpen(false);
                })}
              >
                <input type="hidden" name="tripId" value={tripId} />

                <DialogHeader>
                  <DialogTitle>Dispatch this trip</DialogTitle>
                  <DialogDescription>
                    {carrying} consignment{carrying === 1 ? "" : "s"} will be
                    marked dispatched in one go. This is the moment the network
                    considers the freight to have left.
                  </DialogDescription>
                </DialogHeader>

                {hasOpenLoadingSheet && (
                  <p className="my-3 rounded-md bg-warn-muted px-3 py-2 text-sm text-warn">
                    A loading sheet is still open. Close it first — until then
                    the floor has not confirmed that what is scanned is what is
                    on the vehicle.
                  </p>
                )}

                <div className="flex flex-col gap-4 py-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="gateout-odo">Odometer (km)</Label>
                    <Input
                      id="gateout-odo"
                      name="odometerKm"
                      type="number"
                      min={0}
                      inputMode="numeric"
                      placeholder="e.g. 148320"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="gateout-seal">Seal number</Label>
                    <Input
                      id="gateout-seal"
                      name="sealNumber"
                      defaultValue={sealNumber ?? ""}
                      maxLength={40}
                    />
                    <p className="text-xs text-muted-foreground">
                      The receiving branch checks this against the seal on the
                      door. A mismatch is an exception, not a formality.
                    </p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="gateout-remarks">Remarks</Label>
                    <Textarea
                      id="gateout-remarks"
                      name="remarks"
                      rows={2}
                      maxLength={300}
                    />
                  </div>
                </div>

                {outState.error && (
                  <p className="pb-2 text-sm text-bad">{outState.error}</p>
                )}

                <DialogFooter>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setOutOpen(false)}
                    disabled={gatingOut}
                  >
                    Not yet
                  </Button>
                  <Button type="submit" disabled={gatingOut || hasOpenLoadingSheet}>
                    {gatingOut && <Loader2 className="animate-spin" />}
                    Dispatch
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}

      {(status === "DISPATCHED" || status === "IN_TRANSIT") && canDispatch && (
        <Dialog open={inOpen} onOpenChange={setInOpen}>
          <DialogTrigger render={<Button />}>
            <LogIn />
            Gate in
          </DialogTrigger>

          <DialogContent>
            <form
              action={run(gateInAction, (result) => {
                setInState(result);
                if (result.ok) setInOpen(false);
              })}
            >
              <input type="hidden" name="tripId" value={tripId} />
              <input type="hidden" name="branchId" value={destinationBranchId} />

              <DialogHeader>
                <DialogTitle>Receive at {destinationCode}</DialogTitle>
                <DialogDescription>
                  Marks the vehicle arrived and every consignment on it as
                  arrived at this hub. Scanning the boxes off comes next, on an
                  inbound receipt.
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-4 py-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="gatein-odo">Odometer (km)</Label>
                  <Input
                    id="gatein-odo"
                    name="odometerKm"
                    type="number"
                    min={startOdometerKm ?? 0}
                    inputMode="numeric"
                  />
                  {startOdometerKm != null && (
                    <p className="text-xs text-muted-foreground">
                      Left at {startOdometerKm.toLocaleString("en-IN")} km. The
                      difference becomes the trip distance.
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <Label>Seal {sealNumber ? `(${sealNumber})` : ""}</Label>
                  {[
                    { value: "yes", label: "Intact and matching" },
                    { value: "no", label: "Broken, missing, or a different number" },
                    { value: "unknown", label: "Not checked" },
                  ].map((option) => (
                    <label
                      key={option.value}
                      className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
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

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="gatein-remarks">Remarks</Label>
                  <Textarea id="gatein-remarks" name="remarks" rows={2} maxLength={300} />
                </div>
              </div>

              {inState.error && <p className="pb-2 text-sm text-bad">{inState.error}</p>}

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setInOpen(false)}
                  disabled={gatingIn}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={gatingIn}>
                  {gatingIn && <Loader2 className="animate-spin" />}
                  Gate in
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {(status === "ARRIVED" || status === "UNLOADING") && canClose && (
        <form action={run(closeTripAction)}>
          <input type="hidden" name="tripId" value={tripId} />
          <Button type="submit" variant="outline" disabled={closingTrip}>
            {closingTrip ? <Loader2 className="animate-spin" /> : <ArrowRightLeft />}
            Close trip
          </Button>
        </form>
      )}
    </>
  );
}
