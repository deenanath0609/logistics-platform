"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Pencil, Trash2, Copy, FilePlus2, Fuel } from "lucide-react";
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
import { isoDate } from "./format";
import type { FinanceActionState } from "@/app/(ops)/finance/action-state";

/**
 * The form dialog the finance screens use.
 *
 * Close cousin of `MasterFormDialog`, with two differences that matter
 * here: hidden context values (a version id, a card id) travel with the
 * form, and a successful action can navigate — creating a rate card ought
 * to land you on it.
 *
 * Icons are named, never passed: every caller is a server component.
 */

const ICONS = {
  plus: Plus,
  pencil: Pencil,
  trash: Trash2,
  copy: Copy,
  version: FilePlus2,
  fuel: Fuel,
} as const;

export type EntityField =
  | {
      type: "text" | "number" | "date";
      name: string;
      label: string;
      required?: boolean;
      placeholder?: string;
      help?: string;
      half?: boolean;
      mono?: boolean;
      step?: string;
      defaultValue?: string;
    }
  | {
      type: "textarea";
      name: string;
      label: string;
      required?: boolean;
      placeholder?: string;
      help?: string;
      defaultValue?: string;
    }
  | {
      type: "select";
      name: string;
      label: string;
      required?: boolean;
      help?: string;
      half?: boolean;
      placeholder?: string;
      options: Array<{ value: string; label: string }>;
      defaultValue?: string;
    }
  | {
      type: "switch";
      name: string;
      label: string;
      help?: string;
      defaultChecked?: boolean;
    };

export type EntityTrigger = {
  label: string;
  icon?: keyof typeof ICONS;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  size?: "default" | "sm" | "xs" | "icon-sm" | "icon-xs";
  iconOnly?: boolean;
  disabled?: boolean;
  /** Shown as a tooltip when the trigger is disabled, e.g. a frozen version. */
  disabledReason?: string;
};

function valueOf(record: Record<string, unknown> | undefined, name: string): string {
  const raw = record?.[name];
  if (raw === null || raw === undefined) return "";
  // `isoDate`, not `toISOString()`. This is the same UTC-day defect that was
  // fixed in `format.ts` and missed here: `toISOString().slice(0, 10)` is the
  // *UTC* calendar day, and nothing pins `process.env.TZ`, so on a UTC
  // container every date input prefilled from an existing record read
  // **yesterday** between 00:00 and 05:30 IST. Re-saving the record without
  // touching the date field then moved it back a day — silently, on columns
  // that are `@db.Date` and carry no zone to correct it later.
  if (raw instanceof Date) return isoDate(raw);
  return String(raw);
}

