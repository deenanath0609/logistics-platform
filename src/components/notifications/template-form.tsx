"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { Loader2, Pencil, Plus, TriangleAlert } from "lucide-react";
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
import { segmentsFor } from "@/lib/notifications/channels/mock";
import {
  extractPlaceholders,
  renderSubject,
  renderTemplate,
  validateTemplate,
} from "@/lib/notifications/render";
import {
  TRIGGER_EVENTS,
  sampleVariables,
  variablesForEvent,
} from "@/lib/notifications/variables";
import type { ActionState } from "@/server/services/master-crud";

/**
 * The template editor.
 *
 * A plain master form is not enough here: a template is a small program,
 * and the two ways it goes wrong — a placeholder nothing supplies, and an
 * SMS with no DLT registration — are both invisible until a customer does
 * not receive something. Both are shown live, next to a rendered preview,
 * so the person editing sees the actual message before saving it.
 */

export type TemplateRecord = {
  id: string;
  code: string;
  channel: string;
  eventType: string;
  name: string;
  language: string;
  subject: string | null;
  body: string;
  variables: string[];
  recipientKind: string;
  dltTemplateId: string | null;
  dltSenderId: string | null;
  isActive: boolean;
};

const CHANNELS = [
  { value: "SMS", label: "SMS" },
  { value: "EMAIL", label: "Email" },
  { value: "WHATSAPP", label: "WhatsApp" },
  { value: "PUSH", label: "Push" },
  { value: "IN_APP", label: "In-app" },
];

const RECIPIENTS = [
  { value: "CONSIGNOR", label: "Consignor" },
  { value: "CONSIGNEE", label: "Consignee" },
  { value: "CUSTOMER_USER", label: "Customer portal users" },
  { value: "BRANCH", label: "Destination branch" },
  { value: "STAFF", label: "Staff" },
];

const EMPTY: ActionState = {};

