import { COLUMNS, COLUMN_BY_FIELD, type ColumnDef } from "./columns";
import type { ParsedRow } from "./parse";

/**
 * Row validation.
 *
 * Pure by construction: every fact the validator needs about the network —
 * which service codes exist, which PINs are serviceable, which customer
 * references are already taken — arrives in the context object. Nothing
 * here opens a connection, which is why the interesting cases (row 7 with
 * three separate errors, a reference duplicated inside one file) are
 * ordinary unit tests rather than fixtures against a live database.
 *
 * Every row is validated independently and reports *all* of its problems
 * at once. Stopping at the first error would make a clerk re-upload a file
 * four times to find four mistakes.
 */

// Re-exported from the generated enum so a new mode reaches the bulk
// importer without anyone remembering to widen a second union.
import type { ShipmentMode } from "@/generated/prisma/client";

export type { ShipmentMode };
export type PaymentType = "PAID" | "TO_PAY" | "TBB" | "COD";

/** Field key → one short message, sized to fit in a grid cell. */
export type FieldErrors = Record<string, string>;

export type ServiceFact = {
  id: string;
  code: string;
  mode: ShipmentMode;
  allowsCod: boolean;
  allowsToPay: boolean;
  isActive: boolean;
};

export type BranchFact = { id: string; code: string; isActive: boolean };

export type PincodeFact = {
  cityId: string;
  isServiceable: boolean;
  isOda: boolean;
};

export type ValidationContext = {
  /** Keyed on the upper-cased service code. */
  services: ReadonlyMap<string, ServiceFact>;
  /** Keyed on the upper-cased branch code. */
  branches: ReadonlyMap<string, BranchFact>;
  /** Keyed on the six-digit code. */
  pincodes: ReadonlyMap<string, PincodeFact>;
  /** Upper-cased customer references already carried by a shipment. */
  existingReferences: ReadonlySet<string>;
  /**
   * When the uploading clerk holds `shipment.override_serviceability`, an
   * unserviceable destination becomes a warning instead of a blocker —
   * matching what the single-booking screen already does.
   */
  canOverrideServiceability?: boolean;
};

/** A row that passed, in the shape the committer hands to `createBooking`. */
export type BulkRowValue = {
  mode: ShipmentMode;
  serviceTypeId: string;
  originBranchId: string;
  destinationBranchId: string;

  consignorName: string;
  consignorCompany: string | null;
  consignorPhone: string;
  consignorEmail: string | null;
  consignorAddress: string;
  consignorCityId: string;
  consignorPincode: string;
  consignorGstin: string | null;

  consigneeName: string;
  consigneeCompany: string | null;
  consigneePhone: string;
  consigneeEmail: string | null;
  consigneeAddress: string;
  consigneeCityId: string;
  consigneePincode: string;
  consigneeLandmark: string | null;
  consigneeGstin: string | null;

  packageCount: number;
  actualWeight: number;
  lengthCm: number | null;
  breadthCm: number | null;
  heightCm: number | null;
  declaredValue: number | null;
  goodsDescription: string;
  specialInstructions: string | null;
  isFragile: boolean;

  paymentType: PaymentType;
  codAmount: number | null;

  customerReference: string | null;
  ewayBillNumber: string | null;
  invoiceNumber: string | null;
  invoiceValue: number | null;
  pickupRequired: boolean;
};

export type ValidatedRow = {
  rowNumber: number;
  sourceLine: number;
  raw: Record<string, string>;
  errors: FieldErrors;
  /** Non-blocking notes: ODA destination, serviceability override in use. */
  warnings: FieldErrors;
  /** Present only when `errors` is empty. */
  value: BulkRowValue | null;
};

export type ValidationSummary = {
  rows: ValidatedRow[];
  validCount: number;
  invalidCount: number;
  /** Every distinct message with how many rows carry it, worst first. */
  topErrors: Array<{ field: string; message: string; count: number }>;
};

// ────────────────────────────────────────────────────────────
// Cell coercion
// ────────────────────────────────────────────────────────────

const TRUE_WORDS = new Set(["y", "yes", "true", "1", "t"]);
const FALSE_WORDS = new Set(["n", "no", "false", "0", "f", ""]);

