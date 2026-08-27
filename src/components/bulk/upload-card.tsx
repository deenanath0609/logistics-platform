"use client";

import { useActionState, useId, useState } from "react";
import { Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { uploadBulkFile, type UploadState } from "@/app/(ops)/shipments/bulk/actions";

const IDLE: UploadState = {};

const selectClass =
  "h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive";

export type BranchChoice = { value: string; label: string };

export function UploadCard({
  branches,
  defaultBranchId,
}: {
  branches: BranchChoice[];
  defaultBranchId: string | null;
}) {
  const [state, action, pending] = useActionState(uploadBulkFile, IDLE);
  const [fileName, setFileName] = useState<string | null>(null);
  const formId = useId();

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-branch`}>Book against</Label>
        <select
          id={`${formId}-branch`}
          name="branchId"
          defaultValue={defaultBranchId ?? ""}
          className={selectClass}
          required
        >
          <option value="">Select…</option>
          {branches.map((branch) => (
            <option key={branch.value} value={branch.value}>
              {branch.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Every row books at this branch. Origin and destination still come from
          each row of the file.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${formId}-file`}>File</Label>
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
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FileSpreadsheet className="size-3.5" />
          {fileName ??
            "CSV or XLSX, up to 5 MB. Files saved from Excel — BOM, smart quotes, semicolons — are read as they are."}
        </p>
      </div>

      {state.error && (
        <div className="rounded-lg border border-bad/30 bg-bad-muted px-3 py-2 text-sm text-bad">
          <p>{state.error}</p>
          {state.missingHeaders && state.missingHeaders.length > 0 && (
            <ul className="mt-1.5 list-inside list-disc font-mono text-xs">
              {state.missingHeaders.map((header) => (
                <li key={header}>{header}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Upload />}
          {pending ? "Reading the file…" : "Upload and check"}
        </Button>
        {/*
          A plain anchor on purpose. This path is a route handler that
          streams a CSV, not a page — next/link would client-navigate to it
          and the file would never download.
        */}
        <Button
          variant="outline"
          render={<a href="/shipments/bulk/template" download="shipment-upload-template.csv" />}
        >
          <Download />
          Download template
        </Button>
      </div>
    </form>
  );
}
