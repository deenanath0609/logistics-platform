"use client";

import { useRef, useState, useTransition } from "react";
import {
  Loader2,
  Upload,
  Download,
  CheckCircle2,
  XCircle,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { TableFrame } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { templateCsv } from "@/lib/masters/pincode-import";
import { previewImport, commitImport, type ImportState } from "./actions";

const EMPTY: ImportState = {};

const STATUS_TONE: Record<string, string> = {
  NEW: "bg-ok-muted text-ok",
  UPDATE: "bg-info-muted text-info",
  INVALID: "bg-bad-muted text-bad",
};

export function PincodeImportForm() {
  const [state, setState] = useState<ImportState>(EMPTY);
  const [csv, setCsv] = useState("");
  const [pending, startTransition] = useTransition();
  const [showOnlyProblems, setShowOnlyProblems] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function run(action: typeof previewImport, text: string) {
    startTransition(async () => {
      const data = new FormData();
      data.set("csv", text);
      setState(await action(EMPTY, data));
    });
  }

  async function onFile(file: File) {
    const text = await file.text();
    setCsv(text);
    run(previewImport, text);
  }

  function downloadTemplate() {
    const blob = new Blob([templateCsv()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "pincode-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  const rows = state.rows ?? [];
  const visible = showOnlyProblems
    ? rows.filter((r) => r.status === "INVALID")
    : rows;
  const summary = state.summary;
  const committed = state.committed;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
              Step 1 · The file
            </h2>
            <p className="text-sm text-muted-foreground">
              Columns: <code className="font-mono text-xs">pincode</code>,{" "}
              <code className="font-mono text-xs">city</code> required;{" "}
              <code className="font-mono text-xs">area</code>,{" "}
              <code className="font-mono text-xs">branch</code>,{" "}
              <code className="font-mono text-xs">serviceable</code>,{" "}
              <code className="font-mono text-xs">oda</code> optional.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={downloadTemplate}>
              <Download />
              Template
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={pending}
            >
              <FileText />
              Choose file
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onFile(file);
              }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="csv">Or paste it here</Label>
          <Textarea
            id="csv"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={6}
            placeholder={"pincode,city,area,branch,serviceable,oda\n302020,Jaipur,Malviya Nagar,HUB-JAI,yes,no"}
            className="font-mono text-xs"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => run(previewImport, csv)}
            disabled={pending || !csv.trim()}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Upload />}
            Check the file
          </Button>
          <p className="text-xs text-muted-foreground">
            Nothing is written until you confirm.
          </p>
        </div>

        {state.error && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
          >
            <XCircle className="mt-0.5 size-4 shrink-0" />
            {state.error}
          </p>
        )}
      </section>

      {summary && (
        <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
              Step 2 · {committed ? "Imported" : "What will happen"}
            </h2>
            {rows.some((r) => r.status === "INVALID") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowOnlyProblems((v) => !v)}
              >
                {showOnlyProblems ? "Show all rows" : "Show only problems"}
              </Button>
            )}
          </div>

          <div className="flex flex-wrap gap-3">
            {[
              { label: "Rows", value: summary.total },
              { label: "New", value: summary.create, tone: "text-ok" },
              { label: "Updated", value: summary.update, tone: "text-info" },
              {
                label: "Cannot import",
                value: summary.invalid,
                tone: summary.invalid > 0 ? "text-bad" : undefined,
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="flex items-baseline gap-2 rounded-md border px-3 py-1.5"
              >
                <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
                  {stat.label}
                </span>
                <span className={`text-sm font-semibold tabular ${stat.tone ?? ""}`}>
                  {stat.value}
                </span>
              </div>
            ))}
          </div>

          {committed ? (
            <p className="flex items-start gap-2 rounded-md border border-ok/40 bg-ok-muted px-3 py-2 text-sm text-ok">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <span>
                {committed.created} added, {committed.updated} updated
                {committed.skipped > 0 ? (
                  <>
                    , <strong>{committed.skipped} skipped</strong> — fix those
                    rows and upload again. Re-importing is safe: a PIN that
                    already exists is updated, not duplicated.
                  </>
                ) : (
                  "."
                )}
              </span>
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => run(commitImport, state.csv ?? csv)}
                disabled={pending || summary.create + summary.update === 0}
              >
                {pending ? <Loader2 className="animate-spin" /> : <Upload />}
                Import {summary.create + summary.update} row
                {summary.create + summary.update === 1 ? "" : "s"}
              </Button>
              {summary.invalid > 0 && (
                <p className="text-xs text-warn">
                  {summary.invalid} row{summary.invalid === 1 ? "" : "s"} will be
                  skipped. The rest still import.
                </p>
              )}
            </div>
          )}

          <TableFrame>
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14">Row</TableHead>
                  <TableHead>PIN</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead>Area</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.slice(0, 200).map((row) => (
                  <TableRow key={row.rowNumber}>
                    <TableCell className="tabular text-muted-foreground">
                      {row.rowNumber}
                    </TableCell>
                    <TableCell
                      className={`font-mono text-xs ${row.errors.pincode ? "bg-bad-muted" : ""}`}
                    >
                      {row.code || "—"}
                      {row.errors.pincode && (
                        <p className="mt-0.5 font-sans text-[0.65rem] text-bad">
                          {row.errors.pincode}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className={row.errors.city ? "bg-bad-muted" : ""}>
                      <span className="text-xs">{row.city || "—"}</span>
                      {row.errors.city && (
                        <p className="mt-0.5 text-[0.65rem] text-bad">
                          {row.errors.city}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.area ?? "—"}
                    </TableCell>
                    <TableCell className={row.errors.branch ? "bg-bad-muted" : ""}>
                      <span className="font-mono text-xs">{row.branch ?? "—"}</span>
                      {row.errors.branch && (
                        <p className="mt-0.5 font-sans text-[0.65rem] text-bad">
                          {row.errors.branch}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {[
                        row.serviceable ? null : "blocked",
                        row.oda ? "ODA" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${STATUS_TONE[row.status]}`}
                      >
                        {row.status === "NEW"
                          ? "Add"
                          : row.status === "UPDATE"
                            ? "Update"
                            : "Skip"}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>

          {visible.length > 200 && (
            <p className="text-xs text-muted-foreground">
              Showing the first 200 of {visible.length} rows. All of them are
              imported — this table is only a preview.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
