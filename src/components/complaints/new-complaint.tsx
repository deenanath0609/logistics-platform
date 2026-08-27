"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { cn } from "@/lib/utils";
import { formatAge, slaFor } from "@/lib/complaints/sla";
import { CATEGORY_LABEL, PRIORITY_LABEL } from "@/lib/complaints/workflow";
import type {
  ComplaintCategory,
  ComplaintPriority,
} from "@/generated/prisma/client";
import type { ComplaintActionState } from "@/app/(ops)/complaints/actions";

const CATEGORIES: ComplaintCategory[] = [
  "DELAY",
  "DAMAGE",
  "MISSING",
  "WRONG_DELIVERY",
  "BILLING",
  "POD_ISSUE",
  "PICKUP_ISSUE",
  "BEHAVIOUR",
  "OTHER",
];

const PRIORITIES: ComplaintPriority[] = ["LOW", "NORMAL", "HIGH", "CRITICAL"];

const EMPTY: ComplaintActionState = {};

/**
 * Logging a complaint.
 *
 * The SLA the chosen category and priority will impose is shown while the
 * form is being filled, not discovered afterwards on the list. Support
 * staff pick the priority; they should be able to see what they are
 * committing the branch to before they do.
 */
export function NewComplaintDialog({
  action,
  assignees,
  defaultLrNumber,
}: {
  action: (
    prev: ComplaintActionState,
    formData: FormData,
  ) => Promise<ComplaintActionState>;
  assignees: Array<{ id: string; name: string }>;
  defaultLrNumber?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ComplaintActionState>(EMPTY);
  const [pending, startTransition] = useTransition();
  const formId = useId();

  const [category, setCategory] = useState<ComplaintCategory>("DELAY");
  const [priority, setPriority] = useState<ComplaintPriority>("NORMAL");

  const target = useMemo(() => slaFor(category, priority), [category, priority]);

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await action(EMPTY, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Logged.");
        setOpen(false);
        if (result.id) router.push(`/complaints/${result.id}`);
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
      <DialogTrigger render={<Button />}>
        <Plus />
        Log complaint
      </DialogTrigger>

      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Log a complaint</DialogTitle>
          <DialogDescription>
            The response and resolution clocks start the moment this is saved.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} action={submit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-category`}>
                Category<span className="ml-0.5 text-bad">*</span>
              </Label>
              <select
                id={`${formId}-category`}
                name="category"
                value={category}
                onChange={(e) => setCategory(e.target.value as ComplaintCategory)}
                className={SELECT}
              >
                {CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {CATEGORY_LABEL[value]}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-priority`}>Priority</Label>
              <select
                id={`${formId}-priority`}
                name="priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as ComplaintPriority)}
                className={SELECT}
              >
                {PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {PRIORITY_LABEL[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Respond within{" "}
            <span className="font-medium text-foreground">
              {formatAge(target.responseMinutes)}
            </span>
            , resolve within{" "}
            <span className="font-medium text-foreground">
              {formatAge(target.resolutionMinutes)}
            </span>
            .
          </p>

          <Field
            id={`${formId}-lr`}
            label="LR number"
            help="Optional — links the complaint to the consignment and routes it to the delivering branch."
            error={state.fieldErrors?.lrNumber}
          >
            <Input
              id={`${formId}-lr`}
              name="lrNumber"
              defaultValue={defaultLrNumber ?? ""}
              placeholder="CL/DEL/2627/000412"
              className="font-mono"
              aria-invalid={Boolean(state.fieldErrors?.lrNumber)}
            />
          </Field>

          <Field
            id={`${formId}-subject`}
            label="Subject"
            required
            error={state.fieldErrors?.subject}
          >
            <Input
              id={`${formId}-subject`}
              name="subject"
              placeholder="Consignment two days late, customer chasing"
              aria-invalid={Boolean(state.fieldErrors?.subject)}
            />
          </Field>

          <Field
            id={`${formId}-description`}
            label="What happened"
            required
            error={state.fieldErrors?.description}
          >
            <Textarea
              id={`${formId}-description`}
              name="description"
              rows={4}
              placeholder="In the customer's words, with anything they have already been told."
              aria-invalid={Boolean(state.fieldErrors?.description)}
            />
          </Field>

          <Field
            id={`${formId}-assignee`}
            label="Owner"
            help="Leave blank to open it unassigned for the duty manager to route."
          >
            <select id={`${formId}-assignee`} name="assignedToId" className={SELECT}>
              <option value="">Unassigned</option>
              {assignees.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </Field>

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
            Log complaint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SELECT =
  "h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive";

function Field({
  id,
  label,
  required,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  help?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5")}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-0.5 text-bad">*</span>}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-bad">{error}</p>
      ) : (
        help && <p className="text-xs text-muted-foreground">{help}</p>
      )}
    </div>
  );
}
