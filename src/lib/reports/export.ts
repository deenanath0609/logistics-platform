import Papa from "papaparse";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/server/services/audit";
import type { SessionUser } from "@/lib/auth/session";
import { describeFilters, filtersToParams, toDayString } from "./filters";
import { exportValue } from "./format";
import type {
  Cell,
  ReportColumn,
  ReportDef,
  ReportFilters,
  ReportResult,
} from "./types";

/**
 * Exporting a report.
 *
 * Two things this file exists to get right.
 *
 * **Nothing loads the whole result set.** The runner is called a page at
 * a time and each page is written straight into the response, so a
 * 40,000-row booking register costs one page of memory rather than
 * forty thousand rows sitting in the heap while the sheet is assembled.
 * XLSX is the exception — the format has to be built whole — so it has a
 * lower ceiling and says so rather than falling over at 200MB.
 *
 * **Every export leaves a trail.** `report.export` is a sensitive
 * permission because a CSV of every customer's consignments is exactly
 * the file that walks out of a company. `ReportRun` records what was
 * taken, by whom, with which filters; the audit log records that it
 * happened at all.
 */

export type ExportFormat = "csv" | "xlsx";

/** Rows fetched per page while streaming. Large enough to be cheap. */
const EXPORT_PAGE = 1_000;

/** Ceiling on a streamed CSV. Beyond this, the answer is a filter. */
export const MAX_CSV_ROWS = 100_000;

/**
 * Ceiling on XLSX, which cannot stream: the whole workbook is built in
 * memory before a byte goes out. Half the CSV limit, deliberately.
 */
export const MAX_XLSX_ROWS = 50_000;

export function exportLimit(format: ExportFormat): number {
  return format === "xlsx" ? MAX_XLSX_ROWS : MAX_CSV_ROWS;
}

// ────────────────────────────────────────────────────────────
// The trail
// ────────────────────────────────────────────────────────────

/**
 * Opens the record before a single byte is written.
 *
 * Recorded up front rather than on completion: an export that was
 * interrupted halfway still put rows on somebody's disk, and a trail that
 * only logs clean finishes is a trail that misses exactly the case worth
 * investigating.
 */
export async function beginReportRun(input: {
  report: ReportDef;
  filters: ReportFilters;
  format: ExportFormat;
  expectedRows: number;
  user: SessionUser;
}): Promise<string> {
  const run = await prisma.reportRun.create({
    data: {
      // From the exporting user rather than a fresh tenant resolution: it is
      // the same value, and the extension rejects the write outright if it
      // ever stops being.
      orgId: input.user.orgId,
      reportKey: input.report.key,
      filters: filtersToParams(input.filters),
      format: input.format,
      rowCount: input.expectedRows,
      userId: input.user.id,
    },
    select: { id: true },
  });

  await recordAudit({
    user: input.user,
    action: "EXPORT",
    entity: "Report",
    entityId: run.id,
    entityRef: input.report.key,
    after: {
      format: input.format,
      rows: input.expectedRows,
      filters: filtersToParams(input.filters),
    },
    reason: `Exported ${input.report.title}`,
  });

  return run.id;
}

export async function finishReportRun(
  runId: string,
  rowCount: number,
  durationMs: number,
): Promise<void> {
  try {
    await prisma.reportRun.update({
      where: { id: runId },
      data: { rowCount, durationMs },
    });
  } catch (error) {
    // The export has already reached the user; failing here would only
    // corrupt a download that has otherwise worked.
    console.error("[reports] could not close the run record", error);
  }
}

// ────────────────────────────────────────────────────────────
// Shaping
// ────────────────────────────────────────────────────────────

/** Columns that actually go into a file. Links and pills do not. */
export function exportColumns(columns: ReportColumn[]): ReportColumn[] {
  return columns.filter((column) => column.exportable !== false);
}

function rowValues(cells: Record<string, Cell>, columns: ReportColumn[]) {
  return columns.map((column) => exportValue(cells[column.key] ?? null));
}

export function filename(
  report: ReportDef,
  filters: ReportFilters,
  format: ExportFormat,
): string {
  return `${report.key}_${toDayString(filters.from)}_${toDayString(filters.to)}.${format}`;
}

// ────────────────────────────────────────────────────────────
// CSV
// ────────────────────────────────────────────────────────────

/**
 * A streamed CSV.
 *
 * The BOM is not decoration: without it Excel on Windows opens a UTF-8
 * CSV as Windows-1252 and turns every consignee's name with a rupee sign
 * or an accented character into mojibake. The same problem, from the
 * other direction, is handled in `src/lib/bulk/parse.ts`.
 */
