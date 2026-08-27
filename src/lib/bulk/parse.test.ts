import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { COLUMNS, TEMPLATE_HEADERS, fieldForHeader } from "./columns";
import { decodeText, looksLikeWorkbook, parseUpload } from "./parse";
import { buildTemplateCsv } from "./template";

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

const GOOD: Record<string, string> = {
  serviceTypeCode: "PTL-STD",
  originBranchCode: "DEL",
  destinationBranchCode: "JAI",
  consignorName: "Ramesh Traders",
  consignorPhone: "9876543210",
  consignorAddress: "14 Naraina Industrial Area",
  consignorPincode: "110028",
  consigneeName: "Sharma Distributors",
  consigneePhone: "9812345670",
  consigneeAddress: "Shop 22 MI Road",
  consigneePincode: "302001",
  packageCount: "3",
  actualWeight: "48.5",
  goodsDescription: "Auto spare parts",
  paymentType: "PAID",
};

function csvText(
  rows: Array<Record<string, string>>,
  headers: readonly string[] = TEMPLATE_HEADERS,
): string {
  const fields = headers.map((header) => fieldForHeader(header));
  const line = (cells: string[]) =>
    cells.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",");

  return [
    line([...headers]),
    ...rows.map((row) =>
      line(fields.map((field) => (field ? (row[field] ?? "") : ""))),
    ),
  ].join("\r\n");
}

function utf8(text: string, withBom = false): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!withBom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

/** Enough of Windows-1252 to write what Word actually pastes into a CSV. */
const CP1252_HIGH: Record<string, number> = {
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "–": 0x96,
  "—": 0x97,
  "€": 0x80,
};

function windows1252(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const high = CP1252_HIGH[char];
    if (high !== undefined) {
      out.push(high);
      continue;
    }
    const code = char.codePointAt(0)!;
    if (code > 0xff) throw new Error(`not representable in cp1252: ${char}`);
    out.push(code);
  }
  return new Uint8Array(out);
}

// ────────────────────────────────────────────────────────────

