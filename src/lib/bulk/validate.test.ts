import { describe, expect, it } from "vitest";
import { TEMPLATE_HEADERS, fieldForHeader } from "./columns";
import { parseUpload, type ParsedRow } from "./parse";
import {
  normalisePhone,
  parseNumberCell,
  parseBooleanCell,
  referenceOwnersFor,
  validateRow,
  validateRows,
  type BranchFact,
  type PincodeFact,
  type ServiceFact,
  type ValidationContext,
} from "./validate";
import { bulkIdempotencyKey, parseBulkIdempotencyKey } from "./idempotency";

// ────────────────────────────────────────────────────────────
// A small pretend network
// ────────────────────────────────────────────────────────────

const services = new Map<string, ServiceFact>([
  [
    "PTL-STD",
    { id: "svc_ptl", code: "PTL-STD", mode: "PTL", allowsCod: true, allowsToPay: true, isActive: true },
  ],
  [
    "AIR-EXP",
    { id: "svc_air", code: "AIR-EXP", mode: "COURIER", allowsCod: false, allowsToPay: false, isActive: true },
  ],
  [
    "PTL-OLD",
    { id: "svc_old", code: "PTL-OLD", mode: "PTL", allowsCod: true, allowsToPay: true, isActive: false },
  ],
]);

const branches = new Map<string, BranchFact>([
  ["DEL", { id: "br_del", code: "DEL", isActive: true }],
  ["JAI", { id: "br_jai", code: "JAI", isActive: true }],
  ["AGR", { id: "br_agr", code: "AGR", isActive: false }],
]);

const pincodes = new Map<string, PincodeFact>([
  ["110028", { cityId: "city_del", isServiceable: true, isOda: false }],
  ["302001", { cityId: "city_jai", isServiceable: true, isOda: false }],
  ["302099", { cityId: "city_jai", isServiceable: true, isOda: true }],
  ["313001", { cityId: "city_udr", isServiceable: false, isOda: false }],
]);

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    services,
    branches,
    pincodes,
    existingReferences: new Set(["SO-2026-00001"]),
    ...overrides,
  };
}

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

function row(
  overrides: Record<string, string> = {},
  rowNumber = 1,
): ParsedRow {
  return {
    rowNumber,
    sourceLine: rowNumber + 1,
    raw: { ...GOOD, ...overrides },
  };
}

function csvBytes(rows: Array<Record<string, string>>): Uint8Array {
  const fields = TEMPLATE_HEADERS.map((header) => fieldForHeader(header));
  const line = (cells: string[]) =>
    cells.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",");

  return new TextEncoder().encode(
    [
      line([...TEMPLATE_HEADERS]),
      ...rows.map((data) =>
        line(fields.map((field) => (field ? (data[field] ?? "") : ""))),
      ),
    ].join("\r\n"),
  );
}

// ────────────────────────────────────────────────────────────

describe("cell coercion", () => {
  it("accepts the spellings people actually type for a phone number", () => {
    expect(normalisePhone("9876543210")).toBe("9876543210");
    expect(normalisePhone("+91 98765 43210")).toBe("9876543210");
    expect(normalisePhone("098765-43210")).toBe("9876543210");
  });

  it("strips grouping separators and the rupee sign from an amount", () => {
    expect(parseNumberCell("1,20,000")).toBe(120000);
    expect(parseNumberCell("₹ 4,500.50")).toBe(4500.5);
    expect(parseNumberCell("")).toBeNull();
    expect(parseNumberCell("about 40")).toBeNaN();
  });

  it("reads yes/no in the forms a spreadsheet produces", () => {
    expect(parseBooleanCell("Yes")).toBe(true);
    expect(parseBooleanCell("TRUE")).toBe(true);
    expect(parseBooleanCell("1")).toBe(true);
    expect(parseBooleanCell("no")).toBe(false);
    expect(parseBooleanCell("")).toBe(false);
    expect(parseBooleanCell("maybe")).toBeNull();
  });
});

