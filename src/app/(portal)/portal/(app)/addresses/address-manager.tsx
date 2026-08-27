"use client";

import { useActionState, useState } from "react";
import { Loader2, MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FormError,
  selectClass,
  type SelectOption,
} from "@/components/portal/form";
import { saveAddress, retireAddress, type AddressState } from "./actions";
import { cn } from "@/lib/utils";

export type AddressRow = {
  id: string;
  label: string;
  kind: "PICKUP" | "DELIVERY" | "BILLING";
  contactName: string | null;
  phone: string | null;
  address: string;
  cityId: string;
  cityName: string;
  pincode: string;
  landmark: string | null;
  isDefault: boolean;
};

const EMPTY: AddressState = {};

const KINDS = [
  { value: "PICKUP", label: "Pickup" },
  { value: "DELIVERY", label: "Delivery" },
  { value: "BILLING", label: "Billing" },
];

export function AddressManager({
  addresses,
  cities,
  readOnly,
}: {
  addresses: AddressRow[];
  cities: SelectOption[];
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState<AddressRow | "new" | null>(null);
  const [state, action, pending] = useActionState(saveAddress, EMPTY);

  const draft = editing === "new" ? null : editing;

  return (
    <div className="flex flex-col gap-6">
      {!readOnly && (
        <div className="flex items-center gap-3">
          <Button
            onClick={() => setEditing(editing ? null : "new")}
            variant={editing ? "outline" : "default"}
          >
            <Plus />
            {editing ? "Close" : "Add an address"}
          </Button>
          {state.ok && state.message && (
            <span className="text-sm text-ok">{state.message}</span>
          )}
        </div>
      )}

      {editing && !readOnly && (
        <form
          action={action}
          key={draft?.id ?? "new"}
          className="flex flex-col gap-4 rounded-lg border bg-card p-5"
        >
          {draft && <input type="hidden" name="id" value={draft.id} />}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name it" htmlFor="label" required error={state.fieldErrors?.label}>
              <Input
                id="label"
                name="label"
                defaultValue={draft?.label}
                placeholder="Head office, Plant 2, Warehouse"
                required
              />
            </Field>

            <Field label="Used for" htmlFor="kind" required error={state.fieldErrors?.kind}>
              <select
                id="kind"
                name="kind"
                className={selectClass}
                defaultValue={draft?.kind ?? "PICKUP"}
              >
                {KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Contact name" htmlFor="contactName" error={state.fieldErrors?.contactName}>
              <Input id="contactName" name="contactName" defaultValue={draft?.contactName ?? ""} />
            </Field>

            <Field label="Phone" htmlFor="phone" error={state.fieldErrors?.phone}>
              <Input
                id="phone"
                name="phone"
                inputMode="numeric"
                maxLength={10}
                defaultValue={draft?.phone ?? ""}
              />
            </Field>

            <Field
              label="Address"
              htmlFor="address"
              required
              error={state.fieldErrors?.address}
              className="sm:col-span-2"
            >
              <Textarea id="address" name="address" rows={2} defaultValue={draft?.address} required />
            </Field>

            <Field label="City" htmlFor="cityId" required error={state.fieldErrors?.cityId}>
              <select
                id="cityId"
                name="cityId"
                className={selectClass}
                defaultValue={draft?.cityId ?? ""}
                required
              >
                <option value="" disabled>
                  Choose a city
                </option>
                {cities.map((city) => (
                  <option key={city.value} value={city.value}>
                    {city.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="PIN code" htmlFor="pincode" required error={state.fieldErrors?.pincode}>
              <Input
                id="pincode"
                name="pincode"
                inputMode="numeric"
                maxLength={6}
                defaultValue={draft?.pincode}
                required
              />
            </Field>

            <Field
              label="Landmark"
              htmlFor="landmark"
              error={state.fieldErrors?.landmark}
              className="sm:col-span-2"
            >
              <Input id="landmark" name="landmark" defaultValue={draft?.landmark ?? ""} />
            </Field>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
            <Label htmlFor="isDefault" className="cursor-pointer">
              Use this one by default
            </Label>
            <input type="hidden" name="isDefault" value="false" />
            <Switch
              id="isDefault"
              name="isDefault"
              value="true"
              defaultChecked={draft?.isDefault}
            />
          </div>

          <FormError message={state.error} />

          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              {draft ? "Save changes" : "Add address"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {addresses.map((address) => (
          <article
            key={address.id}
            className={cn(
              "flex flex-col gap-1 rounded-lg border bg-card p-4",
              address.isDefault && "border-primary/50",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col">
                <p className="truncate font-medium">{address.label}</p>
                <p className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
                  {address.kind.toLowerCase()}
                  {address.isDefault && " · default"}
                </p>
              </div>
              {!readOnly && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Edit ${address.label}`}
                    onClick={() => setEditing(address)}
                  >
                    <Pencil />
                  </Button>
                  <RetireButton id={address.id} label={address.label} />
                </div>
              )}
            </div>

            <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
              <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {address.address}, {address.cityName}{" "}
                <span className="font-mono">{address.pincode}</span>
              </span>
            </p>

            {(address.contactName || address.phone) && (
              <p className="text-xs text-muted-foreground">
                {address.contactName}
                {address.contactName && address.phone ? " · " : ""}
                {address.phone}
              </p>
            )}
          </article>
        ))}
      </div>

      {addresses.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No saved addresses yet. Adding them here means nobody has to type
          your warehouse address again.
        </p>
      )}
    </div>
  );
}

function RetireButton({ id, label }: { id: string; label: string }) {
  const [state, action, pending] = useActionState(retireAddress, EMPTY);

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${label}`}
        title={state.error}
        disabled={pending}
      >
        {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
      </Button>
    </form>
  );
}
