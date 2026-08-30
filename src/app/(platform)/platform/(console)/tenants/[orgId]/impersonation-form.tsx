"use client";

import { useActionState } from "react";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FormAlert,
  IDLE_FORM,
  SubmitButton,
} from "@/components/platform/form-bits";
import { openSupportSession } from "./actions";

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const DURATIONS = [15, 30, 60, 120, 240];

/**
 * Opening a support session.
 *
 * Every control here is a deliberate friction. The reason is required and
 * is free text, because a dropdown of reasons becomes a dropdown whose
 * first entry is always chosen. The duration is a closed list, so nobody
 * opens one "for the day". Write access is an unchecked box with the
 * consequence spelled out beside it, because read-only is the answer
 * almost every time and the form should look like it knows that.
 */
export function OpenSupportSessionForm({
  orgId,
  users,
}: {
  orgId: string;
  users: Array<{ id: string; name: string; mobile: string }>;
}) {
  const [state, action] = useActionState(
    openSupportSession.bind(null, orgId),
    IDLE_FORM,
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        label="Reason"
        htmlFor="reason"
        hint="A ticket number and a sentence. This is the only record of why somebody outside the company was inside their data."
      >
        <Textarea id="reason" name="reason" rows={2} required minLength={8} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Expires after" htmlFor="minutes">
          <select
            id="minutes"
            name="minutes"
            defaultValue="30"
            className={SELECT_CLASS}
          >
            {DURATIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} minutes
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Act as"
          htmlFor="asUserId"
          hint="Adopting one person's view reproduces what they can see. Leaving it blank is tenant-wide and read-only."
        >
          <select
            id="asUserId"
            name="asUserId"
            defaultValue=""
            className={SELECT_CLASS}
          >
            <option value="">Nobody in particular</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} · {user.mobile}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <label className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn-muted px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          name="allowWrites"
          className="mt-0.5 size-4 accent-[var(--bad)]"
        />
        <span className="text-warn">
          Allow writes. Without this the session can look but not touch, which
          is what support needs almost every time. Ticking it means anything
          done shows up in the carrier&rsquo;s own audit trail as work nobody
          there did.
        </span>
      </label>

      <FormAlert state={state} />

      <SubmitButton className="self-start">Open support session</SubmitButton>
    </form>
  );
}