/** Digits only, after discarding the spellings people actually type. */
export function normalisePhone(input: string): string {
  const digits = input.replace(/[^\d]/g, "");
  // +91 98765 43210 and 09876543210 are the same number written twice.
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/** Strips grouping separators and currency marks before parsing. */
export function parseNumberCell(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, "");
  if (cleaned === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return Number.NaN;
  return Number(cleaned);
}

export function parseBooleanCell(input: string): boolean | null {
  const word = input.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cell(raw: Record<string, string>, field: string): string {
  return (raw[field] ?? "").trim();
}

function blankToNull(value: string): string | null {
  return value === "" ? null : value;
}

// ────────────────────────────────────────────────────────────
// Per-field checks
// ────────────────────────────────────────────────────────────

/**
 * Type and range checks driven by the column declaration, so a column
 * added to `columns.ts` is checked without a second edit here.
 */
function checkShape(
  column: ColumnDef,
  value: string,
  errors: FieldErrors,
): void {
  if (value === "") {
    if (column.required) errors[column.field] = "Required";
    return;
  }

  switch (column.kind) {
    case "text": {
      if (column.maxLength && value.length > column.maxLength) {
        errors[column.field] = `Longer than ${column.maxLength} characters`;
      }
      return;
    }
    case "phone": {
      if (!/^\d{10}$/.test(normalisePhone(value))) {
        errors[column.field] = "Must be 10 digits";
      }
      return;
    }
    case "pincode": {
      if (!/^\d{6}$/.test(value)) errors[column.field] = "Must be 6 digits";
      return;
    }
    case "email": {
      if (!EMAIL.test(value)) errors[column.field] = "Not a valid email";
      return;
    }
    case "int": {
      const parsed = parseNumberCell(value);
      if (parsed === null || Number.isNaN(parsed) || !Number.isInteger(parsed)) {
        errors[column.field] = "Must be a whole number";
        return;
      }
      if (column.min !== undefined && parsed < column.min) {
        errors[column.field] = `Must be at least ${column.min}`;
      } else if (column.max !== undefined && parsed > column.max) {
        errors[column.field] = `Must be ${column.max} or less`;
      }
      return;
    }
    case "decimal":
    case "money": {
      const parsed = parseNumberCell(value);
      if (parsed === null || Number.isNaN(parsed)) {
        errors[column.field] = "Must be a number";
        return;
      }
      if (column.min !== undefined && parsed < column.min) {
        errors[column.field] =
          column.min > 0 ? "Must be greater than zero" : `Must be at least ${column.min}`;
      } else if (column.max !== undefined && parsed > column.max) {
        errors[column.field] = `Looks wrong — over ${column.max}`;
      }
      return;
    }
    case "enum": {
      const allowed = column.values ?? [];
      const match = allowed.find(
        (option) =>
          option.toLowerCase() === value.toLowerCase() ||
          option.replace(/_/g, "").toLowerCase() === value.replace(/[\s_-]/g, "").toLowerCase(),
      );
      if (!match) errors[column.field] = `Must be one of ${allowed.join(", ")}`;
      return;
    }
    case "boolean": {
      if (parseBooleanCell(value) === null) errors[column.field] = "Use Yes or No";
      return;
    }
  }
}

function enumValue(column: ColumnDef, value: string): string {
  const allowed = column.values ?? [];
  return (
    allowed.find(
      (option) =>
        option.toLowerCase() === value.toLowerCase() ||
        option.replace(/_/g, "").toLowerCase() ===
          value.replace(/[\s_-]/g, "").toLowerCase(),
    ) ?? value.toUpperCase()
  );
}

// ────────────────────────────────────────────────────────────
// Row validation
// ────────────────────────────────────────────────────────────

/**
 * Validates one row against the network.
 *
 * `referenceOwners` maps an upper-cased customer reference to the first
 * row number in the file that used it, so a duplicate can name its twin
 * rather than saying only "duplicate".
 */
export function validateRow(
  row: ParsedRow,
  context: ValidationContext,
  referenceOwners: ReadonlyMap<string, number[]> = new Map(),
): ValidatedRow {
  const errors: FieldErrors = {};
  const warnings: FieldErrors = {};
  const raw = row.raw;

  for (const column of COLUMNS) {
    checkShape(column, cell(raw, column.field), errors);
  }

  // ── Service type ─────────────────────────────────────────
  const serviceCode = cell(raw, "serviceTypeCode").toUpperCase();
  const service = context.services.get(serviceCode);
  if (serviceCode !== "" && !service) {
    errors.serviceTypeCode = "Unknown service code";
  } else if (service && !service.isActive) {
    errors.serviceTypeCode = `${service.code} is no longer offered`;
  }

  // ── Branches ─────────────────────────────────────────────
  const originCode = cell(raw, "originBranchCode").toUpperCase();
  const origin = context.branches.get(originCode);
  if (originCode !== "" && !origin) {
    errors.originBranchCode = "Unknown branch code";
  } else if (origin && !origin.isActive) {
    errors.originBranchCode = "Branch is closed";
  }

  const destinationCode = cell(raw, "destinationBranchCode").toUpperCase();
  const destination = context.branches.get(destinationCode);
  if (destinationCode !== "" && !destination) {
    errors.destinationBranchCode = "Unknown branch code";
  } else if (destination && !destination.isActive) {
    errors.destinationBranchCode = "Branch is closed";
  }

  // ── PIN codes ────────────────────────────────────────────
  const consignorPin = cell(raw, "consignorPincode");
  const consignorPincode = errors.consignorPincode
    ? undefined
    : context.pincodes.get(consignorPin);
  if (consignorPin !== "" && !errors.consignorPincode && !consignorPincode) {
    errors.consignorPincode = "PIN not in the network";
  }

  const consigneePin = cell(raw, "consigneePincode");
  const consigneePincode = errors.consigneePincode
    ? undefined
    : context.pincodes.get(consigneePin);

  if (consigneePin !== "" && !errors.consigneePincode && !consigneePincode) {
    errors.consigneePincode = "PIN not in the network";
  } else if (consigneePincode && !consigneePincode.isServiceable) {
    // Same rule as the booking screen: blocked unless the clerk holds the
    // override permission, in which case it is flagged and let through.
    if (context.canOverrideServiceability) {
      warnings.consigneePincode = "Not serviceable — booking under override";
    } else {
      errors.consigneePincode = "PIN not serviceable";
    }
  } else if (consigneePincode?.isOda) {
    warnings.consigneePincode = "Out of delivery area — ODA charge and longer SLA";
  }

  // ── Weight and dimensions ────────────────────────────────
  // Individually each figure can be plausible and the combination absurd:
  // 1.2 m³ declared at 0.5 kg is a keying slip, not a shipment.
  const length = parseNumberCell(cell(raw, "lengthCm"));
  const breadth = parseNumberCell(cell(raw, "breadthCm"));
  const height = parseNumberCell(cell(raw, "heightCm"));
  const dims = [length, breadth, height];
  const givenDims = dims.filter((d) => d !== null && !Number.isNaN(d)).length;

  if (givenDims > 0 && givenDims < 3) {
    for (const field of ["lengthCm", "breadthCm", "heightCm"] as const) {
      if (!errors[field] && cell(raw, field) === "") {
        errors[field] = "Give all three dimensions, or none";
      }
    }
  }

  const weight = parseNumberCell(cell(raw, "actualWeight"));
  const packageCount = parseNumberCell(cell(raw, "packageCount"));

  if (
    weight !== null &&
    !Number.isNaN(weight) &&
    weight > 0 &&
    packageCount !== null &&
    !Number.isNaN(packageCount) &&
    packageCount > 0 &&
    !errors.actualWeight &&
    !errors.packageCount
  ) {
    const perPiece = weight / packageCount;
    if (perPiece > 2000) {
      errors.actualWeight = "Over 2,000 kg per piece — check the figure";
    }
  }

  // ── Payment ──────────────────────────────────────────────
  const paymentColumn = COLUMN_BY_FIELD.get("paymentType");
  const paymentRaw = cell(raw, "paymentType");
  const paymentType =
    paymentColumn && paymentRaw !== "" && !errors.paymentType
      ? (enumValue(paymentColumn, paymentRaw) as PaymentType)
      : null;

  const codRaw = cell(raw, "codAmount");
  const codAmount = parseNumberCell(codRaw);

  if (paymentType === "COD") {
    if (codRaw === "") {
      errors.codAmount = "Required for COD";
    } else if (!errors.codAmount && (codAmount === null || codAmount <= 0)) {
      errors.codAmount = "Must be greater than zero";
    }
    if (service && !service.allowsCod && !errors.serviceTypeCode) {
      errors.paymentType = `COD is not offered on ${service.code}`;
    }
  } else {
    if (codRaw !== "" && codAmount !== null && !Number.isNaN(codAmount) && codAmount > 0) {
      errors.codAmount = "Only allowed when Payment Type is COD";
    }
    if (paymentType === "TO_PAY" && service && !service.allowsToPay && !errors.serviceTypeCode) {
      errors.paymentType = `To-Pay is not offered on ${service.code}`;
    }
  }

  // ── Customer reference ───────────────────────────────────
  const reference = cell(raw, "customerReference");
  if (reference !== "" && !errors.customerReference) {
    const key = reference.toUpperCase();
    if (context.existingReferences.has(key)) {
      errors.customerReference = "Already used by an existing shipment";
    } else {
      const owners = referenceOwners.get(key) ?? [];
      if (owners.length > 1) {
        const others = owners.filter((n) => n !== row.rowNumber);
        errors.customerReference = `Repeated in this file (also row ${others
          .slice(0, 3)
          .join(", ")}${others.length > 3 ? "…" : ""})`;
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { rowNumber: row.rowNumber, sourceLine: row.sourceLine, raw, errors, warnings, value: null };
  }

  // Everything below is safe: the checks above have already established
  // that each of these lookups and coercions succeeds.
  const fragile = parseBooleanCell(cell(raw, "isFragile")) ?? false;
  const pickupCell = cell(raw, "pickupRequired");
  const pickupRequired =
    pickupCell === "" ? true : (parseBooleanCell(pickupCell) ?? true);

  const value: BulkRowValue = {
    mode: service!.mode,
    serviceTypeId: service!.id,
    originBranchId: origin!.id,
    destinationBranchId: destination!.id,

    consignorName: cell(raw, "consignorName"),
    consignorCompany: blankToNull(cell(raw, "consignorCompany")),
    consignorPhone: normalisePhone(cell(raw, "consignorPhone")),
    consignorEmail: blankToNull(cell(raw, "consignorEmail")),
    consignorAddress: cell(raw, "consignorAddress"),
    consignorCityId: consignorPincode!.cityId,
    consignorPincode: consignorPin,
    consignorGstin: blankToNull(cell(raw, "consignorGstin")),

    consigneeName: cell(raw, "consigneeName"),
    consigneeCompany: blankToNull(cell(raw, "consigneeCompany")),
    consigneePhone: normalisePhone(cell(raw, "consigneePhone")),
    consigneeEmail: blankToNull(cell(raw, "consigneeEmail")),
    consigneeAddress: cell(raw, "consigneeAddress"),
    consigneeCityId: consigneePincode!.cityId,
    consigneePincode: consigneePin,
    consigneeLandmark: blankToNull(cell(raw, "consigneeLandmark")),
    consigneeGstin: blankToNull(cell(raw, "consigneeGstin")),

    packageCount: packageCount!,
    actualWeight: weight!,
    lengthCm: length ?? null,
    breadthCm: breadth ?? null,
    heightCm: height ?? null,
    declaredValue: parseNumberCell(cell(raw, "declaredValue")),
    goodsDescription: cell(raw, "goodsDescription"),
    specialInstructions: blankToNull(cell(raw, "specialInstructions")),
    isFragile: fragile,

    paymentType: paymentType!,
    codAmount: paymentType === "COD" ? codAmount : null,

    customerReference: blankToNull(reference),
    ewayBillNumber: blankToNull(cell(raw, "ewayBillNumber")),
    invoiceNumber: blankToNull(cell(raw, "invoiceNumber")),
    invoiceValue: parseNumberCell(cell(raw, "invoiceValue")),
    pickupRequired,
  };

  return { rowNumber: row.rowNumber, sourceLine: row.sourceLine, raw, errors, warnings, value };
}

/** Maps every customer reference in the file to the rows that carry it. */
export function referenceOwnersFor(
  rows: readonly ParsedRow[],
): Map<string, number[]> {
  const owners = new Map<string, number[]>();
  for (const row of rows) {
    const reference = (row.raw.customerReference ?? "").trim().toUpperCase();
    if (reference === "") continue;
    const list = owners.get(reference) ?? [];
    list.push(row.rowNumber);
    owners.set(reference, list);
  }
  return owners;
}

/**
 * Validates a whole file.
 *
 * Two passes, because a duplicate reference is a property of the file
 * rather than of a row: the first pass indexes references so the second
 * can flag *both* halves of a duplicate rather than only the later one.
 */
export function validateRows(
  rows: readonly ParsedRow[],
  context: ValidationContext,
): ValidationSummary {
  const owners = referenceOwnersFor(rows);
  const validated = rows.map((row) => validateRow(row, context, owners));

  const tally = new Map<string, { field: string; message: string; count: number }>();
  for (const row of validated) {
    for (const [field, message] of Object.entries(row.errors)) {
      const key = `${field}::${message}`;
      const entry = tally.get(key) ?? { field, message, count: 0 };
      entry.count++;
      tally.set(key, entry);
    }
  }

  return {
    rows: validated,
    validCount: validated.filter((r) => r.value !== null).length,
    invalidCount: validated.filter((r) => r.value === null).length,
    topErrors: [...tally.values()].sort((a, b) => b.count - a.count),
  };
}
