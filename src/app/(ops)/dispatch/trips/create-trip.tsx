"use client";

import { useMemo, useState, useTransition } from "react";
import { Loader2, Plus } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { createTripAction, type TripState } from "./actions";

const IDLE: TripState = {};

export type VehicleOption = {
  id: string;
  registrationNumber: string;
  type: string;
  capacityKg: number;
  status: string;
};
export type DriverOption = { id: string; name: string; mobile: string; status: string };
export type BranchOption = { id: string; code: string; name: string };
export type RouteOption = { id: string; code: string; name: string };
export type FtlOption = {
  id: string;
  lrNumber: string;
  consigneeName: string;
  originBranchId: string;
  destinationBranchId: string;
};

/**
 * Planning a trip.
 *
 * The PTL/FTL choice is a mode switch, not a checkbox on one form: an FTL
 * trip binds to a consignment and will never carry a manifest, and
 * pretending otherwise is what produces a system that does neither well
 * (BRD §A.7). Choosing FTL fills the lane from the consignment, because
 * the consignment is the trip.
 */
export function CreateTripDialog({
  vehicles,
  drivers,
  branches,
  originBranches,
  defaultOriginId,
  routes,
  ftlShipments,
}: {
  vehicles: VehicleOption[];
  drivers: DriverOption[];
  branches: BranchOption[];
  originBranches: BranchOption[];
  defaultOriginId: string | null;
  routes: RouteOption[];
  ftlShipments: FtlOption[];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"PTL" | "FTL">("PTL");
  const [ftlShipmentId, setFtlShipmentId] = useState("");
  const [originId, setOriginId] = useState(
    defaultOriginId ?? originBranches[0]?.id ?? "",
  );
  const [destinationId, setDestinationId] = useState("");
  const [state, setState] = useState<TripState>(IDLE);
  const [pending, startTransition] = useTransition();

  /**
   * `onSubmit` with `preventDefault`, not `<form action={…}>`: React 19
   * resets an uncontrolled form the moment a form action returns, and this
   * one is ten fields deep. A trip refused because the truck's fitness
   * certificate has lapsed used to take the seal number, both planned
   * times and the remarks down with it, so the second attempt started from
   * an empty form — and the whole point of the refusal is that everything
   * except the vehicle was right.
   */
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await createTripAction(IDLE, formData);
      setState(result);
      // A successful create redirects, so there is nothing to close.
      if (result.error) toast.error(result.error, { duration: 8000 });
    });
  }

  const selectedFtl = useMemo(
    () => ftlShipments.find((s) => s.id === ftlShipmentId) ?? null,
    [ftlShipments, ftlShipmentId],
  );

  // Binding a consignment fixes the lane — the truck goes where the goods go.
  const effectiveOrigin = mode === "FTL" && selectedFtl ? selectedFtl.originBranchId : originId;
  const effectiveDestination =
    mode === "FTL" && selectedFtl ? selectedFtl.destinationBranchId : destinationId;

  const branchLabel = (id: string) => {
    const branch = branches.find((b) => b.id === id);
    return branch ? `${branch.code} — ${branch.name}` : "—";
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <Plus />
            Plan trip
          </Button>
        }
      />
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit}>
          <input type="hidden" name="originBranchId" value={effectiveOrigin} />
          <input type="hidden" name="destinationBranchId" value={effectiveDestination} />
          {mode === "FTL" && (
            <input type="hidden" name="ftlShipmentId" value={ftlShipmentId} />
          )}

          <DialogHeader>
            <DialogTitle>Plan a trip</DialogTitle>
            <DialogDescription>
              A vehicle, a driver, and a lane. Gate-out happens later, from
              the trip screen.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            {/* Mode */}
            <div className="flex gap-1.5">
              {(["PTL", "FTL"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setMode(option)}
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2 text-left transition-colors",
                    option === mode
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted",
                  )}
                >
                  <span className="block font-mono text-[0.65rem] uppercase tracking-[0.13em]">
                    {option}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {option === "PTL"
                      ? "Carries manifests for one leg"
                      : "One consignment, no manifest"}
                  </span>
                </button>
              ))}
            </div>

            {mode === "FTL" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ftl-shipment">Consignment</Label>
                <select
                  id="ftl-shipment"
                  value={ftlShipmentId}
                  onChange={(event) => setFtlShipmentId(event.target.value)}
                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
                >
                  <option value="" disabled>
                    {ftlShipments.length === 0
                      ? "No full-truck consignments waiting"
                      : "Choose a consignment"}
                  </option>
                  {ftlShipments.map((shipment) => (
                    <option key={shipment.id} value={shipment.id}>
                      {shipment.lrNumber} — {shipment.consigneeName}
                    </option>
                  ))}
                </select>
                {selectedFtl && (
                  <p className="text-xs text-muted-foreground">
                    Lane taken from the consignment:{" "}
                    {branchLabel(selectedFtl.originBranchId)} →{" "}
                    {branchLabel(selectedFtl.destinationBranchId)}
                  </p>
                )}
                {state.fieldErrors?.ftlShipmentId && (
                  <p className="text-xs text-bad">{state.fieldErrors.ftlShipmentId}</p>
                )}
              </div>
            )}

            {mode === "PTL" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="origin">From</Label>
                  <select
                    id="origin"
                    value={originId}
                    onChange={(event) => setOriginId(event.target.value)}
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
                  >
                    {originBranches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.code} — {branch.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="destination">To</Label>
                  <select
                    id="destination"
                    value={destinationId}
                    onChange={(event) => setDestinationId(event.target.value)}
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
                  >
                    <option value="" disabled>
                      Choose a destination
                    </option>
                    {branches
                      .filter((branch) => branch.id !== originId)
                      .map((branch) => (
                        <option key={branch.id} value={branch.id}>
                          {branch.code} — {branch.name}
                        </option>
                      ))}
                  </select>
                  {state.fieldErrors?.destinationBranchId && (
                    <p className="text-xs text-bad">
                      {state.fieldErrors.destinationBranchId}
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vehicleId">Vehicle</Label>
              <select
                id="vehicleId"
                name="vehicleId"
                defaultValue=""
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
              >
                <option value="" disabled>
                  Choose a vehicle
                </option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicle.registrationNumber} · {vehicle.type} · {vehicle.capacityKg} kg
                    {vehicle.status !== "AVAILABLE" ? ` (${vehicle.status.toLowerCase()})` : ""}
                  </option>
                ))}
              </select>
              {state.fieldErrors?.vehicleId && (
                <p className="text-xs text-bad">{state.fieldErrors.vehicleId}</p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="driverId">Driver</Label>
                <select
                  id="driverId"
                  name="driverId"
                  defaultValue=""
                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
                >
                  <option value="">Assign later</option>
                  {drivers.map((driver) => (
                    <option key={driver.id} value={driver.id}>
                      {driver.name} · {driver.mobile}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="routeId">Route</Label>
                <select
                  id="routeId"
                  name="routeId"
                  defaultValue=""
                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
                >
                  <option value="">None</option>
                  {routes.map((route) => (
                    <option key={route.id} value={route.id}>
                      {route.code} — {route.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plannedDepartureAt">Planned departure</Label>
                <Input
                  id="plannedDepartureAt"
                  name="plannedDepartureAt"
                  type="datetime-local"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plannedArrivalAt">Expected arrival</Label>
                <Input
                  id="plannedArrivalAt"
                  name="plannedArrivalAt"
                  type="datetime-local"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sealNumber">Seal number</Label>
              <Input id="sealNumber" name="sealNumber" maxLength={40} />
              <p className="text-xs text-muted-foreground">
                Can be applied at gate-out instead. A seal broken on arrival
                becomes its own discrepancy.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="trip-remarks">Remarks</Label>
              <Textarea id="trip-remarks" name="remarks" rows={2} maxLength={300} />
            </div>
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
              type="submit"
              disabled={
                pending ||
                effectiveOrigin === "" ||
                effectiveDestination === "" ||
                (mode === "FTL" && ftlShipmentId === "")
              }
            >
              {pending && <Loader2 className="animate-spin" />}
              Plan trip
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
