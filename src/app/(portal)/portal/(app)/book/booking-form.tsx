"use client";
import type { ShipmentMode } from "@/generated/prisma/client";

import { useActionState, useMemo, useState } from "react";
import { Loader2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Field,
  FormError,
  Section,
  selectClass,
  type SelectOption,
} from "@/components/portal/form";
import { bookFromPortal, type PortalBookingState } from "./actions";

export type PickupAddressOption = {
  id: string;
  label: string;
  address: string;
  cityName: string;
  pincode: string;
  contactName: string | null;
  phone: string | null;
  isDefault: boolean;
};

export type PortalServiceOption = {
  id: string;
  name: string;
  mode: ShipmentMode;
  allowsCod: boolean;
  allowsToPay: boolean;
};

const EMPTY: PortalBookingState = {};

/**
 * A switch plus the hidden "false" input that makes an unchecked toggle
 * still post a value — FormData omits an unchecked control entirely.
 */
function Toggle({
  id,
  label,
  help,
  defaultChecked,
}: {
  id: string;
  label: string;
  help?: string;
  defaultChecked?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id} className="cursor-pointer">
          {label}
        </Label>
        {help && <p className="text-xs text-muted-foreground">{help}</p>}
      </div>
      <input type="hidden" name={id} value="false" />
      <Switch id={id} name={id} value="true" defaultChecked={defaultChecked} />
    </div>
  );
}

/**
 * The portal booking form.
 *
 * Note what it does not have: an origin branch, a destination branch, a
 * consignor block, or a charges table. Branches are derived on the server
 * from the PIN codes, the consignor is the signed-in account, and rating
 * is Phase 6's job. A form that cannot post those fields cannot be used to
 * post them.
 */