describe("validateRow — a clean row", () => {
  const result = validateRow(row(), context());

  it("reports no errors", () => {
    expect(result.errors).toEqual({});
  });

  it("resolves codes and PINs into the ids the booking needs", () => {
    expect(result.value).not.toBeNull();
    expect(result.value?.serviceTypeId).toBe("svc_ptl");
    expect(result.value?.mode).toBe("PTL");
    expect(result.value?.originBranchId).toBe("br_del");
    expect(result.value?.destinationBranchId).toBe("br_jai");
    expect(result.value?.consignorCityId).toBe("city_del");
    expect(result.value?.consigneeCityId).toBe("city_jai");
  });

  it("defaults pickup to required and fragile to false", () => {
    expect(result.value?.pickupRequired).toBe(true);
    expect(result.value?.isFragile).toBe(false);
  });
});

describe("validateRow — required fields", () => {
  it("names every missing required field, not just the first", () => {
    const result = validateRow(
      row({ consigneeName: "", consigneeAddress: "", goodsDescription: "" }),
      context(),
    );

    expect(result.errors.consigneeName).toBe("Required");
    expect(result.errors.consigneeAddress).toBe("Required");
    expect(result.errors.goodsDescription).toBe("Required");
    expect(result.value).toBeNull();
  });

  it("leaves optional columns alone when blank", () => {
    const result = validateRow(row({ consigneeEmail: "", invoiceNumber: "" }), context());
    expect(result.errors).toEqual({});
  });
});

describe("validateRow — phones and PINs", () => {
  it("rejects a phone that is not ten digits", () => {
    expect(validateRow(row({ consigneePhone: "98123456" }), context()).errors)
      .toHaveProperty("consigneePhone", "Must be 10 digits");
  });

  it("accepts a phone written with a country code and stores it bare", () => {
    const result = validateRow(row({ consigneePhone: "+91 98123 45670" }), context());
    expect(result.errors).toEqual({});
    expect(result.value?.consigneePhone).toBe("9812345670");
  });

  it("rejects a PIN that is not six digits", () => {
    expect(validateRow(row({ consigneePincode: "3020" }), context()).errors)
      .toHaveProperty("consigneePincode", "Must be 6 digits");
  });
});

describe("validateRow — destination serviceability", () => {
  it("blocks a PIN the network does not know", () => {
    expect(validateRow(row({ consigneePincode: "999999" }), context()).errors)
      .toHaveProperty("consigneePincode", "PIN not in the network");
  });

  it("blocks a known but unserviceable PIN", () => {
    const result = validateRow(row({ consigneePincode: "313001" }), context());
    expect(result.errors.consigneePincode).toBe("PIN not serviceable");
    expect(result.value).toBeNull();
  });

  it("lets an unserviceable PIN through for a clerk holding the override", () => {
    const result = validateRow(
      row({ consigneePincode: "313001" }),
      context({ canOverrideServiceability: true }),
    );

    expect(result.errors).toEqual({});
    expect(result.warnings.consigneePincode).toContain("override");
    expect(result.value?.consigneeCityId).toBe("city_udr");
  });

  it("warns about an ODA destination without blocking it", () => {
    const result = validateRow(row({ consigneePincode: "302099" }), context());
    expect(result.errors).toEqual({});
    expect(result.warnings.consigneePincode).toContain("ODA");
  });

  it("also insists the origin PIN exists, since the city comes from it", () => {
    expect(validateRow(row({ consignorPincode: "888888" }), context()).errors)
      .toHaveProperty("consignorPincode", "PIN not in the network");
  });
});

describe("validateRow — weight and dimension sanity", () => {
  it("rejects a zero or negative weight", () => {
    expect(validateRow(row({ actualWeight: "0" }), context()).errors)
      .toHaveProperty("actualWeight", "Must be greater than zero");
    expect(validateRow(row({ actualWeight: "-5" }), context()).errors)
      .toHaveProperty("actualWeight");
  });

  it("rejects a weight no vehicle in the fleet could carry", () => {
    expect(validateRow(row({ actualWeight: "45000" }), context()).errors)
      .toHaveProperty("actualWeight");
  });

  it("catches an implausible weight per piece", () => {
    // 9,000 kg spread over 3 cartons is a keying slip, not a shipment.
    expect(
      validateRow(row({ actualWeight: "9000", packageCount: "3" }), context()).errors,
    ).toHaveProperty("actualWeight");
  });

  it("rejects a package count that is not a whole number", () => {
    expect(validateRow(row({ packageCount: "2.5" }), context()).errors)
      .toHaveProperty("packageCount", "Must be a whole number");
    expect(validateRow(row({ packageCount: "0" }), context()).errors)
      .toHaveProperty("packageCount");
  });

  it("rejects a dimension outside anything that fits on a truck", () => {
    expect(
      validateRow(row({ lengthCm: "5000", breadthCm: "80", heightCm: "60" }), context())
        .errors,
    ).toHaveProperty("lengthCm");
  });

  it("insists on all three dimensions or none, since two cannot be cubed", () => {
    const result = validateRow(row({ lengthCm: "120", breadthCm: "80" }), context());
    expect(result.errors.heightCm).toBe("Give all three dimensions, or none");
    expect(result.errors.lengthCm).toBeUndefined();
  });

  it("accepts a complete set of dimensions", () => {
    const result = validateRow(
      row({ lengthCm: "120", breadthCm: "80", heightCm: "60" }),
      context(),
    );
    expect(result.errors).toEqual({});
    expect(result.value?.lengthCm).toBe(120);
  });
});

