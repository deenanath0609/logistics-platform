"use client";

import { useId, useState, useTransition } from "react";
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
import { createPickupRequest } from "./actions";
import type { ActionState } from "@/server/services/master-crud";

const EMPTY: ActionState = {};

const SELECT =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring";

export type BranchChoice = { id: string; code: string; name: string };
export type CityChoice = { id: string; code: string; name: string };
export type CustomerChoice = { id: string; code: string; name: string };

const SLOTS = [
  { value: "ANYTIME", label: "Anytime" },
  { value: "MORNING", label: "Morning" },
  { value: "AFTERNOON", label: "Afternoon" },
  { value: "EVENING", label: "Evening" },
] as const;

/** Today, as the date input spells it. */
function todayValue(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Raising a collection by hand.
 *
 * A booking raises its own pickup, and the portal raises one for a customer
 * who is signed in. Neither covers the consignor who telephones the branch —
 * and until this existed there was no way to serve them: `createPickupRequest`
 * was written, validated, audited, and had no caller anywhere in the product.
 *
 * The form asks for exactly what the action's schema asks for and nothing
 * more. There is no consignment picker: a pickup against an existing booking
 * is raised by the booking itself, so everything raised here is a blind
 * pickup — the case `PickupRequest.shipmentId` was made nullable for.
 */
export function CreatePickupDialog({
  branches,
  cities,
  customers,
  defaultBranchId,
}: {
  branches: BranchChoice[];
  cities: CityChoice[];
  customers: CustomerChoice[];
  defaultBranchId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ActionState>(EMPTY);
  const [pending, startTransition] = useTransition();
  const formId = useId();

  const error = (field: string) => state.fieldErrors?.[field];

  // Fields with a message of their own on the form. Anything the server
  // rejects that is not in here has nowhere to appear, and the dialog would
  // say "check the highlighted fields" while highlighting nothing — so it
  // gets named in the banner instead of vanishing.
  const shown = new Set([
    "branchId",
    "contactName",
    "phone",
    "address",
    "cityId",
    "pincode",
    "requestedDate",
    "expectedPackages",
    "expectedWeight",
  ]);
  const unshown = Object.entries(state.fieldErrors ?? {}).filter(
    ([field]) => !shown.has(field),
  );

  // Submitted by hand rather than through `<form action={…}>`, which in
  // React 19 resets an uncontrolled form as soon as the action returns. On
  // a two-field dialog that is invisible; on fifteen it means a mistyped
  // PIN code throws away the address, the phone number and the notes, and
  // the person on the telephone has to read it all out again.
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await createPickupRequest(EMPTY, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Pickup raised.");
        setOpen(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setState(EMPTY);
        setOpen(next);
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <Plus />
        New pickup
      </DialogTrigger>

      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Raise a pickup</DialogTitle>
          <DialogDescription>
            For the consignor who telephones. A collection booked at the
            counter already has one — this is the one nobody has written down
            yet, so it carries no consignment until the goods arrive.
          </DialogDescription>
        </DialogHeader>

        <form
          id={formId}
          onSubmit={submit}
          className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-0.5 py-1"
        >
          {/*
            Posted empty on purpose. The schema has `shipmentId` as nullable
            rather than optional, so leaving the field out altogether fails
            validation on a key the form does not show — the dialog would
            say "check the highlighted fields" and highlight nothing.
            Empty is also the truth: a pickup raised over the telephone has
            no consignment behind it yet.
          */}
          <input type="hidden" name="shipmentId" value="" />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-branch`}>Collecting branch</Label>
              <select
                id={`${formId}-branch`}
                name="branchId"
                defaultValue={defaultBranchId ?? ""}
                className={SELECT}
                required
              >
                <option value="">Choose a branch</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.code} — {branch.name}
                  </option>
                ))}
              </select>
              {error("branchId") && (
                <p className="text-xs text-bad">{error("branchId")}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-customer`}>Account (optional)</Label>
              <select
                id={`${formId}-customer`}
                name="customerId"
                defaultValue=""
                className={SELECT}
              >
                <option value="">Not an account customer</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.code} — {customer.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Leave this alone for a walk-up. It only decides whose history
                the collection appears in.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-contact`}>Whom to ask for</Label>
              <Input
                id={`${formId}-contact`}
                name="contactName"
                maxLength={120}
                required
                autoComplete="off"
              />
              {error("contactName") && (
                <p className="text-xs text-bad">{error("contactName")}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-phone`}>Phone</Label>
              <Input
                id={`${formId}-phone`}
                name="phone"
                inputMode="numeric"
                maxLength={10}
                className="font-mono"
                required
                autoComplete="off"
              />
              {error("phone") && (
                <p className="text-xs text-bad">{error("phone")}</p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-address`}>Address</Label>
            <Textarea
              id={`${formId}-address`}
              name="address"
              rows={2}
              maxLength={300}
              required
            />
            {error("address") && (
              <p className="text-xs text-bad">{error("address")}</p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-city`}>City</Label>
              <select
                id={`${formId}-city`}
                name="cityId"
                defaultValue=""
                className={SELECT}
                required
              >
                <option value="">Choose a city</option>
                {cities.map((city) => (
                  <option key={city.id} value={city.id}>
                    {city.name}
                  </option>
                ))}
              </select>
              {error("cityId") && (
                <p className="text-xs text-bad">{error("cityId")}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-pincode`}>PIN code</Label>
              <Input
                id={`${formId}-pincode`}
                name="pincode"
                inputMode="numeric"
                maxLength={6}
                className="font-mono"
                required
                autoComplete="off"
              />
              {error("pincode") && (
                <p className="text-xs text-bad">{error("pincode")}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-landmark`}>Landmark</Label>
              <Input
                id={`${formId}-landmark`}
                name="landmark"
                maxLength={120}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-date`}>Collect on</Label>
              <Input
                id={`${formId}-date`}
                name="requestedDate"
                type="date"
                defaultValue={todayValue()}
                required
              />
              {error("requestedDate") && (
                <p className="text-xs text-bad">{error("requestedDate")}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-slot`}>Slot</Label>
              <select
                id={`${formId}-slot`}
                name="slot"
                defaultValue="ANYTIME"
                className={SELECT}
              >
                {SLOTS.map((slot) => (
                  <option key={slot.value} value={slot.value}>
                    {slot.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-priority`}>Priority</Label>
              <Input
                id={`${formId}-priority`}
                name="priority"
                type="number"
                min={0}
                max={9}
                defaultValue={0}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                0 is ordinary. Higher sorts earlier in the run.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-packages`}>Packages expected</Label>
              <Input
                id={`${formId}-packages`}
                name="expectedPackages"
                type="number"
                min={1}
                className="font-mono"
                placeholder="Unknown"
              />
              {error("expectedPackages") && (
                <p className="text-xs text-bad">{error("expectedPackages")}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-weight`}>Weight expected (kg)</Label>
              <Input
                id={`${formId}-weight`}
                name="expectedWeight"
                type="number"
                min={0}
                step="0.001"
                className="font-mono"
                placeholder="Unknown"
              />
              {error("expectedWeight") && (
                <p className="text-xs text-bad">{error("expectedWeight")}</p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-goods`}>What is being collected</Label>
            <Input
              id={`${formId}-goods`}
              name="goodsDescription"
              maxLength={300}
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-notes`}>Notes for the executive</Label>
            <Textarea
              id={`${formId}-notes`}
              name="notes"
              rows={2}
              maxLength={300}
              placeholder="Gate code, which dock, when the office shuts"
            />
          </div>

          {state.error && (
            <div
              role="alert"
              className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
            >
              <p>{state.error}</p>
              {unshown.length > 0 && (
                <ul className="mt-1 list-inside list-disc text-xs">
                  {unshown.map(([field, message]) => (
                    <li key={field}>
                      <span className="font-mono">{field}</span>: {message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            Raise pickup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
