"use client";

import { useState, useTransition } from "react";
import {
  Loader2,
  Check,
  Ban,
  FileMinus,
  FilePlus,
  ShieldCheck,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { FinanceActionState } from "@/app/(ops)/finance/action-state";

/**
 * A sensitive action that will not proceed without a reason.
 *
 * Approving an invoice, cancelling one, approving a settlement — each is
 * audited with the words the person typed, so the dialog demands them
 * rather than accepting a click. The server action refuses an empty reason
 * too; this is the courtesy, not the control.
 *
 * Icons are named, not passed: every call site is a server component and a
 * Lucide component cannot cross the RSC boundary.
 */

const ICONS = {
  approve: Check,
  cancel: Ban,
  credit: FileMinus,
  debit: FilePlus,
  shield: ShieldCheck,
  send: Send,
} as const;

export type ReasonActionField = {
  name: string;
  label: string;
  type?: "text" | "number" | "date";
  step?: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  defaultValue?: string;
};

export function ReasonAction({
  id,
  idField = "id",
  title,
  description,
  reasonLabel = "Reason",
  reasonHelp,
  reasonPlaceholder,
  confirmLabel,
  icon,
  variant = "default",
  size = "sm",
  destructive = false,
  fields = [],
  hidden = {},
  action,
}: {
  id: string;
  idField?: string;
  title: string;
  description?: string;
  reasonLabel?: string;
  reasonHelp?: string;
  reasonPlaceholder?: string;
  confirmLabel: string;
  icon?: keyof typeof ICONS;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  size?: "default" | "sm" | "xs";
  destructive?: boolean;
  /** Extra inputs collected alongside the reason, e.g. a credit amount. */
  fields?: ReasonActionField[];
  hidden?: Record<string, string>;
  action: (
    prev: FinanceActionState,
    formData: FormData,
  ) => Promise<FinanceActionState>;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FinanceActionState>({});
  const [pending, startTransition] = useTransition();

  const Icon = icon ? ICONS[icon] : null;

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await action({}, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Done.");
        setOpen(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setState({});
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button variant={destructive ? "destructive" : variant} size={size} />
        }
      >
        {Icon ? <Icon /> : null}
        {confirmLabel}
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <form action={submit} className="flex flex-col gap-4">
          <input type="hidden" name={idField} value={id} />
          {Object.entries(hidden).map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value} />
          ))}

          {fields.map((field) => (
            <div key={field.name} className="flex flex-col gap-1.5">
              <Label htmlFor={`ra-${id}-${field.name}`}>
                {field.label}
                {field.required && <span className="ml-0.5 text-bad">*</span>}
              </Label>
              <Input
                id={`ra-${id}-${field.name}`}
                name={field.name}
                type={field.type ?? "text"}
                step={field.step}
                placeholder={field.placeholder}
                defaultValue={field.defaultValue}
                aria-invalid={Boolean(state.fieldErrors?.[field.name])}
              />
              {state.fieldErrors?.[field.name] ? (
                <p className="text-xs text-bad">{state.fieldErrors[field.name]}</p>
              ) : (
                field.help && (
                  <p className="text-xs text-muted-foreground">{field.help}</p>
                )
              )}
            </div>
          ))}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`ra-${id}-reason`}>
              {reasonLabel}
              <span className="ml-0.5 text-bad">*</span>
            </Label>
            <Textarea
              id={`ra-${id}-reason`}
              name="reason"
              rows={3}
              required
              placeholder={reasonPlaceholder ?? "Why, in words an auditor will read."}
              aria-invalid={Boolean(state.fieldErrors?.reason)}
            />
            <p className="text-xs text-muted-foreground">
              {reasonHelp ??
                "This is written to the audit trail against your name and cannot be edited later."}
            </p>
          </div>

          {state.error && (
            <p
              role="alert"
              className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
            >
              {state.error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={destructive ? "destructive" : "default"}
              disabled={pending}
            >
              {pending && <Loader2 className="animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