describe("validateRow — service codes", () => {
  it("rejects an unknown service code", () => {
    expect(validateRow(row({ serviceTypeCode: "PTL-EXPRESS" }), context()).errors)
      .toHaveProperty("serviceTypeCode", "Unknown service code");
  });

  it("rejects a service that has been withdrawn", () => {
    expect(validateRow(row({ serviceTypeCode: "PTL-OLD" }), context()).errors
      .serviceTypeCode).toContain("no longer offered");
  });

  it("matches the code case-insensitively", () => {
    expect(validateRow(row({ serviceTypeCode: "ptl-std" }), context()).errors)
      .toEqual({});
  });

  it("rejects an unknown or closed branch code", () => {
    expect(validateRow(row({ destinationBranchCode: "BLR" }), context()).errors)
      .toHaveProperty("destinationBranchCode", "Unknown branch code");
    expect(validateRow(row({ destinationBranchCode: "AGR" }), context()).errors)
      .toHaveProperty("destinationBranchCode", "Branch is closed");
  });
});

describe("validateRow — COD", () => {
  it("requires an amount when the payment type is COD", () => {
    const result = validateRow(row({ paymentType: "COD", codAmount: "" }), context());
    expect(result.errors.codAmount).toBe("Required for COD");
  });

  it("rejects a zero COD amount", () => {
    expect(validateRow(row({ paymentType: "COD", codAmount: "0" }), context()).errors)
      .toHaveProperty("codAmount");
  });

  it("accepts a COD row and carries the amount through", () => {
    const result = validateRow(
      row({ paymentType: "COD", codAmount: "12,500" }),
      context(),
    );
    expect(result.errors).toEqual({});
    expect(result.value?.codAmount).toBe(12500);
  });

  it("rejects a COD amount on a row that is not COD", () => {
    expect(
      validateRow(row({ paymentType: "PAID", codAmount: "5000" }), context()).errors
        .codAmount,
    ).toBe("Only allowed when Payment Type is COD");
  });

  it("drops a stray COD amount rather than booking it on a PAID row", () => {
    const result = validateRow(row({ paymentType: "PAID", codAmount: "0" }), context());
    expect(result.errors).toEqual({});
    expect(result.value?.codAmount).toBeNull();
  });

  it("refuses COD on a service that does not offer it", () => {
    const result = validateRow(
      row({ serviceTypeCode: "AIR-EXP", paymentType: "COD", codAmount: "900" }),
      context(),
    );
    expect(result.errors.paymentType).toContain("COD is not offered");
  });

  it("refuses To-Pay on a service that does not offer it", () => {
    const result = validateRow(
      row({ serviceTypeCode: "AIR-EXP", paymentType: "TO_PAY" }),
      context(),
    );
    expect(result.errors.paymentType).toContain("To-Pay is not offered");
  });

  it("rejects a payment type that is not on the list", () => {
    expect(validateRow(row({ paymentType: "CREDIT" }), context()).errors)
      .toHaveProperty("paymentType");
  });

  it("accepts 'to pay' written with a space", () => {
    expect(validateRow(row({ paymentType: "To Pay" }), context()).errors).toEqual({});
  });
});

