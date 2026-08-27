"use client";

import { useState, useTransition } from "react";
import { Loader2, UserRoundPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ExceptionStatus } from "@/generated/prisma/client";
import type { ExceptionTransition } from "@/lib/exceptions/kinds";

/**
 * The buttons a duty manager actually presses.
 *
 * Which transitions exist comes from `kinds.ts` on the server and arrives
 * as data — the same table the server action checks against, so a button
 * can never offer something the action would then refuse.
 *
 * Choosing a transition that needs a note expands the form here rather
 * than opening a dialog. The note is the work: burying it one click
 * deeper is exactly how exceptions get closed with "done" as the
 * resolution, and a tower full of "done" is a tower nobody reads.
 */

export type ExceptionActionState =
  | { ok: true; message: string }
  | { ok: false; error: string };

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function ExceptionWorkflow({
  exceptionId,
  transitions,
  assignees,
  currentAssigneeId,
  canAssign,
  transitionAction,
  assignAction,
  noteAction,
}: {
  exceptionId: string;
  transitions: ExceptionTransition[];
  assignees: Array<{ id: string; name: string }>;
  currentAssigneeId: string | null;
  canAssign: boolean;
  transitionAction: (formData: FormData) => Promise<ExceptionActionState>;
  assignAction: (formData: FormData) => Promise<ExceptionActionState>;
  noteAction: (formData: FormData) => Promise<ExceptionActionState>;
}) {
  const [active, setActive] = useState<ExceptionTransition | null>(null);
  const [note, setNote] = useState("");
  const [freeNote, setFreeNote] = useState("");
  const [assignee, setAssignee] = useState(currentAssigneeId ?? "");
  const [pending, startTransition] = useTransition();

  function run(
    action: (formData: FormData) => Promise<ExceptionActionState>,
    formData: FormData,
    onDone?: () => void,
  ) {
    startTransition(async () => {
      const result = await action(formData);
      if (result.ok) {
        toast.success(result.message);
        onDone?.();
      } else {
        toast.error(result.error);
      }
    });
  }

  function choose(transition: ExceptionTransition) {
    if (transition.requiresNote) {
      setActive((current) => (current?.to === transition.to ? null : transition));
      return;
    }

    const formData = new FormData();
    formData.set("exceptionId", exceptionId);
    formData.set("to", transition.to satisfies ExceptionStatus);
    formData.set("note", "");
    run(transitionAction, formData);
  }

  function submitActive() {
    if (!active) return;

    const formData = new FormData();
    formData.set("exceptionId", exceptionId);
    formData.set("to", active.to);
    formData.set("note", note);

    run(transitionAction, formData, () => {
      setActive(null);
      setNote("");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {canAssign && (
        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="exception-assignee"
            className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground"
          >
            Owner
          </Label>
          <div className="flex items-center gap-2">
            <select
              id="exception-assignee"
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
              className={SELECT_CLASS}
            >
              <option value="">Nobody yet</option>
              {assignees.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || assignee === (currentAssigneeId ?? "")}
              onClick={() => {
                const formData = new FormData();
                formData.set("exceptionId", exceptionId);
                formData.set("assignedToId", assignee);
                run(assignAction, formData);
              }}
            >
              {pending ? <Loader2 className="animate-spin" /> : <UserRoundPlus />}
              Assign
            </Button>
          </div>
        </div>
      )}

      {transitions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing further to do from here.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {transitions.map((transition) => (
            <Button
              key={transition.to + transition.label}
              type="button"
              size="sm"
              variant={active?.to === transition.to ? "default" : "outline"}
              disabled={pending}
              onClick={() => choose(transition)}
              title={transition.describe}
            >
              {transition.label}
            </Button>
          ))}
        </div>
      )}

      {active && (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
          <p className="text-xs text-muted-foreground">{active.describe}</p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="exception-note">
              Resolution note<span className="ml-0.5 text-bad">*</span>
            </Label>
            <Textarea
              id="exception-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="What was actually done, and what the customer was told."
            />
            <p className="text-xs text-muted-foreground">
              Nothing closes without this. The next person to see this
              consignment reads your note, not the status.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActive(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={submitActive}
              disabled={pending || note.trim().length < 5}
            >
              {pending && <Loader2 className="animate-spin" />}
              {active.label}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5 border-t pt-4">
        <Label htmlFor="exception-free-note">Add a note</Label>
        <Textarea
          id="exception-free-note"
          value={freeNote}
          onChange={(event) => setFreeNote(event.target.value)}
          rows={2}
          placeholder="Called the consignee — reattempting tomorrow morning."
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || freeNote.trim().length === 0}
            onClick={() => {
              const formData = new FormData();
              formData.set("exceptionId", exceptionId);
              formData.set("note", freeNote);
              run(noteAction, formData, () => setFreeNote(""));
            }}
          >
            {pending && <Loader2 className="animate-spin" />}
            Add to the thread
          </Button>
        </div>
      </div>
    </div>
  );
}
