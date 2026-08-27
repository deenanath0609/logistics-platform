import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  COLUMNS,
  fieldForHeader,
  normaliseHeader,
  type ColumnDef,
} from "./columns";

/**
 * Bulk-upload parsing.
 *
 * Pure: bytes in, rows out. No database, no session, no file system —
 * which is what makes the awkward real-world cases cheap to test, and
 * they are the cases that matter. Two of them show up in almost every
 * customer file:
 *
 *  · a UTF-8 BOM, because the file was saved from Excel on Windows;
 *  · Windows-1252 smart quotes, because the address was pasted from Word
 *    and the file was then saved as "CSV" rather than "CSV UTF-8".
 *
 * Neither is the customer's fault and neither should cost anyone a
 * support call, so both are handled here rather than reported.
 */

export type Encoding = "utf-8" | "utf-8-bom" | "windows-1252" | "xlsx";

export type ParsedRow = {
  /** 1-based position among the data rows of the file. */
  rowNumber: number;
  /** The line the clerk will see in their spreadsheet (header is line 1). */
  sourceLine: number;
  /** Canonical field → trimmed cell text. Unknown columns are dropped. */
  raw: Record<string, string>;
};

export type ParseResult = {
  ok: boolean;
  encoding: Encoding;
  /** Header cells exactly as they appeared in the file. */
  headers: string[];
  /** Canonical fields the headers resolved to, in file order. */
  fields: string[];
  /** Headers of required columns that are not present at all. */
  missingHeaders: string[];
  /** Headers we could not place. Carried, not fatal. */
  unknownHeaders: string[];
  /** Headers naming the same column twice. */
  duplicateHeaders: string[];
  rows: ParsedRow[];
  /** Set when nothing usable could be read at all. */
  error?: string;
};

const BOM = [0xef, 0xbb, 0xbf];

/**
 * The only part of Windows-1252 that differs from Latin-1: bytes 0x80–0x9F.
 *
 * Written out rather than delegated to `TextDecoder("windows-1252")`,
 * which on a Node build without full ICU quietly behaves as Latin-1 and
 * turns a smart apostrophe into U+0092 — a character that then travels all
 * the way to a printed consignment note before anyone notices.
 */
const CP1252_C1 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** Windows-1252 bytes to text. Every byte maps to something. */
export function decodeWindows1252(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out +=
      byte >= 0x80 && byte <= 0x9f
        ? String.fromCharCode(CP1252_C1[byte - 0x80])
        : String.fromCharCode(byte);
  }
  return out;
}

/**
 * Decodes upload bytes to text.
 *
 * UTF-8 is tried strictly first. A file that fails strict UTF-8 is almost
 * always Windows-1252 out of Excel, so it is decoded that way rather than
 * rejected or silently filled with replacement characters — a consignee
 * name reading "O<?>Brien" is a support call.
 */
export function decodeText(bytes: Uint8Array): {
  text: string;
  encoding: Exclude<Encoding, "xlsx">;
} {
  const hasBom =
    bytes.length >= 3 && BOM.every((byte, index) => bytes[index] === byte);
  const body = hasBom ? bytes.subarray(3) : bytes;

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return { text, encoding: hasBom ? "utf-8-bom" : "utf-8" };
  } catch {
    return { text: decodeWindows1252(body), encoding: "windows-1252" };
  }
}

/** True when the bytes are a ZIP container, which is what an .xlsx is. */
export function looksLikeWorkbook(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function isWorkbookName(fileName: string): boolean {
  return /\.(xlsx|xlsm|xlsb|xls)$/i.test(fileName.trim());
}

/** CSV text to a grid of trimmed strings. */
export function parseCsvGrid(text: string): string[][] {
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: false,
    // Let papaparse work out comma vs semicolon vs tab. European Excel
    // writes semicolons and the clerk has no idea that it did.
    delimiter: "",
  });

  return parsed.data.map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => String(cell ?? "").trim()),
  );
}

/** First worksheet of a workbook to a grid of trimmed strings. */
export function parseWorkbookGrid(bytes: Uint8Array): string[][] {
  const workbook = XLSX.read(bytes, { type: "array", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    // Formatted text, so 302001 does not arrive as 302001.0 and a PIN
    // beginning with a zero survives.
    raw: false,
    defval: "",
    blankrows: true,
  });

  return grid.map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => String(cell ?? "").trim()),
  );
}