describe("validateRow — customer reference", () => {
  it("rejects a reference already carried by an existing shipment", () => {
    const result = validateRow(row({ customerReference: "so-2026-00001" }), context());
    expect(result.errors.customerReference).toBe("Already used by an existing shipment");
  });

  it("accepts a reference nobody has used", () => {
    expect(validateRow(row({ customerReference: "SO-2026-00999" }), context()).errors)
      .toEqual({});
  });
});

describe("row 7 with three separate errors", () => {
  const rows = Array.from({ length: 10 }, (_, index) =>
    index === 6
      ? {
          ...GOOD,
          consigneePhone: "98123",
          consigneePincode: "313001",
          paymentType: "COD",
          codAmount: "",
        }
      : { ...GOOD, customerReference: `REF-${index + 1}` },
  );

  const parsed = parseUpload({ fileName: "ten.csv", bytes: csvBytes(rows) });
  const summary = validateRows(parsed.rows, context());
  const seventh = summary.rows.find((r) => r.rowNumber === 7)!;

  it("fails only that row", () => {
    expect(summary.validCount).toBe(9);
    expect(summary.invalidCount).toBe(1);
  });

  it("reports all three problems at once, keyed by field", () => {
    expect(Object.keys(seventh.errors).sort()).toEqual([
      "codAmount",
      "consigneePhone",
      "consigneePincode",
    ]);
    expect(seventh.errors.consigneePhone).toBe("Must be 10 digits");
    expect(seventh.errors.consigneePincode).toBe("PIN not serviceable");
    expect(seventh.errors.codAmount).toBe("Required for COD");
  });

  it("keeps the row as uploaded, so the clerk sees what they sent", () => {
    expect(seventh.raw.consigneePhone).toBe("98123");
    expect(seventh.value).toBeNull();
  });
});

describe("duplicate references inside one file", () => {
  const rows = [
    { ...GOOD, customerReference: "SO-100" },
    { ...GOOD, customerReference: "SO-200" },
    { ...GOOD, customerReference: "so-100" },
    { ...GOOD, customerReference: "SO-300" },
    { ...GOOD, customerReference: "SO-100" },
  ];

  const parsed = parseUpload({ fileName: "dupes.csv", bytes: csvBytes(rows) });
  const summary = validateRows(parsed.rows, context());

  it("indexes every reference to the rows carrying it, ignoring case", () => {
    const owners = referenceOwnersFor(parsed.rows);
    expect(owners.get("SO-100")).toEqual([1, 3, 5]);
    expect(owners.get("SO-200")).toEqual([2]);
  });

  it("flags every copy, not only the later ones", () => {
    for (const rowNumber of [1, 3, 5]) {
      const found = summary.rows.find((r) => r.rowNumber === rowNumber)!;
      expect(found.errors.customerReference).toContain("Repeated in this file");
    }
  });

  it("names the other rows so the clerk can go straight to them", () => {
    const first = summary.rows.find((r) => r.rowNumber === 1)!;
    expect(first.errors.customerReference).toContain("3");
    expect(first.errors.customerReference).toContain("5");
    expect(first.errors.customerReference).not.toContain("row 1");
  });

  it("leaves the unique references alone", () => {
    expect(summary.rows.find((r) => r.rowNumber === 2)!.errors).toEqual({});
    expect(summary.validCount).toBe(2);
    expect(summary.invalidCount).toBe(3);
  });

  it("does not treat several blank references as duplicates of each other", () => {
    const blanks = parseUpload({
      fileName: "blanks.csv",
      bytes: csvBytes([GOOD, GOOD, GOOD]),
    });
    expect(validateRows(blanks.rows, context()).invalidCount).toBe(0);
  });
});

