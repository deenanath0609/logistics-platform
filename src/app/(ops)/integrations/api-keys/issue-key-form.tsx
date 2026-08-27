"use client";

import { useActionState, useId } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { issueApiKey, type KeyIssueState } from "../actions";
import { SecretReveal } from "../secret-reveal";

const IDLE: KeyIssueState = {};

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export type ScopeChoice = { code: string; label: string };
export type CustomerChoice = { id: string; label: string };

export function IssueKeyForm({
  scopes,
  customers,
}: {
  scopes: ScopeChoice[];
  customers: CustomerChoice[];
}) {
  const [state, action, pending] = useActionState(issueApiKey, IDLE);
  const formId = useId();

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-name`}>
          Integration name<span className="ml-0.5 text-bad">*</span>
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

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">
          Scopes<span className="ml-0.5 text-bad">*</span>
        </legend>
        <div className="flex flex-col gap-1.5">
          {scopes.map((scope) => (
            <label
              key={scope.code}
              className="flex items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                name="scopes"
                value={scope.code}
                className="size-3.5 accent-primary"
              />
              <span>{scope.label}</span>
              <code className="font-mono text-[0.7rem] text-muted-foreground">
                {scope.code}
              </code>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          A key can never do more than these, and never more than the person
          issuing it already can.
        </p>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-customer`}>Tie to a customer</Label>
        <select
          id={`${formId}-customer`}
          name="customerId"
          defaultValue=""
          className={selectClass}
        >
          <option value="">Not tied — network-wide</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          A tied key sees only that customer&rsquo;s consignments. Anything else
          answers 404.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-ips`}>IP allowlist</Label>
        <Input
          id={`${formId}-ips`}
          name="ipAllowlist"
          placeholder="203.0.113.0/24, 198.51.100.4"
        />
        <p className="text-xs text-muted-foreground">
          Addresses or CIDR blocks, comma separated. Leave blank to accept the
          key from anywhere.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-expires`}>Expires</Label>
        <Input id={`${formId}-expires`} name="expiresAt" type="date" />
        <p className="text-xs text-muted-foreground">
          Optional. A key with an expiry is one fewer credential to remember to
          retire.
        </p>
      </div>

      {state.error && (
        <p className="rounded-lg border border-bad/30 bg-bad-muted px-3 py-2 text-sm text-bad">
          {state.error}
        </p>
      )}

      {state.issuedKey && (
        <SecretReveal
          label={`API key for ${state.issuedFor}`}
          secret={state.issuedKey}
          hint="Only the digest is stored. This is the one time the key can be read — if it is lost, revoke it and issue another."
        />
      )}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <KeyRound />}
          Issue key
        </Button>
      </div>
    </form>
  );
}
