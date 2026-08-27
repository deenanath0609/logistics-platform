"use client";

import { useActionState, useTransition } from "react";
import { KeyRound, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { retryWebhookDelivery, rotateWebhookSecret, type HookState } from "../../actions";
import { SecretReveal } from "../../secret-reveal";
import type { ActionState } from "@/server/services/master-crud";

const IDLE: ActionState = {};
const IDLE_HOOK: HookState = {};

export function RetryButton({ deliveryId }: { deliveryId: string }) {
  const [pending, startTransition] = useTransition();

  function submit() {
    const formData = new FormData();
    formData.set("id", deliveryId);

    startTransition(async () => {
      const result = await retryWebhookDelivery(IDLE, formData);
      if (result.ok) toast.success(result.message ?? "Queued.");
      else toast.error(result.error ?? "That could not be re-queued.");
    });
  }

  return (
    <Button size="xs" variant="outline" disabled={pending} onClick={submit}>
      {pending ? <Loader2 className="animate-spin" /> : <RotateCw />}
      Retry
    </Button>
  );
}

export function RotateSecret({
  subscriptionId,
  subscriptionName,
}: {
  subscriptionId: string;
  subscriptionName: string;
}) {
  const [state, action, pending] = useActionState(rotateWebhookSecret, IDLE_HOOK);

  return (
    <div className="flex flex-col gap-3">
      <form action={action}>
        <input type="hidden" name="id" value={subscriptionId} />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <KeyRound />}
          Rotate signing secret
        </Button>
      </form>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}

      {state.secret && (
        <SecretReveal
          label={`New signing secret for ${subscriptionName}`}
          secret={state.secret}
          hint="Deliveries are signed with this from now on. Anything still verifying against the old secret will start failing — update the partner before the next event fires."
        />
      )}
    </div>
  );
}
