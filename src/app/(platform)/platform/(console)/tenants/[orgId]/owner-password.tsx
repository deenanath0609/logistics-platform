"use client";

import { useActionState } from "react";
import { KeyRound } from "lucide-react";
import { IDLE_FORM, SubmitButton } from "@/components/platform/form-bits";
import { dismissOwnerPassword } from "../new/actions";

/**
 * The generated owner password, shown once.
 *
 * "Once" is not a figure of speech here: the plaintext exists only in the
 * one-time cookie this panel is rendered from, and nothing in the system
 * can produce it again. So the panel says so plainly rather than politely
 * — an operator who closes this tab assuming they can come back for it has
 * locked the carrier's first owner out of their own tenant.
 *
 * The dismiss button deletes the cookie. Ten minutes deletes it anyway.
 */
export function OwnerPasswordPanel({
  orgId,
  ownerName,
  password,
  signInUrl,
}: {
  orgId: string;
  ownerName: string | null;
  password: string;
  signInUrl: string;
}) {
  const [state, action] = useActionState(
    dismissOwnerPassword.bind(null, orgId),
    IDLE_FORM,
  );

  return (
    <section className="mb-6 flex flex-col gap-4 rounded-lg border border-ok/40 bg-ok-muted p-5">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-ok" />
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold tracking-tight text-ok">
            Carrier provisioned. Here is the first owner&apos;s password.
          </h2>
          <p className="max-w-prose text-xs text-ok">
            This is the only time it will be shown. It is not stored anywhere
            else and cannot be recovered — give it to{" "}
            {ownerName ?? "the first owner"} now, by a channel you trust.
          </p>
        </div>
      </div>

      <p className="rounded-md border border-ok/40 bg-background px-3 py-2 font-mono text-lg tracking-wider select-all">
        {password}
      </p>

      <p className="max-w-prose text-xs text-ok">
        They sign in at{" "}
        <a
          href={signInUrl}
          target="_blank"
          rel="noreferrer"
          className="font-mono underline underline-offset-4"
        >
          {signInUrl}
        </a>{" "}
        with their mobile number, and are forced to change this password before
        they can do anything else.
      </p>

      {state.error && (
        <p role="alert" className="text-xs text-bad">
          {state.error}
        </p>
      )}

      <form action={action}>
        <SubmitButton variant="outline" className="self-start">
          I have saved it — hide this
        </SubmitButton>
      </form>
    </section>
  );
}
