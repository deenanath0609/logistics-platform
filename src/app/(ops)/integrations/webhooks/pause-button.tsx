"use client";

import { useTransition } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { setWebhookPaused } from "../actions";
import type { ActionState } from "@/server/services/master-crud";

const IDLE: ActionState = {};

export function PauseButton({
  subscriptionId,
  paused,
}: {
  subscriptionId: string;
  paused: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function submit() {
    const formData = new FormData();
    formData.set("id", subscriptionId);
    formData.set("paused", String(!paused));

    startTransition(async () => {
      const result = await setWebhookPaused(IDLE, formData);
      if (result.ok) toast.success(result.message ?? "Updated.");
      else toast.error(result.error ?? "That could not be changed.");
    });
  }

  return (
    <Button
      size="sm"
      variant={paused ? "default" : "outline"}
      disabled={pending}
      onClick={submit}
    >
      {pending ? <Loader2 className="animate-spin" /> : paused ? <Play /> : <Pause />}
      {paused ? "Resume" : "Pause"}
    </Button>
  );
}
