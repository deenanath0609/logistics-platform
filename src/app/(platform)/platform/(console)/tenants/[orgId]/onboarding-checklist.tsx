"use client";

import { useActionState } from "react";
import { format } from "date-fns";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { IDLE_FORM } from "@/components/platform/form-bits";
import { toggleOnboardingTask } from "./actions";

export type ChecklistItem = {
  id: string;
  key: string;
  label: string;
  note?: string;
  isBlocking: boolean;
  isDone: boolean;
  doneAt: Date | null;
};

/**
 * One form per row rather than one form with many checkboxes.
 *
 * A checklist that saves on a separate "Save" press is a checklist people
 * stop trusting, because the state on screen and the state in the database
 * disagree for as long as the page is open. Each tick is its own audited
 * write.
 */
function TaskRow({ orgId, task }: { orgId: string; task: ChecklistItem }) {
  const [state, action, pending] = useActionState(
    toggleOnboardingTask.bind(null, orgId),
    IDLE_FORM,
  );

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <form action={action} className="pt-0.5">
        <input type="hidden" name="taskId" value={task.id} />
        <input type="hidden" name="isDone" value={String(!task.isDone)} />
        <button
          type="submit"
          disabled={pending}
          aria-pressed={task.isDone}
          aria-label={`${task.isDone ? "Reopen" : "Complete"}: ${task.label}`}
          className={cn(
            "flex size-5 items-center justify-center rounded-md border transition-colors",
            task.isDone
              ? "border-ok bg-ok text-ok-foreground"
              : "border-input hover:border-primary",
          )}
        >
          {pending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            task.isDone && <Check className="size-3.5" />
          )}
        </button>
      </form>

      <div className="flex min-w-0 flex-col gap-1">
        <p
          className={cn(
            "text-sm",
            task.isDone && "text-muted-foreground line-through",
          )}
        >
          {task.label}
          {task.isBlocking && !task.isDone && (
            <span className="ml-2 rounded-4xl bg-warn-muted px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.1em] text-warn">
              blocks handover
            </span>
          )}
        </p>
        {task.note && (
          <p className="text-xs text-muted-foreground">{task.note}</p>
        )}
        {task.isDone && task.doneAt && (
          <p className="font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
            done {format(task.doneAt, "d MMM yyyy")}
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-xs text-bad">
            {state.error}
          </p>
        )}
      </div>
    </li>
  );
}

export function OnboardingChecklist({
  orgId,
  tasks,
  canWrite,
}: {
  orgId: string;
  tasks: ChecklistItem[];
  canWrite: boolean;
}) {
  if (tasks.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        No checklist exists for this tenant. `scripts/provision-tenant.ts`
        writes one at provisioning time; a carrier onboarded before the
        checklist existed simply has no rows, and back-filling one would mark
        a live carrier as incomplete.
      </p>
    );
  }

  if (!canWrite) {
    return (
      <ul className="divide-y">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-start gap-3 px-4 py-3">
            <span
              className={cn(
                "mt-0.5 flex size-5 items-center justify-center rounded-md border",
                task.isDone ? "border-ok bg-ok text-ok-foreground" : "border-input",
              )}
              aria-hidden
            >
              {task.isDone && <Check className="size-3.5" />}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <p className={cn("text-sm", task.isDone && "text-muted-foreground")}>
                {task.label}
              </p>
              {task.note && (
                <p className="text-xs text-muted-foreground">{task.note}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="divide-y">
      {tasks.map((task) => (
        <TaskRow key={task.id} orgId={orgId} task={task} />
      ))}
    </ul>
  );
}