export function PortalBookingForm({
  addresses,
  services,
  cities,
  packageTypes,
}: {
  addresses: PickupAddressOption[];
  services: PortalServiceOption[];
  cities: SelectOption[];
  packageTypes: SelectOption[];
}) {
  const [state, action, pending] = useActionState(bookFromPortal, EMPTY);

  const [addressId, setAddressId] = useState(
    addresses.find((a) => a.isDefault)?.id ?? addresses[0]?.id ?? "",
  );
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [paymentType, setPaymentType] = useState("PAID");

  const pickup = useMemo(
    () => addresses.find((a) => a.id === addressId),
    [addresses, addressId],
  );
  const service = useMemo(
    () => services.find((s) => s.id === serviceId),
    [services, serviceId],
  );

  const paymentOptions = [
    { value: "PAID", label: "Paid — we pay" },
    ...(service?.allowsToPay
      ? [{ value: "TO_PAY", label: "To-Pay — consignee pays" }]
      : []),
    ...(service?.allowsCod
      ? [{ value: "COD", label: "COD — collect on delivery" }]
      : []),
  ];

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="mode" value={service?.mode ?? "PTL"} />

      <Section
        title="Collect from"
        description="One of your saved addresses. Add another under Saved addresses."
      >
        <Field
          label="Pickup address"
          htmlFor="pickupAddressId"
          required
          error={state.fieldErrors?.pickupAddressId}
        >
          <select
            id="pickupAddressId"
            name="pickupAddressId"
            className={selectClass}
            value={addressId}
            onChange={(e) => setAddressId(e.target.value)}
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

        {pickup && (
          <p className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {pickup.address}, {pickup.cityName} {pickup.pincode}
              {pickup.contactName ? ` · ${pickup.contactName}` : ""}
              {pickup.phone ? ` · ${pickup.phone}` : ""}
            </span>
          </p>
        )}

        <Field label="Service" htmlFor="serviceTypeId" required error={state.fieldErrors?.serviceTypeId}>
          <select
            id="serviceTypeId"
            name="serviceTypeId"
            className={selectClass}
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            required
          >
            {services.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} · {option.mode}
              </option>
            ))}
          </select>
        </Field>

        <Toggle
          id="pickupRequired"
          label="Send someone to collect it"
          help="Off means you will bring the consignment to the branch."
          defaultChecked
        />
      </Section>

      <Section title="Deliver to">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Consignee name" htmlFor="consigneeName" required error={state.fieldErrors?.consigneeName}>
            <Input id="consigneeName" name="consigneeName" required />
          </Field>
          <Field label="Company" htmlFor="consigneeCompany" error={state.fieldErrors?.consigneeCompany}>
            <Input id="consigneeCompany" name="consigneeCompany" />
          </Field>
          <Field label="Phone" htmlFor="consigneePhone" required error={state.fieldErrors?.consigneePhone}>
            <Input id="consigneePhone" name="consigneePhone" inputMode="numeric" maxLength={10} required />
          </Field>
          <Field label="Email" htmlFor="consigneeEmail" error={state.fieldErrors?.consigneeEmail}>
            <Input id="consigneeEmail" name="consigneeEmail" type="email" />
          </Field>
          <Field
            label="Address"
            htmlFor="consigneeAddress"
            required
            error={state.fieldErrors?.consigneeAddress}
            className="sm:col-span-2"
          >
            <Textarea id="consigneeAddress" name="consigneeAddress" rows={2} required />
          </Field>
          <Field label="City" htmlFor="consigneeCityId" required error={state.fieldErrors?.consigneeCityId}>
            <select id="consigneeCityId" name="consigneeCityId" className={selectClass} required defaultValue="">
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
          <Field label="PIN code" htmlFor="consigneePincode" required error={state.fieldErrors?.consigneePincode}>
            <Input id="consigneePincode" name="consigneePincode" inputMode="numeric" maxLength={6} required />
          </Field>
          <Field label="Landmark" htmlFor="consigneeLandmark" error={state.fieldErrors?.consigneeLandmark}>
            <Input id="consigneeLandmark" name="consigneeLandmark" />
          </Field>
          <Field label="Consignee GSTIN" htmlFor="consigneeGstin" error={state.fieldErrors?.consigneeGstin}>
            <Input id="consigneeGstin" name="consigneeGstin" className="font-mono uppercase" />
          </Field>
        </div>
      </Section>

      <Section title="Goods">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Packages" htmlFor="packageCount" required error={state.fieldErrors?.packageCount}>
            <Input id="packageCount" name="packageCount" type="number" min={1} defaultValue={1} required />
          </Field>
          <Field label="Package type" htmlFor="packageTypeId" error={state.fieldErrors?.packageTypeId}>
            <select id="packageTypeId" name="packageTypeId" className={selectClass} defaultValue="">
              <option value="">Not specified</option>
              {packageTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Actual weight (kg)"
            htmlFor="actualWeight"
            required
            error={state.fieldErrors?.actualWeight}
            help="We re-weigh at the hub; that figure is what bills."
          >
            <Input id="actualWeight" name="actualWeight" type="number" step="0.001" min={0.001} required />
          </Field>
          <Field
            label="Goods description"
            htmlFor="goodsDescription"
            required
            error={state.fieldErrors?.goodsDescription}
            className="sm:col-span-2"
          >
            <Input id="goodsDescription" name="goodsDescription" required />
          </Field>
          <Field label="Declared value (₹)" htmlFor="declaredValue" error={state.fieldErrors?.declaredValue}>
            <Input id="declaredValue" name="declaredValue" type="number" step="0.01" min={0} />
          </Field>
          <Field
            label="Special instructions"
            htmlFor="specialInstructions"
            error={state.fieldErrors?.specialInstructions}
            className="sm:col-span-3"
          >
            <Textarea id="specialInstructions" name="specialInstructions" rows={2} />
          </Field>
        </div>

        <Toggle
          id="isFragile"
          label="Fragile"
          help="Flags it on the label and on the manifest."
        />
      </Section>

      <Section title="Payment and references">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Payment" htmlFor="paymentType" required error={state.fieldErrors?.paymentType}>
            <select
              id="paymentType"
              name="paymentType"
              className={selectClass}
              value={paymentType}
              onChange={(e) => setPaymentType(e.target.value)}
            >
              {paymentOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          {paymentType === "COD" && (
            <Field label="Collect (₹)" htmlFor="codAmount" required error={state.fieldErrors?.codAmount}>
              <Input id="codAmount" name="codAmount" type="number" step="0.01" min={1} required />
            </Field>
          )}

          <Field
            label="Your reference"
            htmlFor="customerReference"
            error={state.fieldErrors?.customerReference}
            help="Shown back to you on tracking and on the invoice."
          >
            <Input id="customerReference" name="customerReference" />
          </Field>
          <Field label="Invoice number" htmlFor="invoiceNumber" error={state.fieldErrors?.invoiceNumber}>
            <Input id="invoiceNumber" name="invoiceNumber" />
          </Field>
          <Field label="Invoice value (₹)" htmlFor="invoiceValue" error={state.fieldErrors?.invoiceValue}>
            <Input id="invoiceValue" name="invoiceValue" type="number" step="0.01" min={0} />
          </Field>
        </div>

        <p className="text-xs text-muted-foreground">
          Freight is priced by your branch against your rate card. Charges
          appear on the shipment once it has been rated.
        </p>
      </Section>

      <FormError message={state.error} />

      <div className="flex items-center gap-3">
        <Button type="submit" size="lg" disabled={pending || addresses.length === 0}>
          {pending && <Loader2 className="animate-spin" />}
          Book consignment
        </Button>
        {addresses.length === 0 && (
          <span className="text-sm text-muted-foreground">
            Add a pickup address first.
          </span>
        )}
      </div>
    </form>
  );
}
