"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  PencilLine,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveBulkRow } from "@/app/(ops)/shipments/bulk/actions";
import type { ActionState } from "@/server/services/master-crud";

/**
 * The marked-up grid.
 *
 * This screen is the feature. A clerk with a rejected file must be able to
 * see which *cell* is wrong, on screen, without downloading an error
 * report and reconciling it against their spreadsheet by row number. So
 * every cell carries its own verdict, and the correction happens in place.
 */

export type GridColumn = {
  field: string;
  header: string;
  required: boolean;
  kind: string;
  values?: string[];
};

export type GridRow = {
  rowNumber: number;
  status: "PENDING" | "VALID" | "INVALID" | "COMMITTED" | "SKIPPED";
  cells: Record<string, string>;
  errors: Record<string, string>;
  warnings: Record<string, string>;
  lrNumber: string | null;
  shipmentId: string | null;
};

type Filter = "errors" | "ready" | "booked" | "all";

const PAGE_SIZE = 50;
const IDLE: ActionState = {};

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const STATUS_TONE: Record<GridRow["status"], string> = {
  PENDING: "bg-muted text-muted-foreground",
  VALID: "bg-accent text-accent-foreground",
  INVALID: "bg-bad-muted text-bad",
  COMMITTED: "bg-ok-muted text-ok",
  SKIPPED: "bg-muted text-muted-foreground",
};

const STATUS_LABEL: Record<GridRow["status"], string> = {
  PENDING: "Checking",
  VALID: "Ready",
  INVALID: "Fix",
  COMMITTED: "Booked",
  SKIPPED: "Skipped",
};

function errorCount(row: GridRow): number {
  return Object.keys(row.errors).length;
}

