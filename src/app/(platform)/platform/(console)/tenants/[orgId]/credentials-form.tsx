"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { format, formatDistanceToNow } from "date-fns";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FormAlert,
  IDLE_FORM,
  SubmitButton,
} from "@/components/platform/form-bits";
import {
  CREDENTIAL_SPECS,
  type CredentialKindCode,
} from "@/lib/platform/credential-specs";
import { saveCredential } from "./actions";

/**
 * One carrier's own accounts with the outside services.
 *
 * The screen answers one question before it offers any field: **whose
 * account does this carrier's traffic actually leave on?** That is a fact
 * with a bill, a rate limit and a blast radius attached, and it used to be
 * answerable only by reading `.env` on the server. It is stated in words at
 * the top of every slot.
 *
 * A stored secret is never sent here. The component is given `hasSecret`
 * and a date, and nothing else about it — there is no masked value to
 * un-mask, no "reveal" affordance to protect, and no way for a screenshot of
 * this page in a support ticket to carry a live gateway key.
 */

export type CredentialSlotView = {
  kind: CredentialKindCode;
  source: "tenant" | "platform" | "none";
  hasSecret: boolean;
  settings: Record<string, string>;
  updatedAt: string | null;
  updatedBy: string | null;
  secretChangedAt: string | null;
  platformConfigured: boolean;
};

export function TenantCredentials({
  orgId,
  carrierName,
  slots,
  canWrite,
  keyConfigured,
}: {
  orgId: string;
  carrierName: string;
  slots: CredentialSlotView[];
  canWrite: boolean;
  /** False when CREDENTIALS_KEY is unset, which makes every slot read-only. */
  keyConfigured: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      {!keyConfigured && (
        <p
          role="alert"
          className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
        >
          <strong>CREDENTIALS_KEY is not set on this server.</strong> Secrets
          cannot be stored or read until it is, so every carrier here stays on
          the platform&rsquo;s shared accounts. Existing secrets are not lost —
          they are encrypted under a key this server does not have.
        </p>
      )}

      {slots.map((slot) => (
        <CredentialSlotForm
          key={slot.kind}
          orgId={orgId}
          carrierName={carrierName}
          slot={slot}
          canWrite={canWrite && keyConfigured}
        />
      ))}
    </div>
  );
}

function CredentialSlotForm({
  orgId,
  carrierName,
  slot,
  canWrite,
}: {
  orgId: string;
  carrierName: string;
  slot: CredentialSlotView;
  canWrite: boolean;
}) {
  const spec = CREDENTIAL_SPECS[slot.kind];
  const [state, action] = useActionState(
    saveCredential.bind(null, orgId, slot.kind),
    IDLE_FORM,
  );

  return (
    <form action={action} className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight">{spec.title}</h3>
        <SourceBadge source={slot.source} />
      </div>

      <p className="max-w-prose text-xs text-muted-foreground">
        {spec.description}
      </p>

      <SourceNote slot={slot} carrierName={carrierName} />

      <fieldset disabled={!canWrite} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {spec.fields.map((field) => (
            <Field
              key={field.name}
              label={field.label}
              htmlFor={`${slot.kind}-${field.name}`}
              hint={field.hint}
            >
              <Input
                id={`${slot.kind}-${field.name}`}
                name={field.name}
                type={field.type === "number" ? "number" : "text"}
                inputMode={field.type === "number" ? "numeric" : undefined}
                defaultValue={slot.settings[field.name] ?? ""}
                placeholder={field.placeholder}
              />
            </Field>
          ))}

          <Field
            label={spec.secretLabel}
            htmlFor={`${slot.kind}-secret`}
            hint={
              slot.hasSecret
                ? "A key is on file and is not shown. Leave this empty to keep it; type a new one to replace it."
                : spec.secretHint
            }
          >
            <Input
              id={`${slot.kind}-secret`}
              name="secret"
              type="password"
              // Password managers offer to save and then to autofill this,
              // which on a screen listing four carriers' gateway accounts
              // means quietly pasting one service's key into another's box.
              autoComplete="off"
              defaultValue=""
              placeholder={
                slot.hasSecret ? "Unchanged" : "Not set — using the shared account"
              }
            />
          </Field>
        </div>
      </fieldset>

      <FormAlert state={state} />

      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton>Save {spec.title.toLowerCase()}</SubmitButton>

          {(slot.hasSecret || slot.updatedAt) && (
            <ClearButton
              label="Clear"
              confirmText={
                `Clear ${carrierName}'s ${spec.title.toLowerCase()}?\n\n` +
                `${spec.sharedAccountNote}\n\n` +
                "The stored key is deleted, not archived. Putting it back means having it to hand."
              }
            />
          )}
        </div>
      )}
    </form>
  );
}

