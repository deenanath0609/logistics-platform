"use client";

import { useActionState } from "react";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormAlert, IDLE_FORM } from "@/components/platform/form-bits";
import { enterSupportSession } from "./actions";

/**
 * Offered only for the operator's own open grant.
 *
 * Ending someone else's session is a safety valve and is open to anyone
 * with the capability; entering it is not, and the server refuses it
 * regardless — this is only the half of that rule that stops the button
 * appearing where it would always fail.
 */
export function EnterSessionButton({
  grantId,
  carrierName,
}: {
  grantId: string;
  carrierName: string;
}) {
  const [state, action, pending] = useActionState(
    enterSupportSession.bind(null, grantId),
    IDLE_FORM,
  );

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <Button type="submit" size="sm" disabled={pending}>
        <LogIn />
        Enter
      </Button>
      <span className="sr-only">Enter the support session into {carrierName}</span>
      <FormAlert state={state} />
    </form>
  );
}
