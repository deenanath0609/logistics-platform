import { COLUMNS } from "./columns";

/**
 * The downloadable template.
 *
 * Generated from the same column declaration the validator reads, so the
 * file we hand a customer and the file we are prepared to accept cannot
 * drift apart. The usual failure mode — a template checked into `public/`
 * that stopped matching the parser two releases ago — is not available
 * here, because there is no second copy to go stale.
 */

export const TEMPLATE_FILENAME = "city-logistics-bulk-booking-template.csv";

/** RFC 4180 quoting: always quote, double any embedded quote. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Header row plus one worked example.
 *
 * The example is not decoration — a clerk copying the row below the header
 * gets the date-free, code-based spellings right first time, which is most
 * of what goes wrong in a first upload.
 */
export function buildTemplateCsv(): string {
  const header = COLUMNS.map((column) => csvCell(column.header)).join(",");
  const example = COLUMNS.map((column) => csvCell(column.example)).join(",");

  // Excel on Windows reads a BOM-less UTF-8 CSV as Windows-1252 and
  // mangles every non-ASCII character in it. The BOM costs three bytes.
  return `﻿${header}\r\n${example}\r\n`;
}

/** Column reference for the upload screen, in template order. */
export function templateColumnHelp(): Array<{
  header: string;
  required: boolean;
  help: string;
  example: string;
}> {
  return COLUMNS.map((column) => ({
    header: column.header,
    required: column.required,
    help: column.help,
    example: column.example,
  }));
}
