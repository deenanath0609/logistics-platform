"use client";

import { useActionState, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FormError, selectClass } from "@/components/portal/form";
import {
  raiseComplaint,
  type ComplaintState,
} from "@/app/(portal)/portal/(app)/complaints/actions";

const EMPTY: ComplaintState = {};

export type ComplaintCategoryOption = {
  value: string;
  label: string;
  help: string;
};

export type ComplaintShipmentOption = {
  id: string;
  lrNumber: string;
  toCity: string;
  bookedOn: string;
};

/**
 * Raising a complaint.
 *
 * Built for a phone first — one column, full-width controls, and the
 * consignment picker above the description, because somebody standing next
 * to a damaged carton reaches for the LR number before they reach for
 * words.
 *
 * There is no priority selector. The category carries the urgency and the
 * server decides; see `priorityForCategory`.
 */
export function ComplaintForm({
  categories,
  shipments,
  defaultShipmentId,
}: {
  categories: ComplaintCategoryOption[];
  shipments: ComplaintShipmentOption[];
  defaultShipmentId?: string;
}) {
  const [state, action, pending] = useActionState(raiseComplaint, EMPTY);
  const [category, setCategory] = useState(categories[0]?.value ?? "");

  const help = categories.find((option) => option.value === category)?.help;

  return (
    <form action={action} className="flex flex-col gap-4 rounded-lg border bg-card p-4 sm:p-5">
      <FormError message={state.error} />

      <Field
        label="What is it about?"
        htmlFor="category"
        required
        error={state.fieldErrors?.category}
        help={help}
      >
        <select
          id="category"
          name="category"
          className={selectClass}
          value={category}
          onChange={(event) => setCategory(event.currentTarget.value)}
        >
          {categories.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Which consignment?"
        htmlFor="shipmentId"
        error={state.fieldErrors?.shipmentId}
        help={
          shipments.length === 0
            ? "Nothing booked yet, so leave this blank."
            : "Optional. Attaching it gets your complaint to the right branch straight away."
        }
      >
        <select
          id="shipmentId"
          name="shipmentId"
          className={selectClass}
          defaultValue={defaultShipmentId ?? ""}
        >
          <option value="">Not about a particular consignment</option>
          {shipments.map((shipment) => (
            <option key={shipment.id} value={shipment.id}>
              {shipment.lrNumber} — {shipment.toCity} · {shipment.bookedOn}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="In one line"
        htmlFor="subject"
        required
        error={state.fieldErrors?.subject}
      >
        <Input
          id="subject"
          name="subject"
          maxLength={200}
          placeholder="Two cartons arrived crushed"
          required
        />
      </Field>

      <Field
        label="What happened?"
        htmlFor="description"
        required
        error={state.fieldErrors?.description}
        help="Dates, package numbers and who you spoke to all help. You can add more later."
      >
        <Textarea
          id="description"
          name="description"
          rows={6}
          maxLength={4000}
          required
        />
      </Field>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          You will get an acknowledgement here, and every reply appears in the
          thread.
        </p>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? <Loader2 className="animate-spin" /> : <Send />}
          {pending ? "Sending…" : "Raise complaint"}
        </Button>
      </div>
    </form>
  );
}
