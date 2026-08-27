"use client";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Shared form furniture for the portal's client forms. */

export type SelectOption = { value: string; label: string };

/** Matches the plain `<select>` used across the operations forms. */
export const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive";

export function Field({
  label,
  htmlFor,
  required,
  error,
  help,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  error?: string;
  help?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="ml-0.5 text-bad">*</span>}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-bad">{error}</p>
      ) : help ? (
        <p className="text-xs text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
    >
      {message}
    </p>
  );
}
