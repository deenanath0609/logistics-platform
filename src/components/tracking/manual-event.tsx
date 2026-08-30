"use client";

import { useActionState, useState } from "react";
import { Loader2, PhoneCall } from "lucide-react";
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
import { cn } from "@/lib/utils";
import {
  recordManualArrivalAction,
  recordManualDepartureAction,
  recordManualPositionAction,
  type TrackingState,
} from "@/app/(ops)/tracking/actions";

const IDLE: TrackingState = {};

export type BranchOption = { id: string; code: string; name: string };

type Mode = "ARRIVAL" | "DEPARTURE" | "POSITION";

/**
 * Recording by hand what the fence would have recorded.
 *
 * Half the fleet is attached or vendor-owned and will never be reliably
 * fitted. This dialog is what the branch reaches for when a driver rings in
 * — and it deliberately writes the *same* event as the geofence would, not
 * a lesser cousin of it, so the consignment timeline reads identically
 * either way and the difference lives only in `source`.
 */
export function ManualEventDialog({
  vehicleId,
  registrationNumber,
  trip,
  branches,
  hasDevice,
  canRecordMovement,
}: {
  vehicleId: string;
  registrationNumber: string;
  trip: {
    id: string;
    number: string;
    originCode: string;
    destinationCode: string;
  } | null;
  branches: BranchOption[];
  hasDevice: boolean;
  /**
   * Arrivals and departures move every consignment on the trip, so they
   * need `trip.dispatch`. A position report only moves the map and needs
   * the tracking read — which is why the two are separate props rather
   * than one "may record by hand".
   */
  canRecordMovement: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(
    trip && canRecordMovement ? "ARRIVAL" : "POSITION",
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <PhoneCall />
            Record by hand
          </Button>
        }
      />
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record for {registrationNumber}</DialogTitle>
          <DialogDescription>
            {hasDevice
              ? "This vehicle has a device fitted. Use this when the device is not reporting or the fix is plainly wrong."
              : "This vehicle has no GPS device. Everything the geofence would have recorded is entered here instead."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          {(
            [
              ["ARRIVAL", "Arrived at a branch", "What a geofence entry would have written"],
              ["DEPARTURE", "Departed a branch", "What a geofence exit would have written"],
              ["POSITION", "Position report", "Driver rang in — updates the map only"],
            ] as Array<[Mode, string, string]>
          )
            .filter(([value]) => value === "POSITION" || canRecordMovement)
            .map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              disabled={value !== "POSITION" && !trip}
              onClick={() => setMode(value)}
              className={cn(
                "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                value === mode ? "border-primary bg-primary/5" : "border-border hover:bg-muted",
              )}
            >
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-muted-foreground">{hint}</span>
            </button>
          ))}
        </div>

        {mode === "POSITION" ? (
          <PositionForm vehicleId={vehicleId} onDone={() => setOpen(false)} />
        ) : trip ? (
          <MovementForm
            key={mode}
            mode={mode}
            trip={trip}
            branches={branches}
            onDone={() => setOpen(false)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            This vehicle is not on a running trip, so there is nothing for an
            arrival or a departure to apply to.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MovementForm({
  mode,
  trip,
  branches,
  onDone,
}: {
  mode: "ARRIVAL" | "DEPARTURE";
  trip: { id: string; number: string; originCode: string; destinationCode: string };
  branches: BranchOption[];
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    mode === "ARRIVAL" ? recordManualArrivalAction : recordManualDepartureAction,
    IDLE,
  );

  if (state.ok) {
    return (
      <Outcome state={state} onDone={onDone} />
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="tripId" value={trip.id} />

      <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Trip <span className="font-mono text-foreground">{trip.number}</span> ·{" "}
        <span className="font-mono">
          {trip.originCode} → {trip.destinationCode}
        </span>
        . The event goes on every consignment aboard, through the same state
        machine as an automatic one.
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="manual-branch">
          {mode === "ARRIVAL" ? "Arrived at" : "Departed from"}
        </Label>
        <select
          id="manual-branch"
          name="branchId"
          required
          defaultValue=""
          className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="" disabled>
            Choose a branch
          </option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.code} — {branch.name}
            </option>
          ))}
        </select>
        {state.fieldErrors?.branchId && (
          <p className="text-xs text-destructive">{state.fieldErrors.branchId}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="manual-when">When it happened</Label>
        <Input id="manual-when" name="occurredAt" type="datetime-local" />
        <p className="text-xs text-muted-foreground">
          Leave blank for now. A driver who rang in an hour ago should have the
          time he actually arrived, not the time you typed it.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="manual-remarks">Remarks</Label>
        <Textarea
          id="manual-remarks"
          name="remarks"
          rows={2}
          placeholder="Device not reporting; driver confirmed by phone"
        />
      </div>

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}

      <DialogFooter>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          Record {mode === "ARRIVAL" ? "arrival" : "departure"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function PositionForm({ vehicleId, onDone }: { vehicleId: string; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(recordManualPositionAction, IDLE);

  if (state.ok) return <Outcome state={state} onDone={onDone} />;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="vehicleId" value={vehicleId} />

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-lat">Latitude</Label>
          <Input id="manual-lat" name="latitude" inputMode="decimal" placeholder="27.8869" required />
          {state.fieldErrors?.latitude && (
            <p className="text-xs text-destructive">{state.fieldErrors.latitude}</p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-lng">Longitude</Label>
          <Input id="manual-lng" name="longitude" inputMode="decimal" placeholder="76.2836" required />
          {state.fieldErrors?.longitude && (
            <p className="text-xs text-destructive">{state.fieldErrors.longitude}</p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="manual-position-when">When</Label>
        <Input id="manual-position-when" name="occurredAt" type="datetime-local" />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="manual-position-remarks">Remarks</Label>
        <Textarea
          id="manual-position-remarks"
          name="remarks"
          rows={2}
          placeholder="Driver says he is just past the Behror toll"
        />
      </div>

      <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        This moves the vehicle on the map and appears in the trip replay marked
        as a manual fix. It does not fire a geofence event: one typed
        coordinate has none of the corroboration a fence crossing requires, and
        an arrival raised from it would sit outside every safeguard the
        automatic path has.
      </p>

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}

      <DialogFooter>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          Record position
        </Button>
      </DialogFooter>
    </form>
  );
}

function Outcome({ state, onDone }: { state: TrackingState; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">{state.message}</p>

      {state.refused && state.refused.length > 0 && (
        <div className="rounded-lg border border-warn/40 bg-warn-muted/40 px-3 py-2">
          <p className="text-xs font-medium text-warn">
            {state.refused.length} consignment
            {state.refused.length === 1 ? " was" : "s were"} refused
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {state.refused.map((row) => (
              <li key={row.lrNumber} className="text-xs text-muted-foreground">
                <span className="font-mono text-foreground">{row.lrNumber}</span> — {row.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}
