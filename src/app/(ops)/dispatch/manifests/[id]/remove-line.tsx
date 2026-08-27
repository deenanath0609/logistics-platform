"use client";

import { useActionState, useEffect } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { removeShipmentAction, type ManifestState } from "../actions";

const IDLE: ManifestState = {};

/** Pulling a consignment back off the truck. Appends MANIFEST_REMOVED. */
export function RemoveLineButton({
  manifestId,
  shipmentId,
  lrNumber,
}: {
  manifestId: string;
  shipmentId: string;
  lrNumber: string;
}) {
  const [state, formAction, pending] = useActionState(removeShipmentAction, IDLE);

  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
    else if (state.error) toast.error(state.error);
  }, [state]);

  return (
    <form action={formAction}>
      <input type="hidden" name="manifestId" value={manifestId} />
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <Button
        type="submit"
        variant="ghost"
        size="icon-xs"
        disabled={pending}
        title={`Remove ${lrNumber} from this manifest`}
      >
        {pending ? <Loader2 className="animate-spin" /> : <X />}
        <span className="sr-only">Remove {lrNumber}</span>
      </Button>
    </form>
  );
}
