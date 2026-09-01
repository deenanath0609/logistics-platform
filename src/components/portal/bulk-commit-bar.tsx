"use client";

import { useActionState } from "react";
import Link from "next/link";
import { CheckCheck, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  commitPortalBulkBatch,
  recheckPortalBulkBatch,
  type BulkCommitState,
  type BulkState,
} from "@/app/(portal)/portal/(app)/bulk/actions";

const IDLE_COMMIT: BulkCommitState = {};
const IDLE: BulkState = {};

/**
 * Confirm and re-check.
 *
 * The button says how many rows it will book, because "Confirm" on a
 * screen showing two hundred rows is not a number anyone should have to
 * infer. Pressing it twice is harmless: the shared committer books each
 * row under `bulk:<batchId>:<rowNumber>` and adopts anything already
 * booked rather than repeating it.
 *
 * There is no "abandon" here. A customer's file is their record of what
 * they asked for, and a button that marks it abandoned buys them nothing.
 */
export function PortalCommitBar({
  batchId,
  readyRows,
  invalidRows,
  committedRows,
  canCommit,
}: {
  batchId: string;
  readyRows: number;
  invalidRows: number;
  committedRows: number;
  canCommit: boolean;
}) {
  const [commitState, commit, committing] = useActionState(
    commitPortalBulkBatch,
    IDLE_COMMIT,
  );
  const [recheckState, recheck, rechecking] = useActionState(
    recheckPortalBulkBatch,
    IDLE,
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <form action={commit} className="w-full sm:w-auto">
          <input type="hidden" name="batchId" value={batchId} />
          <Button
            type="submit"
            className="w-full sm:w-auto"
            disabled={!canCommit || readyRows === 0 || committing}
          >
            {committing ? <Loader2 className="animate-spin" /> : <CheckCheck />}
            {readyRows === 0
              ? "Nothing ready to book"
              : `Book ${readyRows} ready ${readyRows === 1 ? "row" : "rows"}`}
          </Button>
        </form>

        <form action={recheck} className="w-full sm:w-auto">
          <input type="hidden" name="batchId" value={batchId} />
          {/*
            Gated on the same flag as Confirm. Re-checking rewrites every
            row's status, so offering it to a login that may not book is
            offering a write to a reader.
          */}
          <Button
            type="submit"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={!canCommit || rechecking}
          >
            {rechecking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Re-check
          </Button>
        </form>
      </div>

      {invalidRows > 0 && (
        <p className="text-sm text-muted-foreground">
          {invalidRows} {invalidRows === 1 ? "row stays" : "rows stay"} here for
          correction. Booking the rest does not lose them.
        </p>
      )}

      {committedRows > 0 && (
        <p className="text-sm text-muted-foreground">
          {committedRows} already booked from this file.
        </p>
      )}

      {recheckState.message && (
        <p className="text-sm text-muted-foreground">{recheckState.message}</p>
      )}
      {recheckState.error && (
        <p className="text-sm text-bad">{recheckState.error}</p>
      )}

      {commitState.error && (
        <p className="rounded-lg border border-bad/30 bg-bad-muted px-3 py-2 text-sm text-bad">
          {commitState.error}
        </p>
      )}

      {commitState.ok && commitState.summary && (
        <div className="flex flex-col gap-2 rounded-lg border border-ok/30 bg-ok-muted px-3 py-2 text-sm text-ok">
          <p className="font-medium">{commitState.message}</p>

          {commitState.summary.lrNumbers.length > 0 && (
            <p className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-xs">
              {commitState.summary.lrNumbers.map((lrNumber) => (
                <Link
                  key={lrNumber}
                  href={`/portal/shipments?q=${encodeURIComponent(lrNumber)}`}
                  className="hover:underline"
                >
                  {lrNumber}
                </Link>
              ))}
            </p>
          )}

          {commitState.summary.failures.length > 0 && (
            <ul className="list-inside list-disc text-xs text-bad">
              {commitState.summary.failures.map((failure) => (
                <li key={failure.rowNumber}>
                  Row {failure.rowNumber}: {failure.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
