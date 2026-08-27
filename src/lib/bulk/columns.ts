/**
 * The bulk-upload column schema.
 *
 * One declaration drives three things that must never disagree: the
 * downloadable template, the header matcher, and the per-cell validator.
 * A column added here appears in the template and is accepted by the
 * parser on the same deploy — there is no second list to forget.
 *
 * Deliberately absent: `mode` and the two city columns. Mode is implied
 * by the service code, and city is implied by the PIN. Asking a clerk to
 * restate either is how files acquire contradictions.
 */

export type ColumnKind =
  | "text"
  | "phone"
  | "pincode"
  | "email"
  | "int"
  | "decimal"
  | "money"
  | "enum"
  | "boolean";

export type ColumnDef = {
  /** Canonical key. Matches the booking input field wherever one exists. */
  field: string;
  /** Header written into the template. */
  header: string;
  /**
   * Extra spellings accepted from a customer's own file. Matching is done
   * on the normalised form, so case, spaces and punctuation are already
   * ignored — these are for genuinely different words.
   */
  aliases?: string[];
  kind: ColumnKind;
  required: boolean;
  /** `enum` columns only. Compared case-insensitively. */
  values?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  /** Shown in the template's example row and in the column help. */
  example: string;
  help: string;
};

export const COLUMNS: ColumnDef[] = [
  {
    field: "serviceTypeCode",
    header: "Service Code",
    aliases: ["service", "servicetype", "product"],
    kind: "text",
    required: true,
    maxLength: 20,
    example: "PTL-STD",
    help: "Service type code. The mode (FTL/PTL/Courier) follows from it.",
  },
  {
    field: "originBranchCode",
    header: "Origin Branch",
    aliases: ["origin", "frombranch", "bookingbranch"],
    kind: "text",
    required: true,
    maxLength: 20,
    example: "DEL",
    help: "Branch code the consignment starts from.",
  },
  {
    field: "destinationBranchCode",
    header: "Destination Branch",
    aliases: ["destination", "tobranch"],
    kind: "text",
    required: true,
    maxLength: 20,
    example: "JAI",
    help: "Branch code responsible for delivery.",
  },

  // ── Consignor ───────────────────────────────────────────────
  {
    field: "consignorName",
    header: "Consignor Name",
    aliases: ["shippername", "sendername"],
    kind: "text",
    required: true,
    maxLength: 120,
    example: "Ramesh Traders",
    help: "Who is sending the goods.",
  },
  {
    field: "consignorCompany",
    header: "Consignor Company",
    aliases: ["shippercompany"],
    kind: "text",
    required: false,
    maxLength: 120,
    example: "Ramesh Traders Pvt Ltd",
    help: "Legal name, if different from the contact.",
  },
  {
    field: "consignorPhone",
    header: "Consignor Phone",
    aliases: ["shipperphone", "senderphone", "consignormobile"],
    kind: "phone",
    required: true,
    example: "9876543210",
    help: "Ten digits, no country code.",
  },
  {
    field: "consignorEmail",
    header: "Consignor Email",
    aliases: ["shipperemail"],
    kind: "email",
    required: false,
    maxLength: 160,
    example: "accounts@rameshtraders.in",
    help: "Optional.",
  },
  {
    field: "consignorAddress",
    header: "Consignor Address",
    aliases: ["pickupaddress", "shipperaddress"],
    kind: "text",
    required: true,
    maxLength: 300,
    example: "14 Naraina Industrial Area Phase 1",
    help: "Street address for collection.",
  },
  {
    field: "consignorPincode",
    header: "Consignor PIN",
    aliases: ["pickuppincode", "originpincode", "shipperpin"],
    kind: "pincode",
    required: true,
    example: "110028",
    help: "Six digits. The city is taken from the PIN master.",
  },
  {
    field: "consignorGstin",
    header: "Consignor GSTIN",
    aliases: ["shippergstin"],
    kind: "text",
    required: false,
    maxLength: 20,
    example: "07AAACR1234A1ZR",
    help: "Needed on the consignment note for a GTA supply.",
  },

  // ── Consignee ───────────────────────────────────────────────
  {
    field: "consigneeName",
    header: "Consignee Name",
    aliases: ["receivername", "deliverto"],
    kind: "text",
    required: true,
    maxLength: 120,
    example: "Sharma Distributors",
    help: "Who receives the goods.",
  },
  {
    field: "consigneeCompany",
    header: "Consignee Company",
    aliases: ["receivercompany"],
    kind: "text",
    required: false,
    maxLength: 120,
    example: "Sharma Distributors LLP",
    help: "Optional.",
  },
  {
    field: "consigneePhone",
    header: "Consignee Phone",
    aliases: ["receiverphone", "consigneemobile", "deliveryphone"],
    kind: "phone",
    required: true,
    example: "9812345670",
    help: "Ten digits. The delivery agent calls this number.",
  },
  {
    field: "consigneeEmail",
    header: "Consignee Email",
    aliases: ["receiveremail"],
    kind: "email",
    required: false,
    maxLength: 160,
    example: "store@sharmadist.in",
    help: "Optional.",
  },
  {
    field: "consigneeAddress",
    header: "Consignee Address",
    aliases: ["deliveryaddress", "receiveraddress"],
    kind: "text",
    required: true,
    maxLength: 300,
    example: "Shop 22 MI Road",
    help: "Street address for delivery.",
  },
  {
    field: "consigneePincode",
    header: "Consignee PIN",
    aliases: ["deliverypincode", "destinationpincode", "receiverpin"],
    kind: "pincode",
    required: true,
    example: "302001",
    help: "Six digits, checked against the serviceability master.",
  },
  {
    field: "consigneeLandmark",
    header: "Consignee Landmark",
    aliases: ["landmark"],
    kind: "text",
    required: false,
    maxLength: 120,
    example: "Opposite GPO",
    help: "Optional.",
  },
  {
    field: "consigneeGstin",
    header: "Consignee GSTIN",
    aliases: ["receivergstin"],
    kind: "text",
    required: false,
    maxLength: 20,
    example: "08AACCS5678B1Z9",
    help: "Optional.",
  },

  // ── Consignment ─────────────────────────────────────────────
  {
    field: "packageCount",
    header: "Packages",
    aliases: ["packagecount", "pieces", "pcs", "qty", "quantity"],
    kind: "int",
    required: true,
    min: 1,
    max: 9999,
    example: "3",
    help: "Number of physical pieces. Each one gets its own barcode.",
  },
  {
    field: "actualWeight",
    header: "Actual Weight (kg)",
    aliases: ["weight", "grossweight", "actualweightkg"],
    kind: "decimal",
    required: true,
    min: 0.001,
    max: 30000,
    example: "48.5",
    help: "Gross weight in kilograms.",
  },
  {
    field: "lengthCm",
    header: "Length (cm)",
    aliases: ["length", "lcm"],
    kind: "decimal",
    required: false,
    min: 0.1,
    max: 1200,
    example: "120",
    help: "Per-piece dimension. Drives volumetric weight.",
  },
  {
    field: "breadthCm",
    header: "Breadth (cm)",
    aliases: ["breadth", "width", "bcm", "wcm"],
    kind: "decimal",
    required: false,
    min: 0.1,
    max: 1200,
    example: "80",
    help: "Per-piece dimension.",
  },
  {
    field: "heightCm",
    header: "Height (cm)",
    aliases: ["height", "hcm"],
    kind: "decimal",
    required: false,
    min: 0.1,
    max: 1200,
    example: "60",
    help: "Per-piece dimension.",
  },
  {
    field: "declaredValue",
    header: "Declared Value",
    aliases: ["value", "goodsvalue", "invoiceamount"],
    kind: "money",
    required: false,
    min: 0,
    max: 100000000,
    example: "42000",
    help: "Sets the insurance and claim ceiling.",
  },
  {
    field: "goodsDescription",
    header: "Goods Description",
    aliases: ["goods", "commodity", "description", "contents"],
    kind: "text",
    required: true,
    maxLength: 300,
    example: "Auto spare parts",
    help: "What is inside. Printed on the consignment note.",
  },
  {
    field: "specialInstructions",
    header: "Special Instructions",
    aliases: ["instructions", "remarks", "notes"],
    kind: "text",
    required: false,
    maxLength: 300,
    example: "Deliver before 5 pm",
    help: "Optional.",
  },
  {
    field: "isFragile",
    header: "Fragile",
    aliases: ["fragile", "handlewithcare"],
    kind: "boolean",
    required: false,
    example: "No",
    help: "Yes/No.",
  },

  // ── Payment ─────────────────────────────────────────────────
  {
    field: "paymentType",
    header: "Payment Type",
    aliases: ["payment", "paymentmode", "paybasis"],
    kind: "enum",
    required: true,
    values: ["PAID", "TO_PAY", "TBB", "COD"],
    example: "PAID",
    help: "PAID, TO_PAY, TBB or COD.",
  },
  {
    field: "codAmount",
    header: "COD Amount",
    aliases: ["cod", "codvalue", "amounttocollect"],
    kind: "money",
    required: false,
    min: 0,
    max: 10000000,
    example: "",
    help: "Required when Payment Type is COD, and only then.",
  },

  // ── References ──────────────────────────────────────────────
  {
    field: "customerReference",
    header: "Customer Reference",
    aliases: ["reference", "refno", "orderno", "ordernumber", "docket"],
    kind: "text",
    required: false,
    maxLength: 60,
    example: "SO-2026-00184",
    help: "Your own order number. Must be unique across all shipments.",
  },
  {
    field: "ewayBillNumber",
    header: "E-Way Bill",
    aliases: ["ewaybill", "ewb", "ewbno"],
    kind: "text",
    required: false,
    maxLength: 30,
    example: "",
    help: "Twelve digits, where the consignment needs one.",
  },
  {
    field: "invoiceNumber",
    header: "Invoice Number",
    aliases: ["invoiceno", "billno"],
    kind: "text",
    required: false,
    maxLength: 40,
    example: "INV/26/00912",
    help: "Optional.",
  },
  {
    field: "invoiceValue",
    header: "Invoice Value",
    aliases: ["invoicevalue", "billvalue"],
    kind: "money",
    required: false,
    min: 0,
    max: 100000000,
    example: "42000",
    help: "Optional.",
  },
  {
    field: "pickupRequired",
    header: "Pickup Required",
    aliases: ["pickup", "needspickup", "collection"],
    kind: "boolean",
    required: false,
    example: "Yes",
    help: "Yes/No. Defaults to Yes.",
  },
];

export const COLUMN_BY_FIELD: ReadonlyMap<string, ColumnDef> = new Map(
  COLUMNS.map((c) => [c.field, c]),
);

export const REQUIRED_FIELDS: readonly string[] = COLUMNS.filter(
  (c) => c.required,
).map((c) => c.field);

/**
 * Header matching key.
 *
 * Strips everything that is not a letter or digit, so "Consignee PIN",
 * "consignee_pin" and "CONSIGNEE-PIN " all land on the same column. Real
 * customer files vary in exactly these ways and in no more interesting
 * ones.
 */
export function normaliseHeader(header: string): string {
  return header
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const HEADER_LOOKUP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const column of COLUMNS) {
    for (const spelling of [column.header, column.field, ...(column.aliases ?? [])]) {
      map.set(normaliseHeader(spelling), column.field);
    }
  }
  return map;
})();

/** The canonical field a header names, or null when nothing matches. */
export function fieldForHeader(header: string): string | null {
  return HEADER_LOOKUP.get(normaliseHeader(header)) ?? null;
}

export const TEMPLATE_HEADERS: readonly string[] = COLUMNS.map((c) => c.header);
