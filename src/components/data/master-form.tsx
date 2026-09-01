"use client";

import { useState, useId, useTransition } from "react";
import { Loader2, Plus, Pencil, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ActionState } from "@/server/services/master-crud";

export type FieldDef =
  | {
      type: "text" | "number" | "date";
      name: string;
      label: string;
      required?: boolean;
      placeholder?: string;
      help?: string;
      /** Halves the field so two sit on one row. */
      half?: boolean;
      mono?: boolean;
      step?: string;
    }
  | {
      type: "textarea";
      name: string;
      label: string;
      required?: boolean;
      placeholder?: string;
      help?: string;
    }
  | {
      type: "select";
      name: string;
      label: string;
      required?: boolean;
      help?: string;
      half?: boolean;
      options: Array<{ value: string; label: string }>;
      placeholder?: string;
    }
  | {
      type: "switch";
      name: string;
      label: string;
      help?: string;
      /**
       * Where the switch starts on a *new* record. Editing always reads the
       * record.
       *
       * It used to be "on" for every switch there is, because `isActive`
       * wants that and nothing else was considered. `isActive` is not the
       * only boolean on these forms: a new PIN code arrived out of delivery
       * area, a new package type arrived fragile, a new tax rate arrived
       * under reverse charge, and a new reason code demanded a photograph
       * and remarks and notified both parties. Each of those is a real
       * operational consequence that nobody chose, on a switch the person
       * filling the form never touched.
       *
       * Left defaulting to `true` so the flags that genuinely mean "on
       * unless you say otherwise" keep their behaviour without every call
       * site in the product restating it; the ones that do not say so.
       */
      defaultOn?: boolean;
    }
  | {
      /**
       * A value the action needs and a person must not retype.
       *
       * `customerId` on the address form was rendered as a text input
       * labelled "customerId", with a cuid in it, next to "Landmark".
       */
      type: "hidden";
      name: string;
    };

const EMPTY: ActionState = {};

function renderIcon(name: keyof typeof ICONS) {
  const Icon = ICONS[name];
  return <Icon />;
}

function valueOf(record: Record<string, unknown> | undefined, name: string) {
  const raw = record?.[name];
  if (raw === null || raw === undefined) return "";
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  return String(raw);
}

/**
 * Icons are named, not passed.
 *
 * Every caller is a server component, and a Lucide icon is a function — RSC
 * cannot serialise it across the boundary. The name is a string, so it can
 * cross; the lookup happens here on the client.
 */
const ICONS = { plus: Plus, pencil: Pencil, settings: Settings2 } as const;

/**
 * The dialog owns its trigger rather than accepting an arbitrary element:
 * Base UI's `render` prop wants a precisely-typed element, and every call
 * site wants one of two buttons anyway — "New …" or a pencil icon.
 */
export type TriggerSpec = {
  label: string;
  icon?: keyof typeof ICONS;
  variant?: "default" | "outline" | "secondary" | "ghost";
  size?: "default" | "sm" | "icon-sm";
  /** Hide the label visually, keeping it for screen readers. */
  iconOnly?: boolean;
};

export function MasterFormDialog({
  title,
  description,
  fields,
  action,
  record,
  trigger,
  submitLabel = "Save",
}: {
  title: string;
  description?: string;
  fields: FieldDef[];
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  record?: Record<string, unknown>;
  trigger: TriggerSpec;
  submitLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ActionState>(EMPTY);
  const [pending, startTransition] = useTransition();
  const formId = useId();

  // Driving this from useTransition rather than useActionState keeps the
  // "close on success" decision at the call site instead of in an effect,
  // which would fire a second render pass every time the action returns.
  //
  // Submitted by hand rather than through `<form action={…}>`: React 19
  // resets an uncontrolled form the moment a form action returns. Every
  // field here is uncontrolled, and this dialog carries eighteen of them on
  // the customer screen — so a mistyped GSTIN used to answer "check the
  // highlighted fields" over a form that had just been emptied, with the
  // highlight pointing at a blank box.
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await action(EMPTY, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Saved.");
        setOpen(false);
      }
    });
  }

  function handleOpenChange(next: boolean) {
    // Clear stale validation errors so reopening starts fresh.
    if (next) setState(EMPTY);
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant={trigger.variant ?? "default"}
            size={trigger.size ?? "default"}
            title={trigger.iconOnly ? trigger.label : undefined}
          />
        }
      >
        {trigger.icon ? renderIcon(trigger.icon) : null}
        {trigger.iconOnly ? (
          <span className="sr-only">{trigger.label}</span>
        ) : (
          trigger.label
        )}
      </DialogTrigger>

      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
          {record?.id ? (
            <input type="hidden" name="id" value={String(record.id)} />
          ) : null}

          <div className="grid grid-cols-2 gap-4">
            {fields.map((field) => {
              const id = `${formId}-${field.name}`;
              const error = state.fieldErrors?.[field.name];
              const half = "half" in field && field.half;

              if (field.type === "hidden") {
                return (
                  <input
                    key={field.name}
                    type="hidden"
                    name={field.name}
                    value={valueOf(record, field.name)}
                  />
                );
              }

              return (
                <div
                  key={field.name}
                  className={cn(
                    "flex flex-col gap-1.5",
                    half ? "col-span-1" : "col-span-2",
                  )}
                >
                  {field.type === "switch" ? (
                    <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
                      <div className="flex flex-col gap-0.5">
                        <Label htmlFor={id} className="cursor-pointer">
                          {field.label}
                        </Label>
                        {field.help && (
                          <p className="text-xs text-muted-foreground">
                            {field.help}
                          </p>
                        )}
                      </div>
                      {/* Hidden input guarantees a value posts when off —
                          an unchecked switch submits nothing on its own. */}
                      <input type="hidden" name={field.name} value="false" />
                      <Switch
                        id={id}
                        name={field.name}
                        value="true"
                        defaultChecked={
                          record
                            ? valueOf(record, field.name) === "true"
                            : (field.defaultOn ?? true)
                        }
                      />
                    </div>
                  ) : (
                    <>
                      <Label htmlFor={id}>
                        {field.label}
                        {field.required && (
                          <span className="ml-0.5 text-bad">*</span>
                        )}
                      </Label>

                      {field.type === "textarea" ? (
                        <Textarea
                          id={id}
                          name={field.name}
                          defaultValue={valueOf(record, field.name)}
                          placeholder={field.placeholder}
                          rows={3}
                          aria-invalid={Boolean(error)}
                        />
                      ) : field.type === "select" ? (
                        <select
                          id={id}
                          name={field.name}
                          defaultValue={valueOf(record, field.name)}
                          aria-invalid={Boolean(error)}
                          className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
                        >
                          <option value="">
                            {field.placeholder ?? "Select…"}
                          </option>
                          {field.options.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          id={id}
                          name={field.name}
                          type={field.type === "date" ? "date" : field.type}
                          step={field.type === "number" ? field.step : undefined}
                          defaultValue={valueOf(record, field.name)}
                          placeholder={field.placeholder}
                          aria-invalid={Boolean(error)}
                          className={cn(field.mono && "font-mono")}
                        />
                      )}

                      {error ? (
                        <p className="text-xs text-bad">{error}</p>
                      ) : (
                        field.help && (
                          <p className="text-xs text-muted-foreground">
                            {field.help}
                          </p>
                        )
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {state.error && (
            <p
              role="alert"
              className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
            >
              {state.error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
