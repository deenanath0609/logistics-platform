"use client";

import { useId, useState, useTransition } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { DocumentKind } from "@/generated/prisma/client";
import { DOCUMENT_LABELS, MANDATORY_BY_DEFAULT } from "@/lib/fleet/documents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import type { ActionState } from "@/server/services/master-crud";

const EMPTY: ActionState = {};

export type DocumentRecord = {
  id: string;
  kind: DocumentKind;
  documentNumber: string | null;
  /** yyyy-MM-dd, ready for a date input. */
  issuedOn: string | null;
  expiresOn: string | null;
  isMandatory: boolean;
  notes?: string | null;
};

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-bad">{message}</p>;
}

/**
 * Add or amend one document on a vehicle or a driver.
 *
 * Bespoke rather than a `MasterFormDialog` because the owning record has to
 * travel with the form as a hidden field — putting it through the generic
 * dialog would mean rendering "vehicleId" as a labelled text box, which is
 * the sort of thing that ends up on a training slide.
 *
 * The mandatory switch defaults from the document kind: insurance and
 * fitness arrive ticked because a checkpoint asks for them, a state permit
 * does not because a vehicle that never leaves the state does not carry one.
 */
export function DocumentFormDialog({
  mode,
  subjectField,
  subjectId,
  subjectLabel,
  kinds,
  action,
  document,
  showNotes = false,
}: {
  mode: "create" | "edit";
  subjectField: "vehicleId" | "driverId";
  subjectId: string;
  subjectLabel: string;
  kinds: readonly DocumentKind[];
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  document?: DocumentRecord;
  showNotes?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ActionState>(EMPTY);
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<DocumentKind>(document?.kind ?? kinds[0]);
  const [mandatory, setMandatory] = useState(
    document?.isMandatory ?? MANDATORY_BY_DEFAULT.has(kinds[0]),
  );
  const formId = useId();

  const creating = mode === "create";

  function submit(formData: FormData) {
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
    if (next) {
      setState(EMPTY);
      setKind(document?.kind ?? kinds[0]);
      setMandatory(document?.isMandatory ?? MANDATORY_BY_DEFAULT.has(kinds[0]));
    }
    setOpen(next);
  }

  function handleKindChange(next: DocumentKind) {
    setKind(next);
    // Only re-derive the default while adding; on an edit the recorded
    // answer is a decision somebody made and must not be silently undone.
    if (creating) setMandatory(MANDATORY_BY_DEFAULT.has(next));
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant={creating ? "default" : "ghost"}
            size={creating ? "sm" : "icon-sm"}
            title={
              creating
                ? undefined
                : `Edit ${DOCUMENT_LABELS[document?.kind ?? "OTHER"]}`
            }
          />
        }
      >
        {creating ? <Plus /> : <Pencil />}
        {creating ? (
          "Add document"
        ) : (
          <span className="sr-only">
            Edit {DOCUMENT_LABELS[document?.kind ?? "OTHER"]}
          </span>
        )}
      </DialogTrigger>

      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {creating ? "Add document" : `Edit ${DOCUMENT_LABELS[kind]}`}
          </DialogTitle>
          <DialogDescription>
            For {subjectLabel}. A mandatory document that has expired stops
            this being assigned to a trip, so the expiry date is the field
            that matters most here.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} action={submit} className="flex flex-col gap-4">
          <input type="hidden" name={subjectField} value={subjectId} />
          {document?.id ? (
            <input type="hidden" name="id" value={document.id} />
          ) : null}

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor={`${formId}-kind`}>
                Document<span className="ml-0.5 text-bad">*</span>
              </Label>
              <select
                id={`${formId}-kind`}
                name="kind"
                value={kind}
                onChange={(event) =>
                  handleKindChange(event.target.value as DocumentKind)
                }
                aria-invalid={Boolean(state.fieldErrors?.kind)}
                className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {kinds.map((option) => (
                  <option key={option} value={option}>
                    {DOCUMENT_LABELS[option]}
                  </option>
                ))}
              </select>
              <FieldError message={state.fieldErrors?.kind} />
            </div>

            <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor={`${formId}-number`}>Document number</Label>
              <Input
                id={`${formId}-number`}
                name="documentNumber"
                className="font-mono"
                defaultValue={document?.documentNumber ?? ""}
                aria-invalid={Boolean(state.fieldErrors?.documentNumber)}
              />
              <FieldError message={state.fieldErrors?.documentNumber} />
            </div>

            <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor={`${formId}-issued`}>Issued on</Label>
              <Input
                id={`${formId}-issued`}
                name="issuedOn"
                type="date"
                defaultValue={document?.issuedOn ?? ""}
                aria-invalid={Boolean(state.fieldErrors?.issuedOn)}
              />
              <FieldError message={state.fieldErrors?.issuedOn} />
            </div>

            <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <Label htmlFor={`${formId}-expires`}>Expires on</Label>
              <Input
                id={`${formId}-expires`}
                name="expiresOn"
                type="date"
                defaultValue={document?.expiresOn ?? ""}
                aria-invalid={Boolean(state.fieldErrors?.expiresOn)}
              />
              <FieldError message={state.fieldErrors?.expiresOn} />
              <p className="text-xs text-muted-foreground">
                Leave blank only for paperwork that genuinely never expires.
              </p>
            </div>

            {showNotes && (
              <div className="col-span-2 flex flex-col gap-1.5">
                <Label htmlFor={`${formId}-notes`}>Notes</Label>
                <Textarea
                  id={`${formId}-notes`}
                  name="notes"
                  rows={2}
                  defaultValue={document?.notes ?? ""}
                />
              </div>
            )}

            <div className="col-span-2 flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={`${formId}-mandatory`} className="cursor-pointer">
                  Mandatory
                </Label>
                <p className="text-xs text-muted-foreground">
                  When this expires, assignment is blocked. Untick for
                  paperwork that only warns.
                </p>
              </div>
              <input type="hidden" name="isMandatory" value="false" />
              <Switch
                id={`${formId}-mandatory`}
                name="isMandatory"
                value="true"
                checked={mandatory}
                onCheckedChange={(checked) => setMandatory(Boolean(checked))}
              />
            </div>
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
            {creating ? "Add document" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Removing a document is a real delete, unlike a master record.
 *
 * A document row is a copy of a piece of paper, not a historical fact other
 * records point at — a wrongly-typed insurance entry left deactivated on
 * the vehicle would keep reading as a compliance problem forever. The
 * removal is still audited.
 */
export function DeleteDocumentButton({
  documentId,
  subjectField,
  subjectId,
  label,
  action,
}: {
  documentId: string;
  subjectField: "vehicleId" | "driverId";
  subjectId: string;
  label: string;
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const formId = useId();

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await action(EMPTY, formData);
      if (result.ok) {
        toast.success(result.message ?? "Removed.");
        setOpen(false);
      } else {
        toast.error(result.error ?? "Could not remove that.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="icon-sm" title={`Remove ${label}`} />
        }
      >
        <Trash2 />
        <span className="sr-only">Remove {label}</span>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {label}?</DialogTitle>
          <DialogDescription>
            The record goes for good. If the document was merely renewed,
            edit the dates instead so the history stays on one row.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} action={submit}>
          <input type="hidden" name="id" value={documentId} />
          <input type="hidden" name={subjectField} value={subjectId} />
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
            variant="destructive"
            disabled={pending}
          >
            {pending && <Loader2 className="animate-spin" />}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