export function streamCsv(input: {
  report: ReportDef;
  filters: ReportFilters;
  user: SessionUser;
  first: ReportResult;
  runId: string;
}): ReadableStream<Uint8Array> {
  const columns = exportColumns(input.first.columns);
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  let page = 1;
  let written = 0;
  let done = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("﻿"));
      controller.enqueue(
        encoder.encode(
          Papa.unparse([columns.map((column) => column.label)], {
            newline: "\r\n",
          }) + "\r\n",
        ),
      );
    },

    async pull(controller) {
      if (done) return;

      try {
        const result =
          page === 1
            ? input.first
            : await input.report.run({
                user: input.user,
                filters: input.filters,
                page,
                pageSize: EXPORT_PAGE,
              });

        if (result.rows.length === 0 || written >= MAX_CSV_ROWS) {
          done = true;
          controller.close();
          await finishReportRun(input.runId, written, Date.now() - startedAt);
          return;
        }

        const slice = result.rows.slice(0, MAX_CSV_ROWS - written);

        controller.enqueue(
          encoder.encode(
            Papa.unparse(
              slice.map((row) => rowValues(row.cells, columns)),
              { newline: "\r\n" },
            ) + "\r\n",
          ),
        );

        written += slice.length;
        page++;

        if (slice.length < EXPORT_PAGE) {
          done = true;
          controller.close();
          await finishReportRun(input.runId, written, Date.now() - startedAt);
        }
      } catch (error) {
        done = true;
        controller.error(error);
      }
    },
  });
}

/**
 * The first page, fetched at export page size.
 *
 * Pulled out so the route can check the row count and refuse politely
 * before opening a stream it would only have to abort.
 */
export async function firstExportPage(
  report: ReportDef,
  filters: ReportFilters,
  user: SessionUser,
): Promise<ReportResult> {
  return report.run({ user, filters, page: 1, pageSize: EXPORT_PAGE });
}

// ────────────────────────────────────────────────────────────
// XLSX
// ────────────────────────────────────────────────────────────

/**
 * A workbook, built whole.
 *
 * Two sheets: the data, and the filters that produced it. The second one
 * matters more than it looks — a spreadsheet emailed round a management
 * meeting with no record of its date range is a spreadsheet three people
 * will read three different ways.
 */
export async function buildXlsx(input: {
  report: ReportDef;
  filters: ReportFilters;
  user: SessionUser;
  first: ReportResult;
  runId: string;
  describe: string;
}): Promise<{ buffer: Uint8Array; rowCount: number }> {
  const startedAt = Date.now();
  const columns = exportColumns(input.first.columns);

  const values: Array<Array<string | number>> = [
    columns.map((column) => column.label),
  ];

  let page = 1;
  let result = input.first;

  for (;;) {
    for (const row of result.rows) {
      if (values.length - 1 >= MAX_XLSX_ROWS) break;
      values.push(rowValues(row.cells, columns));
    }

    if (
      result.rows.length < EXPORT_PAGE ||
      values.length - 1 >= MAX_XLSX_ROWS
    ) {
      break;
    }

    page++;
    result = await input.report.run({
      user: input.user,
      filters: input.filters,
      page,
      pageSize: EXPORT_PAGE,
    });
  }

  if (input.first.totals) {
    values.push(
      columns.map((column) => exportValue(input.first.totals?.[column.key] ?? null)),
    );
  }

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(values);

  // Column widths from the header, so nothing opens as "####".
  sheet["!cols"] = columns.map((column) => ({
    wch: Math.max(12, Math.min(40, column.label.length + 4)),
  }));

  XLSX.utils.book_append_sheet(workbook, sheet, "Data");

  const about = XLSX.utils.aoa_to_sheet([
    ["Report", input.report.title],
    ["Filters", input.describe],
    ["Rows", values.length - 1],
    ["Run by", input.user.name],
    ["Run at", new Date().toISOString()],
    ...(input.first.unavailable ? [["Note", input.first.unavailable]] : []),
    ...(input.first.note ? [["Note", input.first.note]] : []),
  ]);
  about["!cols"] = [{ wch: 14 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(workbook, about, "About");

  const buffer = XLSX.write(workbook, {
    bookType: "xlsx",
    type: "array",
  }) as ArrayBuffer;

  const rowCount = values.length - 1;
  await finishReportRun(input.runId, rowCount, Date.now() - startedAt);

  return { buffer: new Uint8Array(buffer), rowCount };
}

/** The filter sentence written into the workbook and the CSV filename. */
export function describeForExport(filters: ReportFilters): string {
  return describeFilters(filters);
}
