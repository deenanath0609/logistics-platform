"use client";

import { useActionState, useId, useState } from "react";
import { Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  uploadPortalBulkFile,
  type BulkState,
} from "@/app/(portal)/portal/(app)/bulk/actions";

const IDLE: BulkState = {};

/**
 * The upload box.
 *
 * There is no branch selector and no account selector, unlike the
 * operations version of this screen. Both are decided server-side from the
 * signed-in account — a customer choosing either would be a customer with
 * a lever on somebody else's network, or on somebody else's bill.
 */
export function PortalBulkUploadCard() {
  const [state, action, pending] = useActionState(uploadPortalBulkFile, IDLE);
  const [fileName, setFileName] = useState<string | null>(null);
  const formId = useId();

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-file`}>Your file</Label>
        <Input
          id={`${formId}-file`}
          name="file"
          type="file"
          accept=".csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="h-auto py-1.5"
          onChange={(event) =>
            setFileName(event.currentTarget.files?.[0]?.name ?? null)
          }
          required
        />
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {fileName ??
              "CSV or XLSX, up to 5 MB. A file saved straight out of Excel is fine — we read the BOM, the smart quotes and the semicolons."}
          </span>
        </p>
      </div>

      {state.error && (
        <div className="rounded-lg border border-bad/30 bg-bad-muted px-3 py-2 text-sm text-bad">
          <p>{state.error}</p>
          {state.missingHeaders && state.missingHeaders.length > 0 && (
            <>
              <p className="mt-1.5 text-xs">These columns were not found:</p>
              <ul className="mt-1 list-inside list-disc font-mono text-xs">
                {state.missingHeaders.map((header) => (
                  <li key={header}>{header}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? <Loader2 className="animate-spin" /> : <Upload />}
          {pending ? "Reading your file…" : "Upload and check"}
        </Button>
        {/*
          A plain anchor on purpose. The template path is a route handler
          that streams a CSV, not a page — next/link would client-navigate
          to it and nothing would download.
        */}
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          render={
            /*
              `download` with no value, deliberately. Named, it overrode the
              route's own `Content-Disposition` for a same-origin link — and
              what it named was the demo carrier's slug, so every carrier's
              customers downloaded a file called `city-logistics-…`. Bare, it
              still forces a download and lets the server decide the name,
              which is the only place that knows whose carrier this is.
            */
            <a href="/portal/bulk/template" download />
          }
        >
          <Download />
          Download the template
        </Button>
      </div>
    </form>
  );
}
