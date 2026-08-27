import Link from "next/link";
import { Info } from "lucide-react";
import { formatDuration } from "@/lib/sla/policy";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Cell, ReportColumn, ReportResult, ReportRow } from "@/lib/reports/types";

/**
 * One table for the whole report library.
 *
 * A server component: the rows are already the right page, so there is
 * nothing here for the browser to do that the server has not done
 * already. Nineteen bespoke tables would be nineteen places for the
 * money column to drift out of alignment.
 */

const TONE_CLASS: Record<string, string> = {
  ok: "bg-ok-muted text-ok",
  warn: "bg-warn-muted text-warn",
  bad: "bg-bad-muted text-bad",
  info: "bg-info-muted text-info",
  muted: "bg-muted text-muted-foreground",
};

const TEXT_TONE: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  info: "text-info",
  muted: "text-muted-foreground",
};

const NUMERIC = new Set(["number", "money", "weight", "percent", "duration"]);

function isNumeric(column: ReportColumn): boolean {
  return NUMERIC.has(column.type ?? "text");
}

/** Rupees, grouped the Indian way: 12,34,567.00. */
const RUPEES = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const PLAIN = new Intl.NumberFormat("en-IN");

function render(cell: Cell, column: ReportColumn): string {
  // An em dash, never a zero. "Nothing to show" and "zero" are different
  // facts and a report that conflates them is a report that misleads.
  if (cell === null || cell === undefined || cell === "") return "—";

  switch (column.type) {
    case "money":
      return typeof cell === "number" ? `₹${RUPEES.format(cell)}` : String(cell);
    case "weight":
      return typeof cell === "number" ? `${PLAIN.format(cell)}` : String(cell);
    case "percent":
      return typeof cell === "number" ? `${cell.toFixed(1)}%` : String(cell);
    case "duration":
      return typeof cell === "number"
        ? cell < 0
          ? `${formatDuration(cell)} early`
          : formatDuration(cell)
        : String(cell);
    case "number":
      return typeof cell === "number" ? PLAIN.format(cell) : String(cell);
    default:
      return String(cell);
  }
}

function CellBody({
  row,
  column,
  isFirst,
}: {
  row: ReportRow;
  column: ReportColumn;
  isFirst: boolean;
}) {
  const value = row.cells[column.key] ?? null;
  const text = render(value, column);

  if (column.type === "state" && value !== null) {
    const tone = row.tones?.[column.key] ?? "muted";
    return (
      <span
        className={cn(
          "inline-block whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider",
          TONE_CLASS[tone],
        )}
      >
        {text}
      </span>
    );
  }

  // Written out rather than interpolated: Tailwind scans source text, so
  // a class built from a variable never reaches the stylesheet.
  const numericTone = row.tones?.[column.key];
  const className = cn(
    column.type === "code" && "font-mono text-xs",
    isNumeric(column) && "tabular",
    numericTone && TEXT_TONE[numericTone],
  );

  if (isFirst && row.href) {
    return (
      <Link
        href={row.href}
        className={cn(className, "font-medium underline-offset-4 hover:underline")}
      >
        {text}
      </Link>
    );
  }

  return <span className={className}>{text}</span>;
}

export function ReportTable({ result }: { result: ReportResult }) {
  if (result.unavailable) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/40 px-4 py-4">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Not available yet</p>
          <p className="max-w-prose text-sm text-muted-foreground">
            {result.unavailable}
          </p>
        </div>
      </div>
    );
  }

  if (result.rows.length === 0) {
    return (
      <TableFrame>
        <EmptyState
          title="Nothing in this window"
          description="No record matches these filters. Widen the date range or clear a filter."
        />
      </TableFrame>
    );
  }

  const width = Math.max(720, result.columns.length * 130);

  return (
    <div className="flex flex-col gap-3">
      <TableFrame>
        <Table style={{ minWidth: `${width}px` }}>
          <TableHeader>
            <TableRow>
              {result.columns.map((column) => (
                <TableHead
                  key={column.key}
                  className={isNumeric(column) ? "text-right" : undefined}
                >
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((row) => (
              <TableRow key={row.key}>
                {result.columns.map((column, index) => (
                  <TableCell
                    key={column.key}
                    className={cn(
                      isNumeric(column) && "text-right",
                      column.type === "code" && "whitespace-nowrap",
                    )}
                  >
                    <CellBody row={row} column={column} isFirst={index === 0} />
                  </TableCell>
                ))}
              </TableRow>
            ))}

            {result.totals && (
              <TableRow className="border-t-2 bg-muted/40 font-medium">
                {result.columns.map((column, index) => {
                  const value = result.totals?.[column.key] ?? null;
                  return (
                    <TableCell
                      key={column.key}
                      className={cn(isNumeric(column) && "text-right tabular")}
                    >
                      {index === 0 && value === null
                        ? "Total"
                        : value === null
                          ? ""
                          : render(value, column)}
                    </TableCell>
                  );
                })}
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableFrame>

      {result.note && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span className="max-w-prose">{result.note}</span>
        </p>
      )}
    </div>
  );
}