describe("a 200-row file with 7 bad rows", () => {
  // The Phase 1 acceptance test, exactly as the BRD words it.
  const BAD_ROWS = [12, 33, 57, 91, 118, 164, 197];

  const rows = Array.from({ length: 200 }, (_, index) => {
    const rowNumber = index + 1;
    const base = {
      ...GOOD,
      customerReference: `BULK-2026-${String(rowNumber).padStart(5, "0")}`,
    };
    if (!BAD_ROWS.includes(rowNumber)) return base;

    switch (rowNumber % 7) {
      case 5:
        return { ...base, consigneePincode: "999999" };
      case 4:
        return { ...base, consignorPhone: "12345" };
      case 1:
        return { ...base, actualWeight: "" };
      case 0:
        return { ...base, serviceTypeCode: "NOPE" };
      case 6:
        return { ...base, packageCount: "-2" };
      case 3:
        return { ...base, paymentType: "COD", codAmount: "" };
      default:
        return { ...base, consigneePincode: "313001" };
    }
  });

  const parsed = parseUpload({ fileName: "bulk-200.csv", bytes: csvBytes(rows) });
  const summary = validateRows(parsed.rows, context());

  it("parses all 200 rows", () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.rows).toHaveLength(200);
  });

  it("books 193 and reports 7", () => {
    expect(summary.validCount).toBe(193);
    expect(summary.invalidCount).toBe(7);
  });

  it("reports exactly which rows are bad", () => {
    expect(
      summary.rows.filter((r) => r.value === null).map((r) => r.rowNumber),
    ).toEqual(BAD_ROWS);
  });

  it("gives every bad row at least one field-keyed reason", () => {
    for (const bad of summary.rows.filter((r) => r.value === null)) {
      expect(Object.keys(bad.errors).length).toBeGreaterThan(0);
    }
  });

  it("summarises the reasons so a clerk can see the pattern", () => {
    const total = summary.topErrors.reduce((sum, entry) => sum + entry.count, 0);
    expect(total).toBeGreaterThanOrEqual(7);
    expect(summary.topErrors[0].count).toBeGreaterThanOrEqual(
      summary.topErrors[summary.topErrors.length - 1].count,
    );
  });
});

describe("rows carrying smart quotes and a BOM", () => {
  it("validates a Windows-1252 file as readily as a UTF-8 one", () => {
    const text = new TextDecoder().decode(
      csvBytes([{ ...GOOD, consigneeName: "O’Brien & Sons", consigneeAddress: "Gate 4 – “Blue Shed”" }]),
    );

    const cp1252: number[] = [];
    const HIGH: Record<string, number> = { "’": 0x92, "“": 0x93, "”": 0x94, "–": 0x96 };
    for (const char of text) {
      cp1252.push(HIGH[char] ?? char.codePointAt(0)!);
    }

    const parsed = parseUpload({
      fileName: "word.csv",
      bytes: new Uint8Array(cp1252),
    });
    const summary = validateRows(parsed.rows, context());

    expect(summary.invalidCount).toBe(0);
    expect(summary.rows[0].value?.consigneeName).toBe("O’Brien & Sons");
    expect(summary.rows[0].value?.consigneeAddress).toBe("Gate 4 – “Blue Shed”");
  });

  it("validates a BOM-prefixed file without the BOM leaking into the first cell", () => {
    const body = csvBytes([GOOD]);
    const bytes = new Uint8Array(body.length + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(body, 3);

    const parsed = parseUpload({ fileName: "bom.csv", bytes });
    const summary = validateRows(parsed.rows, context());

    expect(summary.invalidCount).toBe(0);
    expect(summary.rows[0].value?.serviceTypeId).toBe("svc_ptl");
  });
});

describe("validateRows on an empty file", () => {
  it("returns nothing rather than throwing", () => {
    const summary = validateRows([], context());
    expect(summary.rows).toEqual([]);
    expect(summary.validCount).toBe(0);
    expect(summary.invalidCount).toBe(0);
    expect(summary.topErrors).toEqual([]);
  });
});

describe("the commit idempotency key", () => {
  it("is a pure function of the batch and the row", () => {
    expect(bulkIdempotencyKey("batch_abc", 7)).toBe("bulk:batch_abc:7");
    expect(bulkIdempotencyKey("batch_abc", 7)).toBe(bulkIdempotencyKey("batch_abc", 7));
  });

  it("differs across rows and across batches", () => {
    expect(bulkIdempotencyKey("batch_abc", 7)).not.toBe(bulkIdempotencyKey("batch_abc", 8));
    expect(bulkIdempotencyKey("batch_abc", 7)).not.toBe(bulkIdempotencyKey("batch_xyz", 7));
  });

  it("round-trips, so an event can be traced back to its file", () => {
    expect(parseBulkIdempotencyKey(bulkIdempotencyKey("batch_abc", 42))).toEqual({
      batchId: "batch_abc",
      rowNumber: 42,
    });
    expect(parseBulkIdempotencyKey("something-else")).toBeNull();
  });
});
