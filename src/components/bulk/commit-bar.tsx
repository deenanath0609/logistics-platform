"use client";

import { useActionState } from "react";
import Link from "next/link";
import { CheckCheck, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  abandonBulkBatch,
  commitBulkBatch,
  revalidateBulkBatch,
  type CommitState,
} from "@/app/(ops)/shipments/bulk/actions";
import type { ActionState } from "@/server/services/master-crud";

const IDLE_COMMIT: CommitState = {};
const IDLE: ActionState = {};

/**
 * Confirm, re-check and abandon.
 *
 * The commit button says how many rows it will book, because "Confirm" on
 * a screen showing two hundred rows is not a number anyone should have to
 * infer. Pressing it twice is harmless: the committer books against a
 * deterministic key per row and adopts anything already booked.
 */
export function CommitBar({
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
    commitBulkBatch,
    IDLE_COMMIT,
  );
  const [recheckState, recheck, rechecking] = useActionState(
    revalidateBulkBatch,
    IDLE,
  );
  const [, abandon, abandoning] = useActionState(abandonBulkBatch, IDLE);

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <form action={commit}>
          <input type="hidden" name="batchId" value={batchId} />
          <Button type="submit" disabled={!canCommit || readyRows === 0 || committing}>
            {committing ? <Loader2 className="animate-spin" /> : <CheckCheck />}
            {readyRows === 0
              ? "Nothing ready to book"
              : `Book ${readyRows} ready ${readyRows === 1 ? "row" : "rows"}`}
          </Button>
        </form>

        <form action={recheck}>
          <input type="hidden" name="batchId" value={batchId} />
          <Button type="submit" variant="outline" disabled={rechecking}>
            {rechecking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Re-check
          </Button>
        </form>

        {committedRows === 0 && (
          <form action={abandon}>
            <input type="hidden" name="batchId" value={batchId} />
            <Button type="submit" variant="ghost" disabled={abandoning}>
              <Trash2 />
              Abandon
            </Button>
          </form>
        )}

        {invalidRows > 0 && (
          <p className="text-sm text-muted-foreground">
            {invalidRows} {invalidRows === 1 ? "row stays" : "rows stay"} here
            for correction — booking the rest does not lose them.
          </p>
        )}
      </div>

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
                  href={`/shipments?q=${encodeURIComponent(lrNumber)}`}
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
