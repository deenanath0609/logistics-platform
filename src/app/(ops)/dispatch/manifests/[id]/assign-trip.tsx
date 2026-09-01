"use client";

import { useState, useTransition } from "react";
import { Loader2, Truck, Unlink } from "lucide-react";
import { toast } from "sonner";
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
import { setManifestTripAction, type ManifestState } from "../actions";

const IDLE: ManifestState = {};

export type AssignableTrip = {
  id: string;
  number: string;
  registrationNumber: string;
  capacityKg: number | null;
  plannedDeparture: string | null;
};

/**
 * Putting a manifest on a truck.
 *
 * `setManifestTrip` existed, was permissioned, scoped and audited, and no
 * control anywhere reached it. A manifest could only be given a vehicle in
 * the dialog that created it, which is the one moment a dispatcher least
 * often knows which truck is coming — so a manifest built at eight in the
 * morning against a lorry that turned up at eleven could never be joined
 * to it, never showed a utilisation bar, and could not gate out at all.
 * The screen even said "attach one from the trip screen", where there was
 * no control either.
 *
 * Detach is offered in the same place. Swapping a broken-down truck for a
 * bigger one is the ordinary remedy for both an overloaded manifest and a
 * vehicle that failed at the gate, and it has to be reversible.
 */
export function AssignTrip({
  manifestId,
  trips,
  currentTripNumber,
  weightKg,
}: {
  manifestId: string;
  trips: AssignableTrip[];
  currentTripNumber: string | null;
  weightKg: number;
}) {
  const [open, setOpen] = useState(false);
  const [tripId, setTripId] = useState("");
  const [state, setState] = useState<ManifestState>(IDLE);
  const [pending, startTransition] = useTransition();

  function run(nextTripId: string) {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("manifestId", manifestId);
      formData.set("tripId", nextTripId);

      const result = await setManifestTripAction(IDLE, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Done.");
        setOpen(false);
      } else if (result.error) {
        toast.error(result.error, { duration: 8000 });
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) setState(IDLE);
          setOpen(next);
        }}
      >
        <DialogTrigger render={<Button variant="outline" size="sm" />}>
          <Truck />
          {currentTripNumber ? "Change vehicle" : "Assign a vehicle"}
        </DialogTrigger>

        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {currentTripNumber ? "Change the vehicle" : "Assign a vehicle"}
            </DialogTitle>
            <DialogDescription>
              Only trips that leave this manifest&rsquo;s origin, arrive at its
              destination, and have not yet departed. A full-truck trip is
              bound to its own consignment and carries no manifest.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5 py-4">
            <Label htmlFor="assign-trip">Trip</Label>
            <select
              id="assign-trip"
              value={tripId}
              onChange={(event) => setTripId(event.target.value)}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
            >
              <option value="" disabled>
                {trips.length === 0
                  ? "No planned trip runs this leg"
                  : "Choose a trip"}
              </option>
              {trips.map((trip) => (
                <option key={trip.id} value={trip.id}>
                  {trip.number} · {trip.registrationNumber}
                  {trip.capacityKg !== null ? ` · ${trip.capacityKg} kg` : ""}
                  {trip.capacityKg !== null && weightKg > trip.capacityKg
                    ? " — too small for this load"
                    : ""}
                  {trip.plannedDeparture ? ` · ${trip.plannedDeparture}` : ""}
                </option>
              ))}
            </select>
            {trips.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Plan one on the trips screen for this lane first.
              </p>
            )}
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
            <Button
              type="button"
              onClick={() => run(tripId)}
              disabled={pending || tripId === ""}
            >
              {pending && <Loader2 className="animate-spin" />}
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {currentTripNumber && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => run("")}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Unlink />}
          Detach {currentTripNumber}
        </Button>
      )}
    </div>
  );
}
