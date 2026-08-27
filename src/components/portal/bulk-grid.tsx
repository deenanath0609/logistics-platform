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
import { selectClass } from "@/components/portal/form";
import {
  savePortalBulkRow,
  type BulkState,
} from "@/app/(portal)/portal/(app)/bulk/actions";

/**
 * The marked-up grid, built for a phone.
 *
 * The operations version of this screen is a wide table with a sticky row
 * column, which is right for a clerk at a desk with twenty-five columns to
 * compare. A customer correcting their own file is as likely to be doing
 * it standing in a warehouse, and a twenty-five column table at 375px is
 * a horizontal scrollbar with a spreadsheet hidden behind it.
 *
 * So each row is a card, and — this is the part that matters — a card in
 * error shows *only the cells that are wrong*, with the reason attached to
 * each one. That is the whole feature: see which cell is wrong, fix it
 * where it stands, without downloading an error report and reconciling it
 * against your own spreadsheet by row number.
 */

export type PortalGridColumn = {
  field: string;
  header: string;
  required: boolean;
  kind: string;
  values?: string[];
};

export type PortalGridRowView = {
  rowNumber: number;
  status: "PENDING" | "VALID" | "INVALID" | "COMMITTED" | "SKIPPED";
  cells: Record<string, string>;
  errors: Record<string, string>;
  warnings: Record<string, string>;
  lrNumber: string | null;
  shipmentId: string | null;
};

type Filter = "errors" | "ready" | "booked" | "all";

const PAGE_SIZE = 25;
const IDLE: BulkState = {};

const STATUS_TONE: Record<PortalGridRowView["status"], string> = {
  PENDING: "bg-muted text-muted-foreground",
  VALID: "bg-accent text-accent-foreground",
  INVALID: "bg-bad-muted text-bad",
  COMMITTED: "bg-ok-muted text-ok",
  SKIPPED: "bg-muted text-muted-foreground",
};

const STATUS_LABEL: Record<PortalGridRowView["status"], string> = {
  PENDING: "Checking",
  VALID: "Ready",
  INVALID: "Needs fixing",
  COMMITTED: "Booked",
  SKIPPED: "Skipped",
};

/** A one-line description of the consignment, for the card header. */
function describe(row: PortalGridRowView): string {
  const to = row.cells.consigneeName?.trim();
  const pin = row.cells.consigneePincode?.trim();
  const parts = [to || "Consignee not given", pin].filter(Boolean);
  return parts.join(" · ");
}

