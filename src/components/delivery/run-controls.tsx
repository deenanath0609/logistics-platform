"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PackageCheck, Play } from "lucide-react";
import type { DeliveryRunStatus } from "@/generated/prisma/client";
import { Button } from "@/components/ui/button";
import { enqueue } from "@/lib/delivery/offline-queue";

/**
 * Starting and closing the run.
 *
 * Both go through the offline queue: a branch loading bay is one of the
 * worst places in the network for signal, and an agent should never be
 * standing there watching a spinner before they can leave.
 */
export function RunControls({
  runId,
  status,
  pendingStops,
}: {
  runId: string;
  status: DeliveryRunStatus;
  pendingStops: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [queued, setQueued] = useState(false);

  function queueAction(kind: "START_RUN" | "COMPLETE_RUN", message: string) {
    startTransition(async () => {
      await enqueue(kind, { runId });
      setQueued(true);
      toast.success(message);
      router.refresh();
    });
  }

  if (status === "PLANNED") {
    return (
      <Button
        size="lg"
        className="min-h-12 w-full text-base"
        disabled={pending || queued || pendingStops === 0}
        onClick={() =>
          queueAction(
            "START_RUN",
            "Run started. The office can see the parcels are with you.",
          )
        }
      >
        <Play />
        {queued ? "Starting…" : `Start run · ${pendingStops} stops`}
      </Button>
    );
  }

  if (status === "STARTED" && pendingStops === 0) {
    return (
      <Button
        size="lg"
        variant="outline"
        className="min-h-12 w-full text-base"
        disabled={pending || queued}
        onClick={() =>
          queueAction(
            "COMPLETE_RUN",
            "Run closed. Hand the cash in at the branch.",
          )
        }
      >
        <PackageCheck />
        {queued ? "Closing…" : "Finish run"}
      </Button>
    );
  }

  return null;
}
