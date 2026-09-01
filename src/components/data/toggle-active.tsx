"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { Power, PowerOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/server/services/master-crud";

const EMPTY: ActionState = {};

/**
 * Masters are deactivated, never deleted — a retired charge head still has to
 * render on last year's invoices.
 */
export function ToggleActive({
  id,
  isActive,
  label,
  action,
  disabled,
  disabledReason,
}: {
  id: string;
  isActive: boolean;
  label: string;
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  disabled?: boolean;
  /**
   * Why the button is off, shown on hover. A disabled control with no
   * explanation is indistinguishable from a broken one.
   */
  disabledReason?: string;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY);

  useEffect(() => {
    if (state.ok) toast.success(state.message ?? "Updated.");
    else if (state.error) toast.error(state.error);
  }, [state]);

  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="isActive" value={String(!isActive)} />
      <Button
        type="submit"
        variant="ghost"
        size="icon-sm"
        disabled={pending || disabled}
        title={
          disabled && disabledReason
            ? disabledReason
            : isActive
              ? `Deactivate ${label}`
              : `Reactivate ${label}`
        }
        className={isActive ? "text-muted-foreground" : "text-ok"}
      >
        {pending ? (
          <Loader2 className="animate-spin" />
        ) : isActive ? (
          <PowerOff />
        ) : (
          <Power />
        )}
        <span className="sr-only">
          {isActive ? "Deactivate" : "Reactivate"} {label}
        </span>
      </Button>
    </form>
  );
}
