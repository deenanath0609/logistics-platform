import { getCurrentUser } from "@/lib/auth/session";
import { parseFilters, describeFilters } from "@/lib/reports/filters";
import { reportFor } from "@/lib/reports/registry";
import {
  beginReportRun,
  buildXlsx,
  filename,
  firstExportPage,
  streamCsv,
  type ExportFormat,
} from "@/lib/reports/export";

export const dynamic = "force-dynamic";

/**
 * Downloading a report.
 *
 * `report.export` is a sensitive permission and it is checked here as
 * well as on the page — the download is a URL, and a URL gets pasted into
 * a chat window. Every export writes a `ReportRun` row and an audit
 * entry before a byte leaves, because a CSV of every customer's
 * consignments is exactly the file that walks out of a company, and a
 * trail written only on success misses the interesting cases.
 *
 * CSV streams a page at a time. XLSX cannot — the format is built whole —
 * so it carries a lower ceiling and says so rather than falling over on a
 * 200MB workbook.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await context.params;
  const report = reportFor(key);
  if (!report) return new Response("No such report", { status: 404 });

  const user = await getCurrentUser();
  if (!user) return new Response("Not signed in", { status: 401 });

  if (!user.permissions.has(report.permission)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (!user.permissions.has("report.export")) {
    return new Response(
      "Exporting report data in bulk needs the report.export permission.",
      { status: 403 },
    );
  }

  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const format: ExportFormat = params.format === "xlsx" ? "xlsx" : "csv";
  const filters = parseFilters(params);

  const first = await firstExportPage(report, filters, user);

  if (first.unavailable) {
    return new Response(first.unavailable, { status: 409 });
  }

  const runId = await beginReportRun({
    report,
    filters,
    format,
    expectedRows: first.total,
    user,
  });

  const name = filename(report, filters, format);

  if (format === "xlsx") {
    const { buffer } = await buildXlsx({
      report,
      filters,
      user,
      first,
      runId,
      describe: describeFilters(filters),
    });

    return new Response(buffer as BodyInit, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(streamCsv({ report, filters, user, first, runId }), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
      // Length is unknown while streaming; saying so stops a proxy
      // buffering the whole file to work it out.
      "Transfer-Encoding": "chunked",
    },
  });
}
