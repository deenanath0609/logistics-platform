"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changeStaffPassword, type StaffPasswordState } from "./actions";

const EMPTY: StaffPasswordState = {};

export function StaffPasswordForm({ forced }: { forced: boolean }) {
  const [state, action, pending] = useActionState(changeStaffPassword, EMPTY);

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        name="current"
        label={forced ? "The password you were given" : "Current password"}
        autoComplete="current-password"
        error={state.fieldErrors?.current}
      />
      <Field
        name="next"
        label="New password"
        autoComplete="new-password"
        error={state.fieldErrors?.next}
        help="At least 8 characters, with a letter and a digit."
      />
      <Field
        name="confirm"
        label="Confirm new password"
        autoComplete="new-password"
        error={state.fieldErrors?.confirm}
      />

      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
        >
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={pending} className="mt-1">
        {pending && <Loader2 className="animate-spin" />}
        Set password
      </Button>
    </form>
  );
}

function Field({
  name,
  label,
  autoComplete,
  error,
  help,
}: {
  name: string;
  label: string;
  autoComplete: string;
  error?: string;
  help?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type="password"
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        required
      />
      {error ? (
        <p className="text-xs text-bad">{error}</p>
      ) : help ? (
        <p className="text-xs text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}
