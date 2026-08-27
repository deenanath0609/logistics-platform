/**
 * Pincode import parsing and validation.
 *
 * Pure — no database, no Prisma. The caller supplies the known cities and
 * branches, which makes every rule here testable without a server.
 *
 * Serviceability data is the thing that decides whether a booking is
 * accepted, so a bad import is worse than no import: it would let a clerk
 * book to somewhere the company does not actually deliver. Every row is
 * checked, and a row that fails is reported rather than skipped quietly.
 */

export type ImportContext = {
  /** Lower-cased city name and city code → id. */
  cityByKey: Map<string, string>;
  /** Lower-cased branch code → id. */
  branchByCode: Map<string, string>;
  /** PIN codes already in the database. */
  existing: Set<string>;
};

export type ParsedRow = {
  rowNumber: number;
  code: string;
  city: string;
  area: string | null;
  branch: string | null;
  serviceable: boolean;
  oda: boolean;
};

export type ValidatedRow = ParsedRow & {
  status: "NEW" | "UPDATE" | "INVALID";
  cityId?: string;
  branchId?: string | null;
  errors: Record<string, string>;
};

export const IMPORT_COLUMNS = [
  { key: "pincode", label: "pincode", required: true, example: "302020" },
  { key: "city", label: "city", required: true, example: "Jaipur" },
  { key: "area", label: "area", required: false, example: "Malviya Nagar" },
  { key: "branch", label: "branch", required: false, example: "HUB-JAI" },
  { key: "serviceable", label: "serviceable", required: false, example: "yes" },
  { key: "oda", label: "oda", required: false, example: "no" },
] as const;

/** The header a customer is handed, generated from the same list the parser reads. */
export function templateCsv(): string {
  const header = IMPORT_COLUMNS.map((c) => c.label).join(",");
  const sample = IMPORT_COLUMNS.map((c) => c.example).join(",");
  return `${header}\n${sample}\n`;
}

function normaliseHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

const HEADER_ALIASES: Record<string, string> = {
  pincode: "pincode",
  pin: "pincode",
  pincodeno: "pincode",
  postalcode: "pincode",
  zip: "pincode",
  city: "city",
  cityname: "city",
  location: "city",
  area: "area",
  areaname: "area",
  locality: "area",
  branch: "branch",
  branchcode: "branch",
  servingbranch: "branch",
  deliverybranch: "branch",
  serviceable: "serviceable",
  isserviceable: "serviceable",
  active: "serviceable",
  oda: "oda",
  isoda: "oda",
  outofdeliveryarea: "oda",
};

/** Accepts the spellings people actually type into a spreadsheet. */
function truthy(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "") return fallback;
  return ["y", "yes", "true", "1", "serviceable", "oda"].includes(v);
}

export type ParseResult =
  | { ok: true; rows: ParsedRow[]; headers: string[] }
  | { ok: false; error: string };

/**
 * Parses CSV text. Deliberately not papaparse: this is a small, strict
 * format and the failure messages need to name the column that is wrong.
 */
export function parsePincodeCsv(text: string): ParseResult {
  // Strip a BOM — Excel writes one, and it corrupts the first header.
  const clean = text.replace(/^﻿/, "").trim();
  if (clean === "") return { ok: false, error: "The file is empty." };

  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    return { ok: false, error: "The file has a header but no rows." };
  }

  const delimiter = (lines[0].match(/;/g)?.length ?? 0) >
    (lines[0].match(/,/g)?.length ?? 0)
    ? ";"
    : ",";

  const rawHeaders = splitLine(lines[0], delimiter);
  const headers = rawHeaders.map(
    (h) => HEADER_ALIASES[normaliseHeader(h)] ?? normaliseHeader(h),
  );

  for (const column of IMPORT_COLUMNS) {
    if (column.required && !headers.includes(column.key)) {
      return {
        ok: false,
        error: `The file has no "${column.label}" column. Found: ${rawHeaders.join(", ")}`,
      };
    }
  }

  const rows: ParsedRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delimiter);
    const get = (key: string) => {
      const index = headers.indexOf(key);
      return index === -1 ? undefined : cells[index]?.trim();
    };

    rows.push({
      // +1 for the header, so the number matches what the spreadsheet shows.
      rowNumber: i + 1,
      code: (get("pincode") ?? "").replace(/\D/g, ""),
      city: get("city") ?? "",
      area: get("area") || null,
      branch: get("branch") || null,
      serviceable: truthy(get("serviceable"), true),
      oda: truthy(get("oda"), false),
    });
  }

  return { ok: true, rows, headers };
}

/** Handles quoted cells containing the delimiter. */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

export function validatePincodeRows(
  rows: ParsedRow[],
  context: ImportContext,
): ValidatedRow[] {
  const seenInFile = new Map<string, number>();

  return rows.map((row) => {
    const errors: Record<string, string> = {};

    if (!/^\d{6}$/.test(row.code)) {
      errors.pincode = row.code
        ? `"${row.code}" is not a six-digit PIN code`
        : "PIN code is missing";
    } else {
      const firstSeen = seenInFile.get(row.code);
      if (firstSeen !== undefined) {
        errors.pincode = `Duplicate of row ${firstSeen} in this file`;
      } else {
        seenInFile.set(row.code, row.rowNumber);
      }
    }

    let cityId: string | undefined;
    if (!row.city) {
      errors.city = "City is missing";
    } else {
      cityId = context.cityByKey.get(row.city.trim().toLowerCase());
      if (!cityId) {
        errors.city = `"${row.city}" is not a city in the network`;
      }
    }

    let branchId: string | null = null;
    if (row.branch) {
      const found = context.branchByCode.get(row.branch.trim().toLowerCase());
      if (!found) {
        errors.branch = `"${row.branch}" is not a branch code`;
      } else {
        branchId = found;
      }
    }

    const invalid = Object.keys(errors).length > 0;

    return {
      ...row,
      cityId,
      branchId,
      errors,
      status: invalid
        ? "INVALID"
        : context.existing.has(row.code)
          ? "UPDATE"
          : "NEW",
    };
  });
}

export function summarise(rows: ValidatedRow[]) {
  return {
    total: rows.length,
    create: rows.filter((r) => r.status === "NEW").length,
    update: rows.filter((r) => r.status === "UPDATE").length,
    invalid: rows.filter((r) => r.status === "INVALID").length,
  };
}
