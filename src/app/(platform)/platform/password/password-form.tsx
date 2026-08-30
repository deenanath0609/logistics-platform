"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import {
  Field,
  FormAlert,
  SubmitButton,
  IDLE_FORM,
} from "@/components/platform/form-bits";
import { changeOperatorPassword } from "./actions";

export function OperatorPasswordForm({ minLength }: { minLength: number }) {
  const [state, action] = useActionState(changeOperatorPassword, IDLE_FORM);

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field label="Current password" htmlFor="currentPassword">
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>

      <Field
        label="New password"
        htmlFor="newPassword"
        hint={`At least ${minLength} characters.`}
      >
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          required
        />
      </Field>

      <Field label="Repeat new password" htmlFor="confirmPassword">
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          required
        />
      </Field>

      <FormAlert state={state} />

      <SubmitButton className="mt-1">Change password</SubmitButton>
    </form>
  );
}
