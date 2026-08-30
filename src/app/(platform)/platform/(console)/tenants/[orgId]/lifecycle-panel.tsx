"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { FormAlert, IDLE_FORM } from "@/components/platform/form-bits";
import type { TenantStatus } from "@/generated/prisma/client";
import { runLifecycle } from "./actions";

/**
 * One form, three submit buttons.
 *
 * The button carries the verb as its own `name`/`value`, so the reason
 * typed above it travels with whichever action was chosen. Three separate
 * forms would each need their own copy of the reason field, and a reason
 * typed into the wrong one of three identical boxes is exactly the kind of
 * mistake that ends up in an audit log for ever.
 */
function LifecycleButton({
  action,
  label,
  variant,
  disabled,
  confirmText,
}: {
  action: string;
  label: string;
  variant?: "default" | "outline" | "destructive";
  disabled?: boolean;
  confirmText?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      name="action"
      value={action}
      variant={variant}
      disabled={disabled || pending}
      onClick={(event) => {
        // Closing refuses sign-in entirely and ends every open support
        // session. Worth one deliberate keystroke.
        if (confirmText && !window.confirm(confirmText)) event.preventDefault();
      }}
    >
      {pending && <Loader2 className="animate-spin" />}
      {label}
    </Button>
  );
}

export function TenantLifecyclePanel({
  orgId,
  name,
  status,
  suspendReason,
  canWrite,
}: {
  orgId: string;
  name: string;
  status: TenantStatus;
  suspendReason: string | null;
  canWrite: boolean;
}) {
  const [state, action] = useActionState(
    runLifecycle.bind(null, orgId),
    IDLE_FORM,
  );

  if (!canWrite) {
    return (
      <p className="text-sm text-muted-foreground">
        Your role cannot change a tenant&rsquo;s status.
        {suspendReason && (
          <>
            {" "}
            Current reason on file: <em>{suspendReason}</em>
          </>
        )}
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="reason">Reason</Label>
        <Textarea
          id="reason"
          name="reason"
          rows={2}
          defaultValue={suspendReason ?? ""}
          placeholder="Required to suspend or close — a sentence, and a ticket or invoice number."
        />
        <p className="text-xs text-muted-foreground">
          Suspending leaves {name} reachable but read-only, so their team can
          still read their own consignment history while a dispute is settled.
          Closing refuses sign-in outright and ends any open support session.
          Data is retained either way.
        </p>
      </div>

      <FormAlert state={state} />

      <div className="flex flex-wrap gap-2">
        <LifecycleButton
          action="activate"
          label="Activate"
          disabled={status === "ACTIVE"}
        />
        <LifecycleButton
          action="suspend"
          label="Suspend"
          variant="outline"
          disabled={status === "SUSPENDED"}
        />
        <LifecycleButton
          action="close"
          label="Close"
          variant="destructive"
          disabled={status === "CLOSED"}
          confirmText={`Close ${name}? Nobody there will be able to sign in.`}
        />
      </div>
    </form>
  );
}
