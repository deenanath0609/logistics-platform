"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import {
  Field,
  FormAlert,
  SubmitButton,
  IDLE_FORM,
} from "@/components/platform/form-bits";
import { signInOperator } from "./actions";

export function OperatorLoginForm({ next }: { next: string }) {
  const [state, action] = useActionState(signInOperator, IDLE_FORM);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />

      <Field label="Operator email" htmlFor="email">
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          placeholder="you@platform.com"
          required
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>

      <FormAlert state={state} />

      <SubmitButton className="mt-1">Sign in</SubmitButton>
    </form>
  );
}
