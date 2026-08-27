"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ComplaintStatus } from "@/generated/prisma/client";
import type { Transition } from "@/lib/complaints/workflow";
import type { ComplaintActionState } from "@/app/(ops)/complaints/actions";

/**
 * The workflow buttons.
 *
 * Which transitions exist comes from `workflow.ts` on the server and is
 * passed in as data — the same table the server action checks against, so
 * a button can never offer something the action would then refuse.
 *
 * Picking a transition that needs a note or an owner expands the form
 * rather than opening a dialog: the note is the work, and burying it one
 * click deeper is how complaints get closed with "resolved" as the
 * resolution.
 */
export function WorkflowActions({
  complaintId,
  transitions,
  assignees,
  action,
}: {
  complaintId: string;
  transitions: Transition[];
  assignees: Array<{ id: string; name: string }>;
  action: (
    prev: ComplaintActionState,
    formData: FormData,
  ) => Promise<ComplaintActionState>;
}) {
  const [active, setActive] = useState<Transition | null>(null);
  const [note, setNote] = useState("");
  const [assignedToId, setAssignedToId] = useState("");
  const [pending, startTransition] = useTransition();

  if (transitions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing further to do from here.
      </p>
    );
  }

  function choose(transition: Transition) {
    if (transition.requiresNote || transition.requiresAssignee) {
      setActive((current) => (current?.to === transition.to ? null : transition));
      return;
    }
    submit(transition, "", "");
  }

  function submit(transition: Transition, noteValue: string, assignee: string) {
    const formData = new FormData();
    formData.set("complaintId", complaintId);
    formData.set("to", transition.to satisfies ComplaintStatus);
    formData.set("note", noteValue);
    formData.set("assignedToId", assignee);

    startTransition(async () => {
      const result = await action({}, formData);
      if (result.ok) {
        toast.success(result.message ?? "Updated.");
        setActive(null);
        setNote("");
        setAssignedToId("");
      } else {
        toast.error(result.error ?? "Could not do that.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {transitions.map((transition) => (
          <Button
            key={`${transition.to}-${transition.label}`}
            type="button"
            size="sm"
            variant={active?.label === transition.label ? "default" : "outline"}
            disabled={pending}
            onClick={() => choose(transition)}
            title={transition.describe}
          >
            {pending && active?.label === transition.label && (
              <Loader2 className="animate-spin" />
            )}
            {transition.label}
          </Button>
        ))}
      </div>

      {active && (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
          <p className="text-xs text-muted-foreground">{active.describe}</p>

          {active.requiresAssignee && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="complaint-assignee">Owner</Label>
              <select
                id="complaint-assignee"
                value={assignedToId}
                onChange={(event) => setAssignedToId(event.target.value)}
                className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="">Choose someone…</option>
                {assignees.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {active.requiresNote && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="complaint-note">
                Note<span className="ml-0.5 text-bad">*</span>
              </Label>
              <Textarea
                id="complaint-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder="What was done, in words the customer will read."
              />
              <p className="text-xs text-muted-foreground">
                This goes onto the thread and is visible to the customer.
              </p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setActive(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={
                pending ||
                (active.requiresNote && note.trim().length === 0) ||
                (active.requiresAssignee && assignedToId.length === 0)
              }
              onClick={() => submit(active, note, assignedToId)}
            >
              {pending && <Loader2 className="animate-spin" />}
              {active.label}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