function isBlankRow(cells: string[]): boolean {
  return cells.every((cell) => cell === "");
}

/**
 * Reads an uploaded CSV or XLSX into canonical rows.
 *
 * Header resolution is forgiving — case, spacing, punctuation and a set of
 * declared aliases all collapse to the same column — but a missing
 * *required* column is reported as a file-level failure rather than as
 * two hundred identical row errors.
 */
export function parseUpload(input: {
  fileName: string;
  bytes: Uint8Array;
}): ParseResult {
  const useWorkbook =
    looksLikeWorkbook(input.bytes) || isWorkbookName(input.fileName);

  let grid: string[][];
  let encoding: Encoding;

  try {
    if (useWorkbook) {
      grid = parseWorkbookGrid(input.bytes);
      encoding = "xlsx";
    } else {
      const decoded = decodeText(input.bytes);
      grid = parseCsvGrid(decoded.text);
      encoding = decoded.encoding;
    }
  } catch (error) {
    return {
      ok: false,
      encoding: useWorkbook ? "xlsx" : "utf-8",
      headers: [],
      fields: [],
      missingHeaders: [],
      unknownHeaders: [],
      duplicateHeaders: [],
      rows: [],
      error:
        error instanceof Error
          ? `The file could not be read: ${error.message}`
          : "The file could not be read.",
    };
  }

  const headerIndex = grid.findIndex((row) => !isBlankRow(row));

  if (headerIndex === -1) {
    return {
      ok: false,
      encoding,
      headers: [],
      fields: [],
      missingHeaders: [],
      unknownHeaders: [],
      duplicateHeaders: [],
      rows: [],
      error: "The file is empty — there is not even a header row.",
    };
  }

  const headers = grid[headerIndex];
  const fields: string[] = [];
  const unknownHeaders: string[] = [];
  const duplicateHeaders: string[] = [];
  const seenFields = new Set<string>();

  for (const header of headers) {
    if (header === "") {
      fields.push("");
      continue;
    }
    const field = fieldForHeader(header);
    if (!field) {
      fields.push("");
      unknownHeaders.push(header);
      continue;
    }
    if (seenFields.has(field)) {
      // Keep the first occurrence: a second column of the same name is
      // usually a leftover from an edit, and the left-most is the one the
      // clerk was looking at.
      fields.push("");
      duplicateHeaders.push(header);
      continue;
    }
    seenFields.add(field);
    fields.push(field);
  }

  const missingHeaders = COLUMNS.filter(
    (column: ColumnDef) => column.required && !seenFields.has(column.field),
  ).map((column) => column.header);

  const rows: ParsedRow[] = [];
  for (let index = headerIndex + 1; index < grid.length; index++) {
    const cells = grid[index];
    const rowNumber = index - headerIndex;

    // Trailing blanks are what a spreadsheet leaves behind, not data. They
    // are skipped without consuming a row number, so the numbers a clerk
    // sees still line up with the lines in their file.
    if (isBlankRow(cells)) continue;

    const raw: Record<string, string> = {};
    for (let column = 0; column < fields.length; column++) {
      const field = fields[column];
      if (!field) continue;
      raw[field] = cells[column] ?? "";
    }

    rows.push({ rowNumber, sourceLine: index + 1, raw });
  }

  if (missingHeaders.length > 0) {
    return {
      ok: false,
      encoding,
      headers,
      fields,
      missingHeaders,
      unknownHeaders,
      duplicateHeaders,
      rows,
      error: `The file is missing ${
        missingHeaders.length === 1 ? "a required column" : "required columns"
      }: ${missingHeaders.join(", ")}.`,
    };
  }

  if (rows.length === 0) {
    return {
      ok: false,
      encoding,
      headers,
      fields,
      missingHeaders,
      unknownHeaders,
      duplicateHeaders,
      rows,
      error: "The file has a header row but no shipments under it.",
    };
  }

  return {
    ok: true,
    encoding,
    headers,
    fields,
    missingHeaders,
    unknownHeaders,
    duplicateHeaders,
    rows,
  };
}

export { normaliseHeader };
