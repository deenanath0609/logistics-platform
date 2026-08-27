"use client";

import { useTransition } from "react";
import Link from "next/link";
import { Bookmark, Loader2, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { SaveState } from "@/components/reports/actions-bar";

/**
 * Saved views, on the report index.
 *
 * Shows who saved a shared one and when it was last opened: a shortcut
 * somebody made six months ago and nobody has run since is usually a
 * shortcut pointing at a question nobody asks any more.
 */

export type SavedRow = {
  id: string;
  reportKey: string;
  reportTitle: string;
  name: string;
  query: string;
  isShared: boolean;
  isMine: boolean;
  ownerName: string | null;
  lastRunAt: string | null;
};

export function SavedReportList({
  rows,
  deleteAction,
}: {
  rows: SavedRow[];
  deleteAction: (formData: FormData) => Promise<SaveState>;
}) {
  const [pending, startTransition] = useTransition();

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed bg-muted/40 px-4 py-3.5 text-sm text-muted-foreground">
        No saved views yet. Filter a report the way you want it, then use
        &ldquo;Save this view&rdquo; — it stores the filters, not the numbers,
        so it is right again tomorrow.
      </p>
    );
  }

  function remove(id: string) {
    const formData = new FormData();
    formData.set("id", id);

    startTransition(async () => {
      const result = await deleteAction(formData);
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
    });
  }

  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((row) => (
        <li
          key={row.id}
          className="flex items-start justify-between gap-3 rounded-lg border bg-card px-3 py-2.5"
        >
          <Link
            href={`/reports/${row.reportKey}${row.query ? `?${row.query}` : ""}`}
            className="flex min-w-0 flex-col gap-0.5"
          >
            <span className="flex items-center gap-1.5 truncate text-sm font-medium underline-offset-4 hover:underline">
              <Bookmark className="size-3.5 shrink-0 text-muted-foreground" />
              {row.name}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {row.reportTitle}
              {row.isShared && !row.isMine && row.ownerName
                ? ` · shared by ${row.ownerName}`
                : ""}
            </span>
            <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
              {row.lastRunAt ? `Last opened ${row.lastRunAt}` : "Never opened"}
            </span>
          </Link>

          <div className="flex shrink-0 items-center gap-1">
            {row.isShared && (
              <Users
                className="size-3.5 text-muted-foreground"
                aria-label="Shared with the team"
              />
            )}
            {row.isMine && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${row.name}`}
                disabled={pending}
                onClick={() => remove(row.id)}
              >
                {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
