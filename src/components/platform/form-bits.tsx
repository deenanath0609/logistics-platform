"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * The three pieces every console form repeats.
 *
 * Small on purpose. The console has a dozen forms and they are all the
 * same shape — label, control, hint; a submit that disables itself; one
 * banner that says what went wrong — and thirteen copies of that shape is
 * how they drift apart.
 */

export type ConsoleFormState = {
  ok?: boolean;
  message?: string;
  error?: string;
};

export const IDLE_FORM: ConsoleFormState = {};

export function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Reads the pending state from the enclosing form rather than taking it as
 * a prop, so a form with several buttons cannot get it wrong.
 */
export function SubmitButton({
  children,
  variant,
  className,
}: {
  children: React.ReactNode;
  variant?: "default" | "outline" | "secondary" | "destructive" | "ghost";
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} className={className}>
      {pending && <Loader2 className="animate-spin" />}
      {children}
    </Button>
  );
}

export function FormAlert({ state }: { state: ConsoleFormState }) {
  if (state.error) {
    return (
      <p
        role="alert"
        className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
      >
        {state.error}
      </p>
    );
  }
  if (state.ok && state.message) {
    return (
      <p
        role="status"
        className="rounded-md border border-ok/40 bg-ok-muted px-3 py-2 text-sm text-ok"
      >
        {state.message}
      </p>
    );
  }
  return null;
}