export function EntityFormDialog({
  title,
  description,
  fields,
  action,
  record,
  hidden = {},
  trigger,
  submitLabel = "Save",
}: {
  title: string;
  description?: string;
  fields: EntityField[];
  action: (
    prev: FinanceActionState,
    formData: FormData,
  ) => Promise<FinanceActionState>;
  record?: Record<string, unknown>;
  /** Context the form must carry, e.g. `{ versionId }`. */
  hidden?: Record<string, string>;
  trigger: EntityTrigger;
  submitLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FinanceActionState>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const formId = useId();

  const Icon = trigger.icon ? ICONS[trigger.icon] : null;

  /**
   * ── `onSubmit`, not `<form action={fn}>` ────────────────────────────────
   *
   * React 19 resets an uncontrolled form once the function passed to
   * `action` resolves — success or failure, it does not ask. A slab has
   * fourteen fields and a charge rule twelve, so one mistyped rate emptied
   * the entire dialog while showing the field error against a box that was
   * now blank. `onSubmit` with `preventDefault` keeps what was typed, which
   * is the whole point of showing a field error at all.
   * ──────────────────────────────────────────────────────────────────────
   */
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await action({}, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Saved.");
        setOpen(false);
        if (result.redirectTo) router.push(result.redirectTo);
      }
    });
  }

  if (trigger.disabled) {
    return (
      <Button
        variant={trigger.variant ?? "default"}
        size={trigger.size ?? "default"}
        disabled
        title={trigger.disabledReason ?? trigger.label}
      >
        {Icon ? <Icon /> : null}
        {trigger.iconOnly ? (
          <span className="sr-only">{trigger.label}</span>
        ) : (
          trigger.label
        )}
      </Button>
    );
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
          <Button
            variant={trigger.variant ?? "default"}
            size={trigger.size ?? "default"}
            title={trigger.iconOnly ? trigger.label : undefined}
          />
        }
      >
        {Icon ? <Icon /> : null}
        {trigger.iconOnly ? (
          <span className="sr-only">{trigger.label}</span>
        ) : (
          trigger.label
        )}
      </DialogTrigger>

      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
          {record?.id ? (
            <input type="hidden" name="id" value={String(record.id)} />
          ) : null}
          {Object.entries(hidden).map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value} />
          ))}

          <div className="grid grid-cols-2 gap-4">
            {fields.map((field) => {
              const id = `${formId}-${field.name}`;
              const error = state.fieldErrors?.[field.name];
              const half = "half" in field && field.half;
              const fallback =
                "defaultValue" in field && field.defaultValue !== undefined
                  ? field.defaultValue
                  : "";

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
                          <p className="text-xs text-muted-foreground">{field.help}</p>
                        )}
                      </div>
                      {/* An unchecked switch posts nothing on its own. */}
                      <input type="hidden" name={field.name} value="false" />
                      <Switch
                        id={id}
                        name={field.name}
                        value="true"
                        defaultChecked={
                          record
                            ? valueOf(record, field.name) === "true"
                            : (field.defaultChecked ?? false)
                        }
                      />
                    </div>
                  ) : (
                    <>
                      <Label htmlFor={id}>
                        {field.label}
                        {"required" in field && field.required && (
                          <span className="ml-0.5 text-bad">*</span>
                        )}
                      </Label>

                      {field.type === "textarea" ? (
                        <Textarea
                          id={id}
                          name={field.name}
                          rows={3}
                          defaultValue={valueOf(record, field.name) || fallback}
                          placeholder={field.placeholder}
                          aria-invalid={Boolean(error)}
                        />
                      ) : field.type === "select" ? (
                        <select
                          id={id}
                          name={field.name}
                          defaultValue={valueOf(record, field.name) || fallback}
                          aria-invalid={Boolean(error)}
                          className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
                        >
                          <option value="">{field.placeholder ?? "Any"}</option>
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
                          defaultValue={valueOf(record, field.name) || fallback}
                          placeholder={field.placeholder}
                          aria-invalid={Boolean(error)}
                          className={cn(field.mono && "font-mono")}
                        />
                      )}

                      {error ? (
                        <p className="text-xs text-bad">{error}</p>
                      ) : (
                        field.help && (
                          <p className="text-xs text-muted-foreground">{field.help}</p>
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

/**
 * A one-click action with a confirmation, for removals.
 *
 * No reason field: deleting a draft slab is not a sensitive act, and
 * demanding prose for it would train people to type "x".
 */
export function ConfirmButton({
  id,
  label,
  title,
  description,
  action,
  icon = "trash",
  disabled = false,
  disabledReason,
}: {
  id: string;
  label: string;
  title: string;
  description?: string;
  action: (
    prev: FinanceActionState,
    formData: FormData,
  ) => Promise<FinanceActionState>;
  icon?: keyof typeof ICONS;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const Icon = ICONS[icon];

  if (disabled) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        disabled
        title={disabledReason ?? label}
      >
        <Icon />
        <span className="sr-only">{label}</span>
      </Button>
    );
  }

  function confirm() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("id", id);
      const result = await action({}, formData);
      if (result.ok) {
        toast.success(result.message ?? "Done.");
        setOpen(false);
      } else {
        toast.error(result.error ?? "Could not do that.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="ghost" size="icon-sm" title={label} />}
      >
        <Icon />
        <span className="sr-only">{label}</span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Keep it
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
