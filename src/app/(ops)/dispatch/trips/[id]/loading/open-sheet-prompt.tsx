"use client";

import { useActionState } from "react";
import { Loader2, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openSheetAction, type LoadingState } from "./actions";

const IDLE: LoadingState = {};

/** Shown when a trip has no open sheet — either never opened, or done. */
export function OpenSheetPrompt({
  tripId,
  tripNumber,
  closed,
  hasLoad,
  departed,
}: {
  tripId: string;
  tripNumber: string;
  closed: boolean;
  hasLoad: boolean;
  departed: boolean;
}) {
  const [state, formAction, pending] = useActionState(openSheetAction, IDLE);

  if (departed) {
    return (
      <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {tripNumber} has already left. Loading sheets belong to the yard,
        before gate-out.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border bg-card p-6">
      <h2 className="font-medium">
        {closed ? "This trip's loading sheet is closed" : "No loading sheet open"}
      </h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        {closed
          ? "Everything scanned matched everything on the paperwork, so the sheet was closed and the trip can gate out. Opening a new one starts the count again."
          : hasLoad
            ? "Open one to scan packages onto the vehicle. Once a sheet exists, the trip cannot gate out until it closes cleanly."
            : "Attach a manifest to this trip first — there is nothing to load against."}
      </p>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}

      {hasLoad && (
        <form action={formAction}>
          <input type="hidden" name="tripId" value={tripId} />
          <Button type="submit" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <ScanLine />}
            {closed ? "Open another sheet" : "Open loading sheet"}
          </Button>
        </form>
      )}
    </div>
  );
}
