"use client";

import { useActionState, useId } from "react";
import { Loader2, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createWebhookSubscription, type HookState } from "../actions";
import { SecretReveal } from "../secret-reveal";

const IDLE: HookState = {};

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export type CustomerChoice = { id: string; label: string };

export function SubscriptionForm({
  customers,
  suggestedEvents,
}: {
  customers: CustomerChoice[];
  suggestedEvents: string[];
}) {
  const [state, action, pending] = useActionState(createWebhookSubscription, IDLE);
  const formId = useId();

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-name`}>
          Name<span className="ml-0.5 text-bad">*</span>
        </Label>
        <Input
          id={`${formId}-name`}
          name="name"
          placeholder="Sharma Distributors ERP"
          aria-invalid={Boolean(state.fieldErrors?.name)}
          required
        />
        {state.fieldErrors?.name && (
          <p className="text-xs text-bad">{state.fieldErrors.name}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-url`}>
          Endpoint<span className="ml-0.5 text-bad">*</span>
        </Label>
        <Input
          id={`${formId}-url`}
          name="url"
          type="url"
          placeholder="https://erp.sharmadist.in/hooks/city-logistics"
          aria-invalid={Boolean(state.fieldErrors?.url)}
          required
        />
        {state.fieldErrors?.url ? (
          <p className="text-xs text-bad">{state.fieldErrors.url}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            HTTPS only, and not an address inside our own network.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-events`}>
          Events<span className="ml-0.5 text-bad">*</span>
        </Label>
        <Input
          id={`${formId}-events`}
          name="events"
          defaultValue="shipment.*"
          placeholder="shipment.delivered, pickup.completed"
        />
        <p className="text-xs text-muted-foreground">
          Comma separated. <code className="font-mono">shipment.*</code> takes the
          family, <code className="font-mono">*</code> takes everything.
        </p>
        <p className="flex flex-wrap gap-1 pt-1">
          {suggestedEvents.map((event) => (
            <span
              key={event}
              className="rounded-full bg-muted px-2 py-0.5 font-mono text-[0.65rem] text-muted-foreground"
            >
              {event}
            </span>
          ))}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-customer`}>Tie to a customer</Label>
        <select
          id={`${formId}-customer`}
          name="customerId"
          defaultValue=""
          className={selectClass}
        >
          <option value="">Not tied — every consignment</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          A tied subscription only hears about that customer&rsquo;s
          consignments.
        </p>
      </div>

      {state.error && (
        <p className="rounded-lg border border-bad/30 bg-bad-muted px-3 py-2 text-sm text-bad">
          {state.error}
        </p>
      )}

      {state.secret && (
        <SecretReveal
          label={`Signing secret for ${state.secretFor}`}
          secret={state.secret}
          hint="Every delivery is signed HMAC-SHA256 over `<timestamp>.<raw body>` and sent as X-CL-Signature, with the timestamp in X-CL-Timestamp. Verify both, or a captured request can be replayed."
        />
      )}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Webhook />}
          Subscribe
        </Button>
      </div>
    </form>
  );
}
