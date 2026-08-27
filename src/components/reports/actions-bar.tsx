"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BookmarkPlus, Download, Loader2, Table2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Export and save, on every report page.
 *
 * The export links carry the current query string, so what downloads is
 * exactly what is on screen — the alternative, re-deriving the filters
 * server-side from something else, is how an export quietly stops
 * matching the table above it.
 *
 * Both formats are plain links rather than fetches: the CSV is streamed
 * and the browser's own download handling is better than anything worth
 * writing here.
 */

export type SaveState =
  | { ok: true; message: string }
  | { ok: false; error: string };

export function ReportActions({
  reportKey,
  canExport,
  exportNote,
  saveAction,
}: {
  reportKey: string;
  canExport: boolean;
  /** Row ceiling, spelled out before somebody waits for a truncated file. */
  exportNote: string;
  saveAction: (formData: FormData) => Promise<SaveState>;
}) {
  const params = useSearchParams();
  const query = params.toString();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SaveDialog reportKey={reportKey} query={query} action={saveAction} />

      {canExport ? (
        <>
          <Button
            variant="outline"
            size="sm"
            title={exportNote}
            render={
              <Link
                href={`/reports/${reportKey}/export?format=csv&${query}`}
                prefetch={false}
              />
            }
          >
            <Download />
            CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            title={exportNote}
            render={
              <Link
                href={`/reports/${reportKey}/export?format=xlsx&${query}`}
                prefetch={false}
              />
            }
          >
            <Table2 />
            XLSX
          </Button>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Exporting needs the bulk export permission.
        </p>
      )}
    </div>
  );
}

function SaveDialog({
  reportKey,
  query,
  action,
}: {
  reportKey: string;
  query: string;
  action: (formData: FormData) => Promise<SaveState>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit() {
    const formData = new FormData();
    formData.set("reportKey", reportKey);
    formData.set("name", name);
    formData.set("query", query);
    formData.set("isShared", shared ? "on" : "");

    startTransition(async () => {
      const result = await action(formData);
      if (result.ok) {
        toast.success(result.message);
        setOpen(false);
        setName("");
        setShared(false);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <BookmarkPlus />
        Save this view
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save this view</DialogTitle>
          <DialogDescription>
            Stores the filters, not the numbers. Opening it tomorrow runs the
            report again against whatever the network has done since.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="saved-name">Name</Label>
            <Input
              id="saved-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Delhi → Jaipur express, this month"
              maxLength={80}
            />
          </div>

          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox
              checked={shared}
              onCheckedChange={(checked) => setShared(Boolean(checked))}
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">Share with the team</span>
              <span className="text-xs text-muted-foreground">
                Anyone who can run this report will see it. They still only see
                the branches their own scope allows.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={pending || name.trim().length < 2}
          >
            {pending && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
