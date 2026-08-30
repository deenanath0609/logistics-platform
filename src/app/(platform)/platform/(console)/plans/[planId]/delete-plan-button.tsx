"use client";

import { useActionState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormAlert, IDLE_FORM } from "@/components/platform/form-bits";
import { deletePlanAction } from "../actions";

/**
 * Deletion is offered even when it will be refused.
 *
 * The service refuses a plan that still has carriers on it and says how
 * many. Hiding the button instead would leave an operator guessing why the
 * plan cannot go, when the useful answer — "four tenants are on it" — is
 * one press away.
 */
export function DeletePlanButton({
  planId,
  planName,
  tenantCount,
}: {
  planId: string;
  planName: string;
  tenantCount: number;
}) {
  const [state, action] = useActionState(
    deletePlanAction.bind(null, planId),
    IDLE_FORM,
  );

  return (
    <form action={action} className="flex flex-col gap-2">
      <Button
        type="submit"
        variant="destructive"
        size="sm"
        className="self-start"
        onClick={(event) => {
          if (!window.confirm(`Delete ${planName}? This cannot be undone.`)) {
            event.preventDefault();
          }
        }}
      >
        <Trash2 />
        Delete plan
      </Button>
      {tenantCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {tenantCount} tenant(s) are on this plan, so deleting it will be
          refused — retire it instead by unticking &ldquo;offered to new
          tenants&rdquo;.
        </p>
      )}
      <FormAlert state={state} />
    </form>
  );
}