/** Whose account, in two words, before any of the detail. */
function SourceBadge({ source }: { source: CredentialSlotView["source"] }) {
  const style =
    source === "tenant"
      ? "border-ok/40 bg-ok-muted text-ok"
      : source === "platform"
        ? "border-warn/40 bg-warn-muted text-warn"
        : "border-bad/40 bg-bad-muted text-bad";

  const label =
    source === "tenant"
      ? "Own account"
      : source === "platform"
        ? "Platform's shared account"
        : "No account anywhere";

  return (
    <span
      className={`rounded-full border px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.13em] ${style}`}
    >
      {label}
    </span>
  );
}

/**
 * The same fact as the badge, said properly.
 *
 * A colour and two words are enough to scan; they are not enough to act on,
 * and the thing being acted on here is which company gets the bill and which
 * companies stop sending when a key is revoked.
 */
function SourceNote({
  slot,
  carrierName,
}: {
  slot: CredentialSlotView;
  carrierName: string;
}) {
  const spec = CREDENTIAL_SPECS[slot.kind];

  if (slot.source === "tenant") {
    return (
      <p className="text-xs text-ok">
        {carrierName} is on their own {spec.title.toLowerCase()} account.
        {slot.secretChangedAt && (
          <>
            {" "}
            Key last replaced{" "}
            {format(new Date(slot.secretChangedAt), "d MMM yyyy 'at' HH:mm")} (
            {formatDistanceToNow(new Date(slot.secretChangedAt), {
              addSuffix: true,
            })}
            )
            {slot.updatedBy ? ` by ${slot.updatedBy}` : ""}.
          </>
        )}
        {!slot.secretChangedAt && slot.updatedAt && (
          <>
            {" "}
            Last changed{" "}
            {format(new Date(slot.updatedAt), "d MMM yyyy 'at' HH:mm")}
            {slot.updatedBy ? ` by ${slot.updatedBy}` : ""}.
          </>
        )}
      </p>
    );
  }

  if (slot.source === "platform") {
    return (
      <p className="text-xs text-warn">
        {spec.sharedAccountNote} Read from{" "}
        <span className="font-mono">{spec.platformEnv.join(", ")}</span> on the
        server.
        {slot.updatedAt && (
          <>
            {" "}
            The settings below are saved but there is no key against them, so
            they are not in use.
          </>
        )}
      </p>
    );
  }

  return (
    <p className="text-xs text-bad">
      Neither {carrierName} nor the platform has an account for this service,
      so sends on it are refused rather than attempted — which is the right
      outcome: an unregistered sender is rejected at the gateway *after* it
      reports success, and would be logged here as delivered.
    </p>
  );
}

/**
 * Clearing is destructive and its consequence is not visible on this screen
 * — the carrier keeps sending, just on somebody else&rsquo;s account — so the
 * confirmation says so in full rather than asking &ldquo;are you sure?&rdquo;.
 */
function ClearButton({
  label,
  confirmText,
}: {
  label: string;
  confirmText: string;
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      name="intent"
      value="clear"
      variant="outline"
      disabled={pending}
      onClick={(event) => {
        if (!window.confirm(confirmText)) event.preventDefault();
      }}
    >
      {pending && <Loader2 className="animate-spin" />}
      {label}
    </Button>
  );
}