export function PortalBulkGrid({
  batchId,
  columns,
  rows,
  editable,
}: {
  batchId: string;
  columns: PortalGridColumn[];
  rows: PortalGridRowView[];
  editable: boolean;
}) {
  const invalidCount = rows.filter((row) => row.status === "INVALID").length;

  // Land on the rows that need work. Somebody opening a checked file is
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

  const counts = {
    all: rows.length,
    errors: invalidCount,
    ready: rows.filter((row) => row.status === "VALID").length,
    booked: rows.filter((row) => row.status === "COMMITTED").length,
  };

  function choose(next: Filter) {
    setFilter(next);
    setPage(1);
    setEditing(null);
  }

  function save(formData: FormData) {
    startTransition(async () => {
      const result = await savePortalBulkRow(IDLE, formData);
      if (result.ok) {
        toast.success(result.message ?? "Row updated.");
        setEditing(null);
      } else {
        toast.error(result.error ?? "That correction could not be saved.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
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
          Show every column when editing
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          Nothing in this view.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((row) => {
            const isEditing = editing === row.rowNumber;
            const failing = Object.keys(row.errors);
            const fields = allFields
              ? columns
              : columns.filter(
                  (column) =>
                    failing.includes(column.field) ||
                    Object.keys(row.warnings).includes(column.field),
                );

            return (
              <li key={row.rowNumber} className="rounded-lg border bg-card">
                <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
                  <span className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground">
                    Row {row.rowNumber}
                  </span>
                  <span
                    className={cn(
                      "rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider",
                      STATUS_TONE[row.status],
                    )}
                  >
                    {STATUS_LABEL[row.status]}
                  </span>
                  {row.lrNumber && (
                    <Link
                      href={
                        row.shipmentId
                          ? `/portal/shipments/${row.shipmentId}`
                          : `/portal/shipments?q=${encodeURIComponent(row.lrNumber)}`
                      }
                      className="font-mono text-xs underline underline-offset-4"
                    >
                      {row.lrNumber}
                    </Link>
                  )}

                  <span className="ml-auto flex items-center gap-2">
                    {editable && row.status !== "COMMITTED" && (
                      <Button
                        size="xs"
                        variant={isEditing ? "ghost" : "outline"}
                        onClick={() =>
                          setEditing(isEditing ? null : row.rowNumber)
                        }
                      >
                        {isEditing ? <X /> : <PencilLine />}
                        {isEditing ? "Cancel" : "Fix"}
                      </Button>
                    )}
                  </span>
                </div>

                <div className="flex flex-col gap-2 px-3 py-2.5">
                  <p className="text-sm font-medium text-pretty">{describe(row)}</p>

                  {failing.length > 0 && !isEditing && (
                    <ul className="flex flex-col gap-1">
                      {failing.map((field) => (
                        <li
                          key={field}
                          className="flex flex-wrap items-baseline gap-x-2 text-xs"
                        >
                          <span className="font-medium text-bad">
                            {columns.find((c) => c.field === field)?.header ??
                              field}
                          </span>
                          <span className="text-bad">{row.errors[field]}</span>
                          {row.cells[field] && (
                            <span className="font-mono text-muted-foreground">
                              &ldquo;{row.cells[field]}&rdquo;
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {Object.keys(row.warnings).length > 0 && !isEditing && (
                    <ul className="flex flex-col gap-1">
                      {Object.entries(row.warnings).map(([field, message]) => (
                        <li key={field} className="text-xs text-warn">
                          {columns.find((c) => c.field === field)?.header ?? field}
                          : {message}
                        </li>
                      ))}
                    </ul>
                  )}

                  {isEditing && (
                    <form action={save} className="flex flex-col gap-3 pt-1">
                      <input type="hidden" name="batchId" value={batchId} />
                      <input
                        type="hidden"
                        name="rowNumber"
                        value={row.rowNumber}
                      />

                      {fields.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Nothing is wrong with this row. Tick &ldquo;show every
                          column&rdquo; above to change it anyway.
                        </p>
                      ) : (
                        <div className="grid gap-3 sm:grid-cols-2">
                          {fields.map((column) => {
                            const id = `${row.rowNumber}-${column.field}`;
                            const error = row.errors[column.field];

                            return (
                              <div
                                key={column.field}
                                className="flex flex-col gap-1.5"
                              >
                                <Label htmlFor={id}>
                                  {column.header}
                                  {column.required && (
                                    <span className="ml-0.5 text-bad">*</span>
                                  )}
                                </Label>

                                {column.values ? (
                                  <select
                                    id={id}
                                    name={`cell:${column.field}`}
                                    className={selectClass}
                                    defaultValue={row.cells[column.field] ?? ""}
                                  >
                                    <option value="">—</option>
                                    {column.values.map((value) => (
                                      <option key={value} value={value}>
                                        {value}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <Input
                                    id={id}
                                    name={`cell:${column.field}`}
                                    defaultValue={row.cells[column.field] ?? ""}
                                    aria-invalid={Boolean(error)}
                                    inputMode={
                                      column.kind === "int" ||
                                      column.kind === "decimal" ||
                                      column.kind === "money" ||
                                      column.kind === "pincode" ||
                                      column.kind === "phone"
                                        ? "numeric"
                                        : undefined
                                    }
                                  />
                                )}

                                {error && (
                                  <p className="text-xs text-bad">{error}</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <Button type="submit" size="sm" disabled={pending}>
                          {pending ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Check />
                          )}
                          Save row
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Page {current} of {pages} · {filtered.length} rows
          </p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft />
              Back
            </Button>
            <Button
              size="sm"
              variant="outline"
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
