"use client";

import { useTransition } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * "Apply now".
 *
 * The sweep would get to these shipments within a few minutes anyway.
 * The button is for the minutes after somebody creates the first policy,
 * when what they need is to watch it take effect — an admin screen that
 * asks people to wait and refresh teaches them to doubt whether the save
 * worked at all.
 */
export function RecomputeSla({
  action,
}: {
  action: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>;
}) {
  const [pending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const result = await action();
      if (result.ok) toast.success(result.message);
      // A lane still uncovered is a real answer, not a failure — it is
      // told as a warning so it does not read as "the recompute broke".
      else toast.warning(result.error);
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={run} disabled={pending}>
      {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      Apply to open shipments
    </Button>
  );
}
