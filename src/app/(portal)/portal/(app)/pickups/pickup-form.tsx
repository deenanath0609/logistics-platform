"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FormError, selectClass } from "@/components/portal/form";
import { requestPickup, type PickupState } from "./actions";

export type PickupAddress = {
  id: string;
  label: string;
  cityName: string;
  pincode: string;
  isDefault: boolean;
};

const EMPTY: PickupState = {};

const SLOTS = [
  { value: "ANYTIME", label: "Any time" },
  { value: "MORNING", label: "Morning" },
  { value: "AFTERNOON", label: "Afternoon" },
  { value: "EVENING", label: "Evening" },
];

export function PickupForm({ addresses }: { addresses: PickupAddress[] }) {
  const [state, action, pending] = useActionState(requestPickup, EMPTY);

  // The *local* calendar day. This was `toISOString().slice(0, 10)`, which
  // is the UTC one: in IST the two disagree between midnight and 05:30, so
  // anyone opening this form in that window got a date field defaulting to
  // — and floored at — **yesterday**. Submitting it unchanged was refused
  // with "Choose today or a later date", and the customer had no way to
  // see why, because the field showed a date the form itself had put there.
  // See the floor in `requestPickup`, which is built from the same day.
  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-lg border bg-card p-5"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Collect from"
          htmlFor="addressId"
          required
          error={state.fieldErrors?.addressId}
          className="sm:col-span-2"
        >
          <select
            id="addressId"
            name="addressId"
            className={selectClass}
            defaultValue={addresses.find((a) => a.isDefault)?.id ?? addresses[0]?.id}
            required
          >
            {addresses.length === 0 && <option value="">No saved addresses</option>}
            {addresses.map((address) => (
              <option key={address.id} value={address.id}>
                {address.label} — {address.cityName} {address.pincode}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Date"
          htmlFor="requestedDate"
          required
          error={state.fieldErrors?.requestedDate}
        >
          <Input
            id="requestedDate"
            name="requestedDate"
            type="date"
            min={today}
            defaultValue={today}
            required
          />
        </Field>

        <Field label="Slot" htmlFor="slot" required error={state.fieldErrors?.slot}>
          <select id="slot" name="slot" className={selectClass} defaultValue="ANYTIME">
            {SLOTS.map((slot) => (
              <option key={slot.value} value={slot.value}>
                {slot.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Packages (approx.)"
          htmlFor="expectedPackages"
          error={state.fieldErrors?.expectedPackages}
        >
          <Input id="expectedPackages" name="expectedPackages" type="number" min={1} />
        </Field>

        <Field
          label="Weight (approx. kg)"
          htmlFor="expectedWeight"
          error={state.fieldErrors?.expectedWeight}
        >
          <Input id="expectedWeight" name="expectedWeight" type="number" step="0.001" min={0} />
        </Field>

        <Field
          label="What are we collecting?"
          htmlFor="goodsDescription"
          error={state.fieldErrors?.goodsDescription}
          className="sm:col-span-2"
        >
          <Input id="goodsDescription" name="goodsDescription" />
        </Field>

        <Field
          label="Anything the executive should know"
          htmlFor="notes"
          error={state.fieldErrors?.notes}
          className="sm:col-span-2"
          help="Gate numbers, security procedures, who to ask for."
        >
          <Textarea id="notes" name="notes" rows={2} />
        </Field>
      </div>

      <FormError message={state.error} />

      {state.ok && state.message && (
        <p className="rounded-md border border-ok/40 bg-ok-muted px-3 py-2 text-sm text-ok">
          {state.message}
        </p>
      )}

      <div>
        <Button type="submit" disabled={pending || addresses.length === 0}>
          {pending && <Loader2 className="animate-spin" />}
          Request pickup
        </Button>
      </div>
    </form>
  );
}
