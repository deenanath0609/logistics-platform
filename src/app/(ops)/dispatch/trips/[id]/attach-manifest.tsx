"use client";

import { useState, useTransition } from "react";
import { Loader2, Link2, Unlink } from "lucide-react";
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
import { attachManifestAction, type TripState } from "../actions";

const IDLE: TripState = {};

export type AttachableManifest = {
  id: string;
  number: string;
  totalShipments: number;
  weightKg: number;
};

/**
 * Putting a manifest on this truck, from the truck's side.
 *
 * The counterpart of `AssignTrip` on the manifest screen — the same
 * service, reached from where the dispatcher is standing. At the gate the
 * vehicle is what is in front of them and the paperwork is what they are
 * looking for, so being told to go and find the manifest screen instead is
 * how a load leaves with a manifest still unattached to anything.
 *
 * Detach is per manifest and only before departure; `setManifestTrip`
 * refuses once the trip has gone, and the buttons follow it.
 */
export function AttachManifest({
  tripId,
  available,
  attached,
  capacityKg,
  loadedKg,
}: {
  tripId: string;
  available: AttachableManifest[];
  attached: Array<{ id: string; number: string }>;
  capacityKg: number | null;
  loadedKg: number;
}) {
  const [open, setOpen] = useState(false);
  const [manifestId, setManifestId] = useState("");
  const [state, setState] = useState<TripState>(IDLE);
  const [pending, startTransition] = useTransition();

  function run(id: string, detach: boolean) {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("tripId", tripId);
      formData.set("manifestId", id);
      if (detach) formData.set("detach", "true");

      const result = await attachManifestAction(IDLE, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Done.");
        setOpen(false);
      } else if (result.error) {
        toast.error(result.error, { duration: 8000 });
      }
    });
  }

  const headroom = capacityKg === null ? null : capacityKg - loadedKg;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) setState(IDLE);
          setOpen(next);
        }}
      >
        <DialogTrigger render={<Button variant="outline" size="sm" />}>
          <Link2 />
          Attach a manifest
        </DialogTrigger>

        <DialogContent>
          <DialogHeader>
            <DialogTitle>Attach a manifest to this trip</DialogTitle>
            <DialogDescription>
              Draft and closed manifests running the same leg, not already on
              another truck. Everything on them gates out with this vehicle.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5 py-4">
            <Label htmlFor="attach-manifest">Manifest</Label>
            <select
              id="attach-manifest"
              value={manifestId}
              onChange={(event) => setManifestId(event.target.value)}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
            >
              <option value="" disabled>
                {available.length === 0
                  ? "No unassigned manifest runs this leg"
                  : "Choose a manifest"}
              </option>
              {available.map((manifest) => (
                <option key={manifest.id} value={manifest.id}>
                  {manifest.number} · {manifest.totalShipments} consignment
                  {manifest.totalShipments === 1 ? "" : "s"} · {manifest.weightKg} kg
                  {headroom !== null && manifest.weightKg > headroom
                    ? " — more than this truck has room for"
                    : ""}
                </option>
              ))}
            </select>
            {headroom !== null && (
              <p className="text-xs text-muted-foreground">
                {headroom >= 0
                  ? `${Math.round(headroom * 1000) / 1000} kg of payload still free.`
                  : `Already ${Math.abs(Math.round(headroom * 1000) / 1000)} kg over.`}
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
              onClick={() => run(manifestId, false)}
              disabled={pending || manifestId === ""}
            >
              {pending && <Loader2 className="animate-spin" />}
              Attach
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {attached.map((manifest) => (
        <Button
          key={manifest.id}
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => run(manifest.id, true)}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Unlink />}
          Detach {manifest.number}
        </Button>
      ))}
    </div>
  );
}
