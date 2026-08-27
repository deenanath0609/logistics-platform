import { describe, expect, it } from "vitest";
import {
  parsePincodeCsv,
  validatePincodeRows,
  summarise,
  templateCsv,
  IMPORT_COLUMNS,
  type ImportContext,
} from "./pincode-import";

function context(overrides: Partial<ImportContext> = {}): ImportContext {
  return {
    cityByKey: new Map([
      ["jaipur", "city-jai"],
      ["jai", "city-jai"],
      ["delhi", "city-del"],
      ["del", "city-del"],
    ]),
    branchByCode: new Map([
      ["hub-jai", "branch-jai"],
      ["hub-del", "branch-del"],
    ]),
    existing: new Set(["302013"]),
    ...overrides,
  };
}

function parse(csv: string) {
  const result = parsePincodeCsv(csv);
  if (!result.ok) throw new Error(result.error);
  return result.rows;
}

describe("parsePincodeCsv", () => {
  it("parses a clean file", () => {
    const result = parsePincodeCsv(
      "pincode,city,area,branch,serviceable,oda\n302020,Jaipur,Malviya Nagar,HUB-JAI,yes,no\n",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      rowNumber: 2,
      code: "302020",
      city: "Jaipur",
      area: "Malviya Nagar",
      branch: "HUB-JAI",
      serviceable: true,
      oda: false,
    });
  });

  it("survives a UTF-8 BOM, which Excel always writes", () => {
    const result = parsePincodeCsv("﻿pincode,city\n302020,Jaipur\n");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].code).toBe("302020");
  });

  it("accepts semicolon-delimited files", () => {
    const result = parsePincodeCsv("pincode;city;area\n302020;Jaipur;Malviya Nagar\n");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].area).toBe("Malviya Nagar");
  });

  it("accepts the header spellings people actually type", () => {
    const result = parsePincodeCsv(
      "PIN Code,City Name,Locality\n302020,Jaipur,Malviya Nagar\n",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0].code).toBe("302020");
      expect(result.rows[0].city).toBe("Jaipur");
      expect(result.rows[0].area).toBe("Malviya Nagar");
    }
  });

  it("handles a quoted cell containing a comma", () => {
    const result = parsePincodeCsv(
      'pincode,city,area\n302020,Jaipur,"Malviya Nagar, Sector 4"\n',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].area).toBe("Malviya Nagar, Sector 4");
  });

  it("rejects a file with no pincode column rather than importing nothing", () => {
    const result = parsePincodeCsv("city,area\nJaipur,Malviya Nagar\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/pincode/i);
  });

  it("rejects an empty file", () => {
    expect(parsePincodeCsv("").ok).toBe(false);
    expect(parsePincodeCsv("   \n  ").ok).toBe(false);
  });

  it("rejects a header with no rows", () => {
    const result = parsePincodeCsv("pincode,city\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no rows/i);
  });

  it("skips blank lines", () => {
    const result = parsePincodeCsv("pincode,city\n302020,Jaipur\n\n302021,Jaipur\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(2);
      expect(result.rows[1].code).toBe("302021");
    }
  });

  it("defaults serviceable to true and oda to false when the columns are absent", () => {
    const result = parsePincodeCsv("pincode,city\n302020,Jaipur\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0].serviceable).toBe(true);
      expect(result.rows[0].oda).toBe(false);
    }
  });
});

describe("validatePincodeRows", () => {
  it("marks a known PIN as an update and an unknown one as new", () => {
    const rows = validatePincodeRows(
      parse("pincode,city\n302013,Jaipur\n302020,Jaipur\n"),
      context(),
    );

    expect(rows[0].status).toBe("UPDATE");
    expect(rows[1].status).toBe("NEW");
  });

  it("rejects a PIN that is not six digits", () => {
    const rows = validatePincodeRows(parse("pincode,city\n3020,Jaipur\n"), context());
    expect(rows[0].status).toBe("INVALID");
    expect(rows[0].errors.pincode).toMatch(/six-digit/i);
  });

  it("rejects a city that is not in the network", () => {
    const rows = validatePincodeRows(
      parse("pincode,city\n302020,Atlantis\n"),
      context(),
    );
    expect(rows[0].status).toBe("INVALID");
    expect(rows[0].errors.city).toMatch(/not a city/i);
  });

  it("resolves a city by its short code as well as its name", () => {
    const rows = validatePincodeRows(parse("pincode,city\n302020,JAI\n"), context());
    expect(rows[0].status).toBe("NEW");
    expect(rows[0].cityId).toBe("city-jai");
  });

  it("rejects an unknown branch code but keeps the rest of the row readable", () => {
    const rows = validatePincodeRows(
      parse("pincode,city,branch\n302020,Jaipur,NOPE\n"),
      context(),
    );
    expect(rows[0].status).toBe("INVALID");
    expect(rows[0].errors.branch).toMatch(/not a branch/i);
    expect(rows[0].city).toBe("Jaipur");
  });

  it("allows a row with no branch — unassigned is a real state", () => {
    const rows = validatePincodeRows(parse("pincode,city\n302020,Jaipur\n"), context());
    expect(rows[0].status).toBe("NEW");
    expect(rows[0].branchId).toBeNull();
  });

  it("flags a duplicate inside the file and names the row it duplicates", () => {
    const rows = validatePincodeRows(
      parse("pincode,city\n302020,Jaipur\n302020,Jaipur\n"),
      context(),
    );

    expect(rows[0].status).toBe("NEW");
    expect(rows[1].status).toBe("INVALID");
    expect(rows[1].errors.pincode).toMatch(/row 2/);
  });

  it("reports every problem on a row at once, not just the first", () => {
    const rows = validatePincodeRows(
      parse("pincode,city,branch\n99,Atlantis,NOPE\n"),
      context(),
    );

    expect(Object.keys(rows[0].errors).sort()).toEqual([
      "branch",
      "city",
      "pincode",
    ]);
  });
});

describe("summarise", () => {
  it("counts each outcome", () => {
    const rows = validatePincodeRows(
      parse("pincode,city\n302013,Jaipur\n302020,Jaipur\n99,Jaipur\n"),
      context(),
    );

    expect(summarise(rows)).toEqual({
      total: 3,
      create: 1,
      update: 1,
      invalid: 1,
    });
  });
});

describe("templateCsv", () => {
  it("is generated from the same column list the parser reads", () => {
    const csv = templateCsv();
    const header = csv.split("\n")[0];

    for (const column of IMPORT_COLUMNS) {
      expect(header).toContain(column.label);
    }

    // The template must survive its own parser, or we are handing
    // customers a file we would reject.
    expect(parsePincodeCsv(csv).ok).toBe(true);
  });
});
