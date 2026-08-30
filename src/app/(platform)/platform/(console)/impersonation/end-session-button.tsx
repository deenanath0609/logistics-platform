"use client";

import { useActionState } from "react";
import { CircleX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormAlert, IDLE_FORM } from "@/components/platform/form-bits";
import { endSupportSession } from "./actions";

export function EndSessionButton({
  grantId,
  adminName,
}: {
  grantId: string;
  adminName: string;
}) {
  const [state, action, pending] = useActionState(
    endSupportSession.bind(null, grantId),
    IDLE_FORM,
  );

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        <CircleX />
        End now
      </Button>
      <span className="sr-only">End the session opened by {adminName}</span>
      <FormAlert state={state} />
    </form>
  );
}
