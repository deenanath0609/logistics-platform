"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cancelPickup, type PickupState } from "./actions";

const EMPTY: PickupState = {};

export function CancelPickupButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState(cancelPickup, EMPTY);

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" size="xs" disabled={pending}>
        {pending && <Loader2 className="animate-spin" />}
        Cancel
      </Button>
      {state.error && <span className="text-xs text-bad">{state.error}</span>}
    </form>
  );
}