describe("decodeText", () => {
  it("strips a UTF-8 BOM and says so", () => {
    const result = decodeText(utf8("Service Code,Origin Branch", true));
    expect(result.encoding).toBe("utf-8-bom");
    expect(result.text.startsWith("Service Code")).toBe(true);
    expect(result.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("reads plain UTF-8 unchanged", () => {
    const result = decodeText(utf8("Rameshji — Delhi"));
    expect(result.encoding).toBe("utf-8");
    expect(result.text).toBe("Rameshji — Delhi");
  });

  it("falls back to Windows-1252 rather than producing replacement characters", () => {
    const result = decodeText(windows1252("O’Brien “Gate 4”"));
    expect(result.encoding).toBe("windows-1252");
    expect(result.text).toBe("O’Brien “Gate 4”");
    expect(result.text).not.toContain("�");
  });
});

describe("looksLikeWorkbook", () => {
  it("recognises the ZIP container an xlsx really is", () => {
    expect(looksLikeWorkbook(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(looksLikeWorkbook(utf8("Service Code,Origin"))).toBe(false);
  });
});

describe("parseUpload — a clean file", () => {
  const result = parseUpload({
    fileName: "bookings.csv",
    bytes: utf8(csvText([GOOD, { ...GOOD, consigneeName: "Second Consignee" }])),
  });

  it("parses without a file-level error", () => {
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.missingHeaders).toEqual([]);
    expect(result.unknownHeaders).toEqual([]);
  });

  it("returns one row per data line, numbered from one", () => {
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.rowNumber)).toEqual([1, 2]);
    // Line 1 is the header, so row 1 is line 2 of the file.
    expect(result.rows.map((r) => r.sourceLine)).toEqual([2, 3]);
  });

  it("keys cells by canonical field, not by the header text", () => {
    expect(result.rows[0].raw.consigneePincode).toBe("302001");
    expect(result.rows[1].raw.consigneeName).toBe("Second Consignee");
  });
});

describe("parseUpload — headers as customers actually write them", () => {
  it("matches on case, spacing, punctuation and declared aliases", () => {
    const headers = TEMPLATE_HEADERS.map((header) => {
      if (header === "Consignee PIN") return "delivery_pincode";
      if (header === "Packages") return "  PCS  ";
      if (header === "Actual Weight (kg)") return "GROSS WEIGHT";
      return header.toUpperCase();
    });

    const result = parseUpload({
      fileName: "odd-headers.csv",
      bytes: utf8(csvText([GOOD], headers)),
    });

    expect(result.ok).toBe(true);
    expect(result.rows[0].raw.consigneePincode).toBe("302001");
    expect(result.rows[0].raw.packageCount).toBe("3");
    expect(result.rows[0].raw.actualWeight).toBe("48.5");
  });

  it("carries an unrecognised column without failing the file", () => {
    const result = parseUpload({
      fileName: "extra.csv",
      bytes: utf8(csvText([GOOD], [...TEMPLATE_HEADERS, "Internal Batch Ref"])),
    });

    expect(result.ok).toBe(true);
    expect(result.unknownHeaders).toEqual(["Internal Batch Ref"]);
  });

  it("keeps the left-most of a column named twice", () => {
    const result = parseUpload({
      fileName: "dupe-header.csv",
      bytes: utf8(csvText([GOOD], [...TEMPLATE_HEADERS, "Packages"])),
    });

    expect(result.duplicateHeaders).toEqual(["Packages"]);
    expect(result.rows[0].raw.packageCount).toBe("3");
  });
});

describe("parseUpload — a file with a missing header column", () => {
  const headers = TEMPLATE_HEADERS.filter(
    (header) => header !== "Consignee PIN" && header !== "Payment Type",
  );
  const result = parseUpload({
    fileName: "short.csv",
    bytes: utf8(csvText([GOOD, GOOD], headers)),
  });

  it("fails the file rather than every row in it", () => {
    expect(result.ok).toBe(false);
    expect(result.missingHeaders).toEqual(["Consignee PIN", "Payment Type"]);
  });

  it("names the missing columns in the message", () => {
    expect(result.error).toContain("Consignee PIN");
    expect(result.error).toContain("Payment Type");
  });

  it("still returns the rows it could read, so the clerk can see the file", () => {
    expect(result.rows).toHaveLength(2);
  });
});

describe("parseUpload — empty files", () => {
  it("reports a file with nothing in it", () => {
    const result = parseUpload({ fileName: "empty.csv", bytes: utf8("") });
    expect(result.ok).toBe(false);
    expect(result.rows).toEqual([]);
    expect(result.error).toContain("empty");
  });

  it("reports a file with only whitespace lines", () => {
    const result = parseUpload({ fileName: "blank.csv", bytes: utf8("\r\n\r\n\r\n") });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("distinguishes a header with no shipments under it", () => {
    const result = parseUpload({
      fileName: "header-only.csv",
      bytes: utf8(csvText([])),
    });
    expect(result.ok).toBe(false);
    expect(result.missingHeaders).toEqual([]);
    expect(result.error).toContain("no shipments");
  });
});

describe("parseUpload — spreadsheet leftovers", () => {
  it("skips trailing blank rows without consuming a row number", () => {
    const result = parseUpload({
      fileName: "trailing.csv",
      bytes: utf8(`${csvText([GOOD, GOOD])}\r\n,,,,,\r\n,,,,,\r\n`),
    });

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.rowNumber)).toEqual([1, 2]);
  });

  it("keeps row numbers aligned to the file when a middle row is blank", () => {
    const rows = csvText([GOOD, GOOD, GOOD]).split("\r\n");
    const withGap = [rows[0], rows[1], ",,,,,", rows[2], rows[3]].join("\r\n");

    const result = parseUpload({ fileName: "gap.csv", bytes: utf8(withGap) });

    expect(result.rows.map((r) => r.rowNumber)).toEqual([1, 3, 4]);
    expect(result.rows.map((r) => r.sourceLine)).toEqual([2, 4, 5]);
  });
});

describe("parseUpload — real-world encodings", () => {
  it("reads a file saved from Excel with a UTF-8 BOM", () => {
    const result = parseUpload({
      fileName: "bom.csv",
      bytes: utf8(csvText([{ ...GOOD, consigneeName: "Café Vora" }]), true),
    });

    expect(result.ok).toBe(true);
    expect(result.encoding).toBe("utf-8-bom");
    // The BOM must not become part of the first header, or the first
    // column silently stops matching.
    expect(result.rows[0].raw.serviceTypeCode).toBe("PTL-STD");
    expect(result.rows[0].raw.consigneeName).toBe("Café Vora");
  });

  it("reads Windows-1252 smart quotes pasted out of Word", () => {
    const text = csvText([
      {
        ...GOOD,
        consigneeName: "O’Brien & Sons",
        consigneeAddress: "Gate 4 – “Blue Shed”",
      },
    ]);

    const result = parseUpload({
      fileName: "word.csv",
      bytes: windows1252(text),
    });

    expect(result.ok).toBe(true);
    expect(result.encoding).toBe("windows-1252");
    expect(result.rows[0].raw.consigneeName).toBe("O’Brien & Sons");
    expect(result.rows[0].raw.consigneeAddress).toBe(
      "Gate 4 – “Blue Shed”",
    );
  });

  it("handles a BOM and smart quotes in the same file", () => {
    const body = windows1252(
      csvText([{ ...GOOD, consigneeName: "O’Brien" }]),
    );
    const bytes = new Uint8Array(body.length + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(body, 3);

    const result = parseUpload({ fileName: "both.csv", bytes });

    // The BOM claims UTF-8 and the body is not: the bytes win.
    expect(result.ok).toBe(true);
    expect(result.rows[0].raw.serviceTypeCode).toBe("PTL-STD");
    expect(result.rows[0].raw.consigneeName).toBe("O’Brien");
  });

  it("reads semicolon-separated CSV from a European Excel", () => {
    const semicolons = csvText([GOOD])
      .split("\r\n")
      .map((line) => line.replace(/","/g, '";"'))
      .join("\r\n");

    const result = parseUpload({ fileName: "eu.csv", bytes: utf8(semicolons) });

    expect(result.ok).toBe(true);
    expect(result.rows[0].raw.consigneePincode).toBe("302001");
  });
});

describe("parseUpload — XLSX", () => {
  function workbookBytes(rows: Array<Record<string, string>>): Uint8Array {
    const grid = [
      [...TEMPLATE_HEADERS],
      ...rows.map((row) =>
        TEMPLATE_HEADERS.map((header) => {
          const field = fieldForHeader(header);
          return field ? (row[field] ?? "") : "";
        }),
      ),
    ];
    const sheet = XLSX.utils.aoa_to_sheet(grid);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Bookings");
    return new Uint8Array(
      XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as ArrayBuffer,
    );
  }

  it("reads the first worksheet", () => {
    const result = parseUpload({
      fileName: "bookings.xlsx",
      bytes: workbookBytes([GOOD, { ...GOOD, packageCount: "9" }]),
    });

    expect(result.ok).toBe(true);
    expect(result.encoding).toBe("xlsx");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1].raw.packageCount).toBe("9");
  });

  it("keeps a PIN that begins with a zero as text", () => {
    const result = parseUpload({
      fileName: "leading-zero.xlsx",
      bytes: workbookBytes([{ ...GOOD, consigneePincode: "078001" }]),
    });

    expect(result.rows[0].raw.consigneePincode).toBe("078001");
  });

  it("detects a workbook even when the file is named .csv", () => {
    const result = parseUpload({
      fileName: "mislabelled.csv",
      bytes: workbookBytes([GOOD]),
    });

    expect(result.ok).toBe(true);
    expect(result.encoding).toBe("xlsx");
  });
});

describe("the template", () => {
  it("round-trips through the parser it was generated for", () => {
    const result = parseUpload({
      fileName: "template.csv",
      bytes: utf8(buildTemplateCsv()),
    });

    expect(result.missingHeaders).toEqual([]);
    expect(result.unknownHeaders).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
  });

  it("carries a column for every declared field", () => {
    expect(TEMPLATE_HEADERS).toHaveLength(COLUMNS.length);
    for (const column of COLUMNS) {
      expect(fieldForHeader(column.header)).toBe(column.field);
    }
  });
});
