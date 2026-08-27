"use client";

import { useMemo, useState, useTransition, useId } from "react";
import { Loader2, Truck, AlertTriangle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  PincodeField,
  type PincodeAnswer,
} from "@/components/shipment/pincode-field";
import { cn } from "@/lib/utils";
import { bookShipment, type BookingFormState } from "./actions";

export type Option = { value: string; label: string };

export type CustomerOption = {
  id: string;
  code: string;
  name: string;
  phone: string;
  gstin: string | null;
  addresses: Array<{
    id: string;
    label: string;
    kind: string;
    address: string;
    cityId: string;
    pincode: string;
    contactName: string | null;
    phone: string | null;
    isDefault: boolean;
  }>;
};

export type ServiceOption = {
  id: string;
  code: string;
  name: string;
  mode: "FTL" | "PTL" | "COURIER";
  volumetricDivisor: number;
  allowsCod: boolean;
  allowsToPay: boolean;
};

export type ChargeOption = {
  id: string;
  code: string;
  name: string;
  taxPercent: number | null;
};

const EMPTY: BookingFormState = {};

function Field({
  label,
  htmlFor,
  required,
  error,
  help,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  error?: string;
  help?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="ml-0.5 text-bad">*</span>}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-bad">{error}</p>
      ) : help ? (
        <p className="text-xs text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

const selectClass =
  "h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive";

export function BookingForm({
  services,
  branches,
  cities,
  packageTypes,
  chargeTypes,
  customers,
  defaultBranchId,
}: {
  services: ServiceOption[];
  branches: Option[];
  cities: Option[];
  packageTypes: Option[];
  chargeTypes: ChargeOption[];
  customers: CustomerOption[];
  defaultBranchId: string | null;
}) {
  const [state, setState] = useState<BookingFormState>(EMPTY);
  const [pending, startTransition] = useTransition();
  const formId = useId();

  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [paymentType, setPaymentType] = useState("PAID");
  const [consignorId, setConsignorId] = useState("");
  const [actualWeight, setActualWeight] = useState("");
  const [consignorPin, setConsignorPin] = useState("");
  const [consigneePin, setConsigneePin] = useState("");
  const [destination, setDestination] = useState<PincodeAnswer | null>(null);
  const [dimensions, setDimensions] = useState({ l: "", b: "", h: "" });
  const [packageCount, setPackageCount] = useState("1");
  const [charges, setCharges] = useState<Record<string, string>>({});

  const service = services.find((s) => s.id === serviceId);
  const customer = customers.find((c) => c.id === consignorId);
  const error = (name: string) => state.fieldErrors?.[name];

  // Live weight maths, mirroring src/lib/shipment/weight.ts. The server
  // recomputes it — this is here so the clerk sees the billable figure
  // before saving, not after.
  const weights = useMemo(() => {
    const actual = Number(actualWeight) || 0;
    const count = Math.max(1, Number(packageCount) || 1);
    const l = Number(dimensions.l) || 0;
    const b = Number(dimensions.b) || 0;
    const h = Number(dimensions.h) || 0;
    const divisor = service?.volumetricDivisor ?? 5000;

    const volumetric = l && b && h ? (l * b * h * count) / divisor : 0;
    const greater = Math.max(actual, volumetric);
    const chargeable = Math.ceil(greater / 0.5) * 0.5;

    return {
      actual,
      volumetric,
      chargeable,
      basis: volumetric > actual ? "volumetric" : "actual",
      divisor,
    };
  }, [actualWeight, packageCount, dimensions, service]);

  // Only trust a verdict that describes the code currently on screen.
  const destinationAnswer =
    destination?.code === consigneePin ? destination : null;
  // Nobody can book to a PIN the network has never heard of.
  const undeliverable = destinationAnswer?.status === "UNKNOWN";
  // Suspended: bookable, but only with the override permission.
  const needsOverride = destinationAnswer?.status === "BLOCKED";
  const isOda = destinationAnswer?.status === "ODA";

  const chargeTotal = useMemo(
    () =>
      Object.values(charges).reduce((sum, value) => sum + (Number(value) || 0), 0),
    [charges],
  );

  const taxTotal = useMemo(
    () =>
      chargeTypes.reduce((sum, ct) => {
        const amount = Number(charges[ct.id]) || 0;
        return sum + (amount * (ct.taxPercent ?? 0)) / 100;
      }, 0),
    [charges, chargeTypes],
  );

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await bookShipment(EMPTY, formData);
      // A successful booking redirects, so anything returned is a failure.
      setState(result);
      if (result.error) {
        document
          .getElementById(formId)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  function applyCustomer(id: string) {
    setConsignorId(id);
    const picked = customers.find((c) => c.id === id);
    if (!picked) return;

    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;

    const set = (name: string, value: string) => {
      const el = form.elements.namedItem(name) as
        | HTMLInputElement
        | HTMLTextAreaElement
        | HTMLSelectElement
        | null;
      if (el) el.value = value;
    };

    set("consignorName", picked.name);
    set("consignorPhone", picked.phone);
    set("consignorGstin", picked.gstin ?? "");

    const pickup =
      picked.addresses.find((a) => a.kind === "PICKUP" && a.isDefault) ??
      picked.addresses.find((a) => a.kind === "PICKUP") ??
      picked.addresses[0];

    if (pickup) {
      set("consignorAddress", pickup.address);
      set("consignorCityId", pickup.cityId);
      set("consignorPincode", pickup.pincode);
    }
  }

  return (
    <form id={formId} action={submit} className="flex flex-col gap-6">
      {state.error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad-muted px-4 py-3 text-sm text-bad"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {state.error}
        </p>
      )}

      <Section
        title="Service and route"
        description="The service decides the volumetric divisor, the transit expectation, and whether COD is even offered."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Service" htmlFor={`${formId}-service`} required error={error("serviceTypeId")}>
            <select
              id={`${formId}-service`}
              name="serviceTypeId"
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              className={selectClass}
              required
            >
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
          </Field>

          {/* Mode follows the service; sending them separately would let
              them disagree, and the server rejects that. */}
          <input type="hidden" name="mode" value={service?.mode ?? "PTL"} />

          <Field label="Mode" htmlFor={`${formId}-mode-display`}>
            <Input
              id={`${formId}-mode-display`}
              value={service?.mode ?? ""}
              readOnly
              className="bg-muted font-mono"
            />
          </Field>

          <Field label="Origin branch" htmlFor={`${formId}-origin`} required error={error("originBranchId")}>
            <select
              id={`${formId}-origin`}
              name="originBranchId"
              defaultValue={defaultBranchId ?? ""}
              className={selectClass}
              required
            >
              <option value="">Select…</option>
              {branches.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Destination branch" htmlFor={`${formId}-destination`} required error={error("destinationBranchId")}>
            <select
              id={`${formId}-destination`}
              name="destinationBranchId"
              className={selectClass}
              required
            >
              <option value="">Select…</option>
              {branches.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Consignor" description="Who is sending it.">
          <Field
            label="Account"
            htmlFor={`${formId}-account`}
            help="Picking an account fills the rest from its saved pickup address."
          >
            <select
              id={`${formId}-account`}
              name="consignorId"
              value={consignorId}
              onChange={(e) => applyCustomer(e.target.value)}
              className={selectClass}
            >
              <option value="">Walk-in / cash booking</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor={`${formId}-cnorName`} required error={error("consignorName")}>
              <Input id={`${formId}-cnorName`} name="consignorName" required />
            </Field>
            <Field label="Company" htmlFor={`${formId}-cnorCompany`}>
              <Input id={`${formId}-cnorCompany`} name="consignorCompany" />
            </Field>
            <Field label="Phone" htmlFor={`${formId}-cnorPhone`} required error={error("consignorPhone")}>
              <Input id={`${formId}-cnorPhone`} name="consignorPhone" inputMode="numeric" maxLength={10} className="font-mono" required />
            </Field>
            <Field label="Email" htmlFor={`${formId}-cnorEmail`} error={error("consignorEmail")}>
              <Input id={`${formId}-cnorEmail`} name="consignorEmail" type="email" />
            </Field>
          </div>

          <Field label="Pickup address" htmlFor={`${formId}-cnorAddress`} required error={error("consignorAddress")}>
            <Textarea id={`${formId}-cnorAddress`} name="consignorAddress" rows={2} required />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="City" htmlFor={`${formId}-cnorCity`} required error={error("consignorCityId")}>
              <select id={`${formId}-cnorCity`} name="consignorCityId" className={selectClass} required>
                <option value="">Select…</option>
                {cities.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </Field>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-cnorPin`}>
                PIN<span className="ml-0.5 text-bad">*</span>
              </Label>
              <PincodeField
                name="consignorPincode"
                value={consignorPin}
                onValueChange={setConsignorPin}
                required
                error={error("consignorPincode")}
              />
            </div>
            <Field label="GSTIN" htmlFor={`${formId}-cnorGstin`}>
              <Input id={`${formId}-cnorGstin`} name="consignorGstin" className="font-mono uppercase" />
            </Field>
          </div>
        </Section>

        <Section title="Consignee" description="Who is receiving it.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor={`${formId}-cneeName`} required error={error("consigneeName")}>
              <Input id={`${formId}-cneeName`} name="consigneeName" required />
            </Field>
            <Field label="Company" htmlFor={`${formId}-cneeCompany`}>
              <Input id={`${formId}-cneeCompany`} name="consigneeCompany" />
            </Field>
            <Field label="Phone" htmlFor={`${formId}-cneePhone`} required error={error("consigneePhone")} help="Delivery OTP goes here.">
              <Input id={`${formId}-cneePhone`} name="consigneePhone" inputMode="numeric" maxLength={10} className="font-mono" required />
            </Field>
            <Field label="Email" htmlFor={`${formId}-cneeEmail`} error={error("consigneeEmail")}>
              <Input id={`${formId}-cneeEmail`} name="consigneeEmail" type="email" />
            </Field>
          </div>

          <Field label="Delivery address" htmlFor={`${formId}-cneeAddress`} required error={error("consigneeAddress")}>
            <Textarea id={`${formId}-cneeAddress`} name="consigneeAddress" rows={2} required />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="City" htmlFor={`${formId}-cneeCity`} required error={error("consigneeCityId")}>
              <select id={`${formId}-cneeCity`} name="consigneeCityId" className={selectClass} required>
                <option value="">Select…</option>
                {cities.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </Field>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-cneePin`}>
                PIN<span className="ml-0.5 text-bad">*</span>
              </Label>
              <PincodeField
                name="consigneePincode"
                value={consigneePin}
                onValueChange={(next) => {
                  setConsigneePin(next);
                  // A stale verdict must not outlive the code it described.
                  if (next.length < 6) setDestination(null);
                }}
                onResolved={setDestination}
                required
                error={error("consigneePincode")}
              />
            </div>
            <Field label="GSTIN" htmlFor={`${formId}-cneeGstin`}>
              <Input id={`${formId}-cneeGstin`} name="consigneeGstin" className="font-mono uppercase" />
            </Field>
          </div>

          <Field label="Landmark" htmlFor={`${formId}-landmark`}>
            <Input id={`${formId}-landmark`} name="consigneeLandmark" />
          </Field>
        </Section>
      </div>

      <Section
        title="Goods"
        description="Dimensions are per package. They decide volumetric weight, which is what bills when goods are light and bulky."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Packages" htmlFor={`${formId}-count`} required error={error("packageCount")}>
            <Input
              id={`${formId}-count`}
              name="packageCount"
              type="number"
              min={1}
              value={packageCount}
              onChange={(e) => setPackageCount(e.target.value)}
              required
            />
          </Field>
          <Field label="Package type" htmlFor={`${formId}-pkgType`}>
            <select id={`${formId}-pkgType`} name="packageTypeId" className={selectClass}>
              <option value="">—</option>
              {packageTypes.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Actual weight (kg)" htmlFor={`${formId}-weight`} required error={error("actualWeight")}>
            <Input
              id={`${formId}-weight`}
              name="actualWeight"
              type="number"
              step="0.001"
              min={0}
              value={actualWeight}
              onChange={(e) => setActualWeight(e.target.value)}
              required
            />
          </Field>
          <Field label="Declared value (₹)" htmlFor={`${formId}-value`} help="Sets the claim ceiling.">
            <Input id={`${formId}-value`} name="declaredValue" type="number" step="0.01" min={0} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Length (cm)" htmlFor={`${formId}-l`}>
            <Input id={`${formId}-l`} type="number" min={0} value={dimensions.l}
              onChange={(e) => setDimensions((d) => ({ ...d, l: e.target.value }))} />
          </Field>
          <Field label="Breadth (cm)" htmlFor={`${formId}-b`}>
            <Input id={`${formId}-b`} type="number" min={0} value={dimensions.b}
              onChange={(e) => setDimensions((d) => ({ ...d, b: e.target.value }))} />
          </Field>
          <Field label="Height (cm)" htmlFor={`${formId}-h`}>
            <Input id={`${formId}-h`} type="number" min={0} value={dimensions.h}
              onChange={(e) => setDimensions((d) => ({ ...d, h: e.target.value }))} />
          </Field>

          <div className="flex flex-col justify-end gap-1 rounded-md border bg-muted/50 px-3 py-2">
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              Chargeable weight
            </p>
            <p className="text-lg font-semibold tabular">
              {weights.chargeable.toFixed(2)} kg
            </p>
            <p className="text-[0.65rem] text-muted-foreground">
              {weights.volumetric > 0
                ? `volumetric ${weights.volumetric.toFixed(2)} @ ÷${weights.divisor} — billing on ${weights.basis}`
                : "enter dimensions for volumetric"}
            </p>
          </div>
        </div>

        <Field label="Goods description" htmlFor={`${formId}-goods`} required error={error("goodsDescription")}>
          <Input id={`${formId}-goods`} name="goodsDescription" placeholder="Auto components — 3 cartons" required />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Special instructions" htmlFor={`${formId}-instructions`}>
            <Textarea id={`${formId}-instructions`} name="specialInstructions" rows={2} />
          </Field>

          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={`${formId}-fragile`} className="cursor-pointer">Fragile</Label>
                <p className="text-xs text-muted-foreground">Flags it on the label and the manifest.</p>
              </div>
              <input type="hidden" name="isFragile" value="false" />
              <Switch id={`${formId}-fragile`} name="isFragile" value="true" />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={`${formId}-pickup`} className="cursor-pointer">Needs pickup</Label>
                <p className="text-xs text-muted-foreground">Off means the consignor is delivering to the branch.</p>
              </div>
              <input type="hidden" name="pickupRequired" value="false" />
              <Switch id={`${formId}-pickup`} name="pickupRequired" value="true" defaultChecked />
            </div>
          </div>
        </div>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Charges"
          description="Entered by hand in this phase. Rate cards price these automatically from Phase 6."
        >
          <div className="flex flex-col gap-2">
            {chargeTypes.map((charge) => (
              <div key={charge.id} className="flex items-center gap-3">
                <Label htmlFor={`${formId}-charge-${charge.id}`} className="flex-1 text-sm font-normal">
                  {charge.name}
                  {charge.taxPercent ? (
                    <span className="ml-1.5 font-mono text-[0.6rem] text-muted-foreground">
                      +{charge.taxPercent}%
                    </span>
                  ) : null}
                </Label>
                <Input
                  id={`${formId}-charge-${charge.id}`}
                  name={`charge:${charge.id}`}
                  type="number"
                  step="0.01"
                  min={0}
                  placeholder="0.00"
                  value={charges[charge.id] ?? ""}
                  onChange={(e) =>
                    setCharges((c) => ({ ...c, [charge.id]: e.target.value }))
                  }
                  className="w-32 text-right font-mono"
                />
              </div>
            ))}
          </div>

          <dl className="flex flex-col gap-1.5 border-t pt-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Charges</dt>
              <dd className="tabular">₹{chargeTotal.toFixed(2)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Tax</dt>
              <dd className="tabular">₹{taxTotal.toFixed(2)}</dd>
            </div>
            <div className="flex justify-between font-semibold">
              <dt>Total</dt>
              <dd className="tabular">₹{(chargeTotal + taxTotal).toFixed(2)}</dd>
            </div>
          </dl>
        </Section>

        <Section title="Payment and references">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Payment type" htmlFor={`${formId}-payment`} required error={error("paymentType")}>
              <select
                id={`${formId}-payment`}
                name="paymentType"
                value={paymentType}
                onChange={(e) => setPaymentType(e.target.value)}
                className={selectClass}
                required
              >
                <option value="PAID">Paid — consignor pays now</option>
                <option value="TO_PAY" disabled={service && !service.allowsToPay}>
                  To-Pay — consignee pays freight
                </option>
                <option value="TBB">TBB — billed to account</option>
                <option value="COD" disabled={service && !service.allowsCod}>
                  COD — collect on delivery
                </option>
              </select>
            </Field>

            {paymentType === "COD" && (
              <Field label="COD amount (₹)" htmlFor={`${formId}-cod`} required error={error("codAmount")}>
                <Input id={`${formId}-cod`} name="codAmount" type="number" step="0.01" min={0} required />
              </Field>
            )}

            <Field label="Customer reference" htmlFor={`${formId}-ref`} help="Their PO or order number.">
              <Input id={`${formId}-ref`} name="customerReference" />
            </Field>
            <Field label="E-way bill" htmlFor={`${formId}-eway`} help="Part-B updates at each transshipment.">
              <Input id={`${formId}-eway`} name="ewayBillNumber" className="font-mono" />
            </Field>
            <Field label="Invoice number" htmlFor={`${formId}-inv`}>
              <Input id={`${formId}-inv`} name="invoiceNumber" />
            </Field>
            <Field label="Invoice value (₹)" htmlFor={`${formId}-invval`}>
              <Input id={`${formId}-invval`} name="invoiceValue" type="number" step="0.01" min={0} />
            </Field>
          </div>

          <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={`${formId}-rcm`} className="cursor-pointer">Reverse charge</Label>
              <p className="text-xs text-muted-foreground">
                GTA supplies usually are — the recipient pays the tax, and the
                invoice must say so.
              </p>
            </div>
            <input type="hidden" name="isReverseCharge" value="false" />
            <Switch id={`${formId}-rcm`} name="isReverseCharge" value="true" />
          </div>
        </Section>
      </div>

      <div className="sticky bottom-4 flex flex-col gap-3 rounded-lg border bg-card px-4 py-3 shadow-lg">
        {/*
          Serviceability is decided by the server, which is the real gate.
          Surfacing the verdict here as well means a clerk never fills in
          the whole form only to be told at the end that the destination is
          outside the network.
        */}
        {undeliverable && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
          >
            <XCircle className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>{consigneePin}</strong> is not in the network, so this
              booking cannot be made. Change the destination PIN, or add it
              under Network → Pincodes.
            </span>
          </p>
        )}

        {needsOverride && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
          >
            <XCircle className="mt-0.5 size-4 shrink-0" />
            <span>
              Delivery to <strong>{destinationAnswer?.city ?? consigneePin}</strong>{" "}
              is suspended. Only someone with the serviceability override
              permission can book to it.
            </span>
          </p>
        )}

        {isOda && (
          <p className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-muted px-3 py-2 text-sm text-warn">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>{destinationAnswer?.city}</strong> is out of delivery
              area. An ODA charge applies and transit will take longer — tell
              the consignor before you book.
            </span>
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <p className="text-sm">
              <span className="font-semibold tabular">{weights.chargeable.toFixed(2)} kg</span>{" "}
              chargeable ·{" "}
              <span className="font-semibold tabular">
                ₹{(chargeTotal + taxTotal).toFixed(2)}
              </span>{" "}
              total
            </p>
            <p className="text-xs text-muted-foreground">
              {customer ? `Booking for ${customer.name}` : "Walk-in booking"}
            </p>
          </div>

          <Button type="submit" size="lg" disabled={pending || undeliverable}>
            {pending ? <Loader2 className="animate-spin" /> : <Truck />}
            Book shipment
          </Button>
        </div>
      </div>
    </form>
  );
}