export function ErrorGrid({
  batchId,
  columns,
  rows,
  editable,
}: {
  batchId: string;
  columns: GridColumn[];
  rows: GridRow[];
  editable: boolean;
}) {
  const invalidCount = rows.filter((row) => row.status === "INVALID").length;

  // Land on the rows that need work. A clerk opening a checked batch is
  // here to fix things, not to admire the rows that passed.
  const [filter, setFilter] = useState<Filter>(
    invalidCount > 0 ? "errors" : "all",
  );
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<number | null>(null);
  const [allFields, setAllFields] = useState(false);
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    switch (filter) {
      case "errors":
        return rows.filter((row) => row.status === "INVALID");
      case "ready":
        return rows.filter((row) => row.status === "VALID");
      case "booked":
        return rows.filter((row) => row.status === "COMMITTED");
      default:
        return rows;
    }
  }, [rows, filter]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  function choose(next: Filter) {
    setFilter(next);
    setPage(1);
    setEditing(null);
  }

  function save(formData: FormData) {
    startTransition(async () => {
      const result = await saveBulkRow(IDLE, formData);
      if (result.ok) {
        toast.success(result.message ?? "Row updated.");
        setEditing(null);
      } else {
        toast.error(result.error ?? "That correction could not be saved.");
      }
    });
  }

  const counts = {
    all: rows.length,
    errors: invalidCount,
    ready: rows.filter((row) => row.status === "VALID").length,
    booked: rows.filter((row) => row.status === "COMMITTED").length,
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {(["errors", "ready", "booked", "all"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={filter === option ? "secondary" : "ghost"}
              onClick={() => choose(option)}
            >
              {option === "errors" && <AlertTriangle className="text-bad" />}
              {option === "errors"
                ? "Needs fixing"
                : option === "ready"
                  ? "Ready"
                  : option === "booked"
                    ? "Booked"
                    : "All rows"}
              <span className="ml-1 font-mono text-[0.7rem] text-muted-foreground">
                {counts[option]}
              </span>
            </Button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={allFields}
            onChange={(event) => setAllFields(event.currentTarget.checked)}
            className="size-3.5 accent-primary"
          />
          Edit every column, not only the failing ones
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full caption-bottom text-sm">
          <thead className="[&_tr]:border-b">
            <tr>
              <th className="sticky left-0 z-20 h-10 bg-card px-2 text-left align-middle font-medium whitespace-nowrap">
                Row
              </th>
              <th className="h-10 px-2 text-left align-middle font-medium whitespace-nowrap">
                Status
              </th>
              {columns.map((column) => (
                <th
                  key={column.field}
                  className="h-10 px-2 text-left align-middle font-medium whitespace-nowrap"
                >
                  {column.header}
                  {column.required && <span className="ml-0.5 text-bad">*</span>}
                </th>
              ))}
            </tr>
          </thead>

          <tbody className="[&_tr:last-child]:border-0">
            {visible.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length + 2}
                  className="px-4 py-10 text-center text-sm text-muted-foreground"
                >
                  Nothing in this view.
                </td>
              </tr>
            )}

            {visible.map((row) => {
              const failing = Object.keys(row.errors);
              const editableFields = allFields
                ? columns.map((c) => c.field)
                : columns
                    .filter((c) => failing.includes(c.field))
                    .map((c) => c.field);

              return (
                <FragmentRow
                  key={row.rowNumber}
                  batchId={batchId}
                  row={row}
                  columns={columns}
                  editable={editable}
                  isEditing={editing === row.rowNumber}
                  editableFields={editableFields}
                  pending={pending}
                  onEdit={() => setEditing(row.rowNumber)}
                  onCancel={() => setEditing(null)}
                  onSave={save}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground tabular">
            {(current - 1) * PAGE_SIZE + 1}–
            {Math.min(current * PAGE_SIZE, filtered.length)} of {filtered.length}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft />
              Previous
            </Button>
            <span className="font-mono text-xs text-muted-foreground">
              {current} / {pages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={current >= pages}
              onClick={() => setPage(current + 1)}
            >
              Next
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function FragmentRow({
  batchId,
  row,
  columns,
  editable,
  isEditing,
  editableFields,
  pending,
  onEdit,
  onCancel,
  onSave,
}: {
  batchId: string;
  row: GridRow;
  columns: GridColumn[];
  editable: boolean;
  isEditing: boolean;
  editableFields: string[];
  pending: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (formData: FormData) => void;
}) {
  const problems = errorCount(row);

  return (
    <>
      <tr className="border-b align-top transition-colors hover:bg-muted/40">
        <td className="sticky left-0 z-10 bg-card p-2 align-middle whitespace-nowrap">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {row.rowNumber}
            </span>
            {editable && row.status !== "COMMITTED" && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Fix row ${row.rowNumber}`}
                onClick={isEditing ? onCancel : onEdit}
              >
                {isEditing ? <X /> : <PencilLine />}
              </Button>
            )}
          </div>
        </td>

        <td className="p-2 align-middle whitespace-nowrap">
          <span
            className={cn(
              "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
              STATUS_TONE[row.status],
            )}
          >
            {STATUS_LABEL[row.status]}
            {problems > 0 && row.status === "INVALID" && ` · ${problems}`}
          </span>
          {row.lrNumber && (
            <Link
              href={row.shipmentId ? `/shipments/${row.shipmentId}` : "#"}
              className="ml-2 font-mono text-xs text-primary hover:underline"
            >
              {row.lrNumber}
            </Link>
          )}
          {/* A failure that belongs to the row rather than to a cell — a
              booking rejected at the database, say — has no column to sit
              under, so it is shown here instead of vanishing. */}
          {row.errors._row && (
            <span className="mt-1 block max-w-[18rem] whitespace-normal text-[0.7rem] leading-tight text-bad">
              {row.errors._row}
            </span>
          )}
        </td>

        {columns.map((column) => {
          const value = row.cells[column.field] ?? "";
          const error = row.errors[column.field];
          const warning = row.warnings[column.field];

          return (
            <td
              key={column.field}
              title={error ?? warning ?? value}
              className={cn(
                "max-w-[14rem] p-2 align-top",
                error && "bg-bad-muted",
                !error && warning && "bg-warn-muted",
              )}
            >
              <span
                className={cn(
                  "block truncate",
                  value === "" && "text-muted-foreground",
                  error && "text-bad",
                )}
              >
                {value === "" ? "—" : value}
              </span>
              {(error ?? warning) && (
                <span
                  className={cn(
                    "mt-0.5 block whitespace-normal text-[0.7rem] leading-tight",
                    error ? "text-bad" : "text-warn",
                  )}
                >
                  {error ?? warning}
                </span>
              )}
            </td>
          );
        })}
      </tr>

      {isEditing && (
        <tr className="border-b bg-muted/30">
          <td colSpan={columns.length + 2} className="p-4">
            <form action={onSave} className="flex flex-col gap-4">
              <input type="hidden" name="batchId" value={batchId} />
              <input type="hidden" name="rowNumber" value={row.rowNumber} />

              <p className="text-sm text-muted-foreground">
                {editableFields.length === 0
                  ? "Nothing on this row is flagged."
                  : `Correcting row ${row.rowNumber}. Saving re-checks the row against the network.`}
              </p>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {editableFields.map((field) => {
                  const column = columns.find((c) => c.field === field);
                  if (!column) return null;

                  const error = row.errors[field];
                  const fieldId = `fix-${row.rowNumber}-${field}`;

                  return (
                    <div key={field} className="flex flex-col gap-1.5">
                      <Label htmlFor={fieldId}>
                        {column.header}
                        {column.required && <span className="ml-0.5 text-bad">*</span>}
                      </Label>

                      {column.values && column.values.length > 0 ? (
                        <select
                          id={fieldId}
                          name={`cell:${field}`}
                          defaultValue={row.cells[field] ?? ""}
                          className={selectClass}
                        >
                          <option value="">—</option>
                          {column.values.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          id={fieldId}
                          name={`cell:${field}`}
                          defaultValue={row.cells[field] ?? ""}
                          aria-invalid={Boolean(error)}
                        />
                      )}

                      {error && <p className="text-xs text-bad">{error}</p>}
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? <Loader2 className="animate-spin" /> : <Check />}
                  Save and re-check
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