export function TemplateFormDialog({
  action,
  record,
  mode,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  record?: TemplateRecord;
  mode: "create" | "edit";
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ActionState>(EMPTY);
  const [pending, startTransition] = useTransition();
  const formId = useId();

  const [channel, setChannel] = useState(record?.channel ?? "SMS");
  const [eventType, setEventType] = useState(
    record?.eventType ?? TRIGGER_EVENTS[0].value,
  );
  const [subject, setSubject] = useState(record?.subject ?? "");
  const [body, setBody] = useState(record?.body ?? "");
  const [dltTemplateId, setDltTemplateId] = useState(record?.dltTemplateId ?? "");

  const available = useMemo(() => variablesForEvent(eventType), [eventType]);
  const samples = useMemo(() => sampleVariables(eventType), [eventType]);

  // The declared variable list is derived, not typed. Asking an operator to
  // keep a comma-separated list in step with the body by hand guarantees
  // they will not, and the mismatch is exactly what validation is for.
  const declared = useMemo(
    () => [...new Set([...extractPlaceholders(body), ...extractPlaceholders(subject)])],
    [body, subject],
  );

  const known = useMemo(() => new Set(available.map((v) => v.name)), [available]);
  const unsupported = declared.filter((name) => !known.has(name));
  const validation = validateTemplate(body, declared);

  const preview = renderTemplate(body, samples);
  const previewSubject = subject ? renderSubject(subject, samples) : null;
  const segments = channel === "SMS" ? segmentsFor(preview) : null;

  const needsDlt = channel === "SMS" && dltTemplateId.trim().length === 0;

  function submit(formData: FormData) {
    formData.set("variables", declared.join(","));
    startTransition(async () => {
      const result = await action(EMPTY, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Saved.");
        setOpen(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setState(EMPTY);
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant={mode === "create" ? "default" : "ghost"}
            size={mode === "create" ? "default" : "icon-sm"}
            title={mode === "create" ? undefined : `Edit ${record?.code}`}
          />
        }
      >
        {mode === "create" ? <Plus /> : <Pencil />}
        {mode === "create" ? (
          "New template"
        ) : (
          <span className="sr-only">Edit {record?.code}</span>
        )}
      </DialogTrigger>

      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New notification template" : `Edit ${record?.code}`}
          </DialogTitle>
          <DialogDescription>
            Placeholders are written {`{{like_this}}`}. The list of variables
            this trigger supplies is on the right.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} action={submit} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
          {record?.id && <input type="hidden" name="id" value={record.id} />}

          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Code" required>
                <Input
                  name="code"
                  defaultValue={record?.code ?? ""}
                  placeholder="DELIVERED"
                  className="font-mono"
                  aria-invalid={Boolean(state.fieldErrors?.code)}
                />
              </Field>

              <Field label="Channel" required>
                <Select
                  name="channel"
                  value={channel}
                  onChange={setChannel}
                  options={CHANNELS}
                />
              </Field>

              <Field label="Trigger" required className="col-span-2">
                <Select
                  name="eventType"
                  value={eventType}
                  onChange={setEventType}
                  options={TRIGGER_EVENTS}
                />
              </Field>

              <Field label="Name" required className="col-span-2">
                <Input
                  name="name"
                  defaultValue={record?.name ?? ""}
                  placeholder="Delivered — POD link to consignor"
                />
              </Field>

              <Field label="Recipient" required>
                <Select
                  name="recipientKind"
                  defaultValue={record?.recipientKind ?? "CONSIGNOR"}
                  options={RECIPIENTS}
                />
              </Field>

              <Field label="Language" required>
                <Input
                  name="language"
                  defaultValue={record?.language ?? "en"}
                  placeholder="en"
                  className="font-mono"
                />
              </Field>
            </div>

            {channel === "EMAIL" && (
              <Field label="Subject" required>
                <Input
                  name="subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Delivered — {{lrNumber}}"
                />
              </Field>
            )}
            {channel !== "EMAIL" && (
              <input type="hidden" name="subject" value="" />
            )}

            <Field
              label="Body"
              required
              help={
                segments === null
                  ? undefined
                  : `${preview.length} characters · ${segments} SMS segment${segments === 1 ? "" : "s"}`
              }
            >
              <Textarea
                name="body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={7}
                placeholder="{{brandName}}: LR {{lrNumber}} delivered. POD: {{podUrl}}"
                aria-invalid={unsupported.length > 0}
              />
            </Field>

            {channel === "SMS" && (
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="DLT template id"
                  help="From the DLT portal, after this exact text is approved."
                >
                  <Input
                    name="dltTemplateId"
                    value={dltTemplateId}
                    onChange={(e) => setDltTemplateId(e.target.value)}
                    placeholder="1307161234567890123"
                    className="font-mono"
                  />
                </Field>
                <Field label="DLT sender id" help="The six-character header.">
                  <Input
                    name="dltSenderId"
                    defaultValue={record?.dltSenderId ?? ""}
                    placeholder="CTYLOG"
                    className="font-mono uppercase"
                  />
                </Field>
              </div>
            )}
            {channel !== "SMS" && (
              <>
                <input type="hidden" name="dltTemplateId" value="" />
                <input type="hidden" name="dltSenderId" value="" />
              </>
            )}

            <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex flex-col gap-0.5">
                <Label className="cursor-pointer">Active</Label>
                <p className="text-xs text-muted-foreground">
                  Inactive templates are skipped by the dispatcher.
                </p>
              </div>
              <input type="hidden" name="isActive" value="false" />
              <Switch
                name="isActive"
                value="true"
                defaultChecked={record ? record.isActive : true}
              />
            </div>

            {state.error && (
              <p
                role="alert"
                className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
              >
                {state.error}
              </p>
            )}
          </div>

          {/* ── Right rail: what will actually go out ──────────── */}
          <aside className="flex flex-col gap-4 text-sm">
            {needsDlt && (
              <Notice tone="warn" title="No DLT template id">
                Indian operators drop unregistered transactional templates
                without a delivery report — the send looks fine and the
                customer gets nothing. Register this exact text on the DLT
                portal and paste the id in before activating it.
              </Notice>
            )}

            {unsupported.length > 0 && (
              <Notice tone="bad" title="Unknown placeholder">
                <span className="font-mono">{unsupported.join(", ")}</span> is
                not supplied by this trigger. It would go out as literal
                braces.
              </Notice>
            )}

            {validation.unused.length > 0 && (
              <Notice tone="muted" title="Declared but unused">
                <span className="font-mono">{validation.unused.join(", ")}</span>
              </Notice>
            )}

            <section className="flex flex-col gap-1.5">
              <h3 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
                Preview
              </h3>
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
                {previewSubject && (
                  <p className="mb-1.5 border-b pb-1.5 font-medium">
                    {previewSubject}
                  </p>
                )}
                <p className="whitespace-pre-wrap">
                  {preview || (
                    <span className="text-muted-foreground">Nothing yet.</span>
                  )}
                </p>
              </div>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
                Variables for this trigger
              </h3>
              <ul className="flex flex-col gap-1">
                {available.map((variable) => {
                  const used = declared.includes(variable.name);
                  return (
                    <li key={variable.name}>
                      <button
                        type="button"
                        onClick={() => setBody((current) => `${current}{{${variable.name}}}`)}
                        className={cn(
                          "w-full rounded-sm px-1.5 py-1 text-left font-mono text-[0.68rem] transition-colors hover:bg-muted",
                          used ? "text-foreground" : "text-muted-foreground",
                        )}
                        title={variable.description}
                      >
                        {used ? "• " : "  "}
                        {variable.name}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          </aside>
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
          <Button
            type="submit"
            form={formId}
            disabled={pending || unsupported.length > 0}
          >
            {pending && <Loader2 className="animate-spin" />}
            {mode === "create" ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────

function Field({
  label,
  required,
  help,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label>
        {label}
        {required && <span className="ml-0.5 text-bad">*</span>}
      </Label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function Select({
  name,
  value,
  defaultValue,
  onChange,
  options,
}: {
  name: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      name={name}
      value={value}
      defaultValue={defaultValue}
      onChange={(event) => onChange?.(event.target.value)}
      className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warn" | "bad" | "muted";
  title: string;
  children: React.ReactNode;
}) {
  const tones = {
    warn: "border-warn/40 bg-warn-muted text-warn",
    bad: "border-bad/40 bg-bad-muted text-bad",
    muted: "border-border bg-muted text-muted-foreground",
  } as const;

  return (
    <div className={cn("flex flex-col gap-1 rounded-md border px-3 py-2 text-xs", tones[tone])}>
      <p className="flex items-center gap-1.5 font-medium">
        {tone !== "muted" && <TriangleAlert className="size-3.5" />}
        {title}
      </p>
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}
