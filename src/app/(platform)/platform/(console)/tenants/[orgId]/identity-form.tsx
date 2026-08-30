"use client";

import { useActionState, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Field,
  FormAlert,
  IDLE_FORM,
  SubmitButton,
} from "@/components/platform/form-bits";
import { saveIdentity } from "./actions";

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

/**
 * Where a carrier lives and what they pay for.
 *
 * The host preview updates as it is typed, because a subdomain is not an
 * identifier — it is the address printed on a consignee's tracking link,
 * and seeing it assembled is the difference between "acme" and
 * "acme.platform.com" meaning anything to the person changing it.
 */
export function TenantIdentityForm({
  orgId,
  rootDomain,
  subdomain,
  customDomain,
  planId,
  plans,
  canWrite,
}: {
  orgId: string;
  rootDomain: string;
  subdomain: string;
  customDomain: string | null;
  planId: string | null;
  plans: Array<{ id: string; code: string; name: string }>;
  canWrite: boolean;
}) {
  const [state, action] = useActionState(saveIdentity.bind(null, orgId), IDLE_FORM);
  const [draft, setDraft] = useState(subdomain);

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        label="Subdomain"
        htmlFor="subdomain"
        hint={`Serves ${draft || "…"}.${rootDomain}. Reserved labels, malformed labels and labels another carrier already holds are refused.`}
      >
        <Input
          id="subdomain"
          name="subdomain"
          defaultValue={subdomain}
          onChange={(event) => setDraft(event.target.value.trim().toLowerCase())}
          disabled={!canWrite}
          required
        />
      </Field>

      <Field
        label="Custom domain"
        htmlFor="customDomain"
        hint="A hostname the carrier owns, e.g. track.acmelogistics.com. Needs DNS and a certificate before it resolves; leave blank until both are in place."
      >
        <Input
          id="customDomain"
          name="customDomain"
          defaultValue={customDomain ?? ""}
          placeholder="—"
          disabled={!canWrite}
        />
      </Field>

      <Field label="Plan" htmlFor="planId">
        <select
          id="planId"
          name="planId"
          defaultValue={planId ?? ""}
          disabled={!canWrite}
          className={SELECT_CLASS}
        >
          <option value="">No plan</option>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name} ({plan.code})
            </option>
          ))}
        </select>
      </Field>

      <FormAlert state={state} />

      {canWrite && <SubmitButton className="self-start">Save routing</SubmitButton>}
    </form>
  );
}
