import { db, step, done } from "./client";
import type { ReasonCategory } from "../../src/generated/prisma/client";

const SERVICE_TYPES = [
  {
    code: "FTL-STD", name: "Full Truck Load — Standard", mode: "FTL" as const,
    volumetricDivisor: 5000, defaultTransitHours: 48,
    allowsCod: false, allowsToPay: true, maxDeliveryAttempts: 2,
    description: "Dedicated vehicle, point to point, no hub handling.",
  },
  {
    code: "PTL-EXP", name: "Part Load — Express", mode: "PTL" as const,
    volumetricDivisor: 4500, defaultTransitHours: 24,
    allowsCod: true, allowsToPay: true, maxDeliveryAttempts: 3,
    description: "Shared vehicle, priority sorting and dispatch.",
  },
  {
    code: "PTL-STD", name: "Part Load — Standard", mode: "PTL" as const,
    volumetricDivisor: 5000, defaultTransitHours: 72,
    allowsCod: true, allowsToPay: true, maxDeliveryAttempts: 3,
    description: "Shared vehicle, standard consolidation.",
  },
  {
    code: "CRR-EXP", name: "Courier — Express", mode: "COURIER" as const,
    volumetricDivisor: 5000, defaultTransitHours: 48,
    allowsCod: true, allowsToPay: false, maxDeliveryAttempts: 3,
    description: "Small parcels, full sortation, high-volume last mile.",
  },
];

const PACKAGE_TYPES = [
  { code: "BOX", name: "Box", isFragile: false, isStackable: true },
  { code: "CARTON", name: "Carton", isFragile: false, isStackable: true },
  { code: "PALLET", name: "Pallet", isFragile: false, isStackable: false },
  { code: "BAG", name: "Bag / Sack", isFragile: false, isStackable: true },
  { code: "DRUM", name: "Drum / Barrel", isFragile: false, isStackable: false },
  { code: "CRATE", name: "Wooden Crate", isFragile: true, isStackable: true },
  { code: "BUNDLE", name: "Bundle", isFragile: false, isStackable: true },
  { code: "GLASS", name: "Glass / Fragile", isFragile: true, isStackable: false },
  { code: "LOOSE", name: "Loose", isFragile: false, isStackable: false },
];

const TAX_RATES = [
  {
    code: "GST5-RCM", name: "GST 5% — GTA reverse charge", kind: "GST" as const,
    ratePercent: 5, isReverseCharge: true, hsnSac: "996511",
  },
  {
    code: "GST12-FCM", name: "GST 12% — GTA forward charge", kind: "GST" as const,
    ratePercent: 12, isReverseCharge: false, hsnSac: "996511",
  },
  {
    code: "GST18", name: "GST 18% — support services", kind: "GST" as const,
    ratePercent: 18, isReverseCharge: false, hsnSac: "996799",
  },
  {
    code: "GST0", name: "Exempt / Nil rated", kind: "GST" as const,
    ratePercent: 0, isReverseCharge: false, hsnSac: "996511",
  },
  {
    code: "TDS-2", name: "TDS 194C — 2%", kind: "TDS" as const,
    ratePercent: 2, isReverseCharge: false, hsnSac: null,
  },
];

const CHARGE_TYPES = [
  { code: "FREIGHT", name: "Base Freight", nature: "FREIGHT" as const, basis: "PER_KG" as const, tax: "GST5-RCM", order: 10 },
  { code: "FSC", name: "Fuel Surcharge", nature: "SURCHARGE" as const, basis: "PERCENT_OF_FREIGHT" as const, tax: "GST5-RCM", order: 20 },
  { code: "DOCKET", name: "Docket / LR Charge", nature: "HANDLING" as const, basis: "FLAT" as const, tax: "GST18", order: 30 },
  { code: "HANDLING", name: "Handling Charge", nature: "HANDLING" as const, basis: "PER_PACKAGE" as const, tax: "GST18", order: 40 },
  { code: "LOADING", name: "Loading Charge", nature: "HANDLING" as const, basis: "PER_PACKAGE" as const, tax: "GST18", order: 50 },
  { code: "UNLOADING", name: "Unloading Charge", nature: "HANDLING" as const, basis: "PER_PACKAGE" as const, tax: "GST18", order: 60 },
  { code: "ODA", name: "Out of Delivery Area", nature: "SURCHARGE" as const, basis: "PER_KG" as const, tax: "GST5-RCM", order: 70 },
  { code: "INSURANCE", name: "Risk / Insurance", nature: "SURCHARGE" as const, basis: "PERCENT_OF_DECLARED_VALUE" as const, tax: "GST18", order: 80 },
  { code: "COD_FEE", name: "COD Collection Fee", nature: "SURCHARGE" as const, basis: "PERCENT_OF_COD" as const, tax: "GST18", order: 90 },
  { code: "DETENTION", name: "Detention / Waiting", nature: "PENALTY" as const, basis: "PER_HOUR" as const, tax: "GST18", order: 100 },
  { code: "RTO_FREIGHT", name: "Return to Origin Freight", nature: "FREIGHT" as const, basis: "PER_KG" as const, tax: "GST5-RCM", order: 110 },
  { code: "REATTEMPT", name: "Re-attempt Charge", nature: "PENALTY" as const, basis: "FLAT" as const, tax: "GST18", order: 120 },
  { code: "GREEN_TAX", name: "Green / Toll Levy", nature: "STATUTORY" as const, basis: "FLAT" as const, tax: "GST0", order: 130 },
  { code: "DISCOUNT", name: "Discount", nature: "DISCOUNT" as const, basis: "FLAT" as const, tax: "GST0", order: 900, visible: true },
];

type ReasonSeed = {
  code: string;
  name: string;
  chargeable?: boolean;
  reattempt?: boolean;
  exception?: boolean;
  consignor?: boolean;
  consignee?: boolean;
  photo?: boolean;
  remarks?: boolean;
};

const REASONS: Record<ReasonCategory, ReasonSeed[]> = {
  PICKUP_FAILURE: [
    { code: "PF-NOT-READY", name: "Shipment not ready", consignor: true },
    { code: "PF-CLOSED", name: "Premises closed", photo: true, consignor: true },
    { code: "PF-UNREACHABLE", name: "Consignor unreachable", consignor: true },
    { code: "PF-CANCELLED", name: "Cancelled by consignor", consignor: true },
    { code: "PF-EXCESS", name: "Volume exceeds vehicle capacity", exception: true, remarks: true },
    { code: "PF-DOCS", name: "Documents not ready (e-way bill / invoice)", consignor: true },
    { code: "PF-ADDRESS", name: "Address not found", photo: true, exception: true },
    { code: "PF-OTHER", name: "Other", remarks: true, exception: true },
  ],
  DELIVERY_FAILURE: [
    { code: "DF-UNAVAILABLE", name: "Consignee not available", reattempt: true, consignee: true, consignor: true },
    { code: "DF-WRONG-ADDR", name: "Wrong address", chargeable: true, exception: true, photo: true, consignor: true },
    { code: "DF-INCOMPLETE", name: "Address incomplete", exception: true, consignee: true, consignor: true },
    { code: "DF-REFUSED", name: "Consignee refused delivery", chargeable: true, exception: true, remarks: true, consignor: true },
    { code: "DF-UNREACHABLE", name: "Phone unreachable", reattempt: true, consignor: true },
    { code: "DF-CLOSED", name: "Premises closed / holiday", reattempt: true, consignee: true },
    { code: "DF-PAYMENT", name: "Payment not ready (COD / To-Pay)", chargeable: true, reattempt: true, consignor: true, consignee: true },
    { code: "DF-DAMAGED", name: "Shipment damaged — not accepted", exception: true, photo: true, remarks: true, consignor: true },
    { code: "DF-ODA", name: "Delivery area inaccessible", chargeable: true, exception: true, remarks: true },
    { code: "DF-VEHICLE", name: "Vehicle breakdown / agent unavailable", reattempt: true, exception: true },
    { code: "DF-OTHER", name: "Other", remarks: true, exception: true },
  ],
  EXCEPTION: [
    { code: "EX-SLA-RISK", name: "SLA at risk" },
    { code: "EX-SLA-BREACH", name: "SLA breached" },
    { code: "EX-NO-GPS", name: "No GPS update" },
    { code: "EX-STOPPED", name: "Vehicle stopped beyond threshold" },
    { code: "EX-DEVIATION", name: "Route deviation" },
    { code: "EX-DWELL", name: "Shipment idle at hub" },
    { code: "EX-POD-PENDING", name: "POD pending beyond 24 hours" },
    { code: "EX-MISROUTED", name: "Misrouted shipment", remarks: true },
    { code: "EX-LOST", name: "Shipment lost", remarks: true, photo: false },
    { code: "EX-COD-SHORT", name: "COD shortfall at day end", remarks: true },
  ],
  CANCELLATION: [
    { code: "CN-CUSTOMER", name: "Cancelled by customer", consignor: true },
    { code: "CN-DUPLICATE", name: "Duplicate booking" },
    { code: "CN-ERROR", name: "Booking error", remarks: true },
    { code: "CN-UNSERVICEABLE", name: "Destination unserviceable", consignor: true },
  ],
  HOLD: [
    { code: "HD-CUSTOMER", name: "Hold requested by customer", consignor: true },
    { code: "HD-PAYMENT", name: "Credit limit / payment block" },
    { code: "HD-DOCS", name: "Documents pending (e-way bill)", exception: true },
    { code: "HD-LEGAL", name: "Regulatory / legal hold", remarks: true, exception: true },
  ],
  DAMAGE: [
    { code: "DM-TRANSIT", name: "Damaged in transit", photo: true, remarks: true, exception: true },
    { code: "DM-HANDLING", name: "Damaged in handling", photo: true, remarks: true, exception: true },
    { code: "DM-PACKING", name: "Inadequate packing by consignor", photo: true, remarks: true },
    { code: "DM-WET", name: "Water damage", photo: true, remarks: true, exception: true },
  ],
  SHORTAGE: [
    { code: "SH-SHORT", name: "Short received against manifest", exception: true, remarks: true },
    { code: "SH-EXCESS", name: "Excess received against manifest", exception: true, remarks: true },
    { code: "SH-SEAL", name: "Seal broken on arrival", photo: true, remarks: true, exception: true },
  ],
  RTO: [
    { code: "RT-ATTEMPTS", name: "Maximum delivery attempts exhausted", chargeable: true, consignor: true },
    { code: "RT-REFUSED", name: "Consignee refused", chargeable: true, consignor: true },
    { code: "RT-REQUESTED", name: "Return requested by consignor", chargeable: true },
  ],
  STATUS_CORRECTION: [
    { code: "SC-MISSCAN", name: "Incorrect scan", remarks: true },
    { code: "SC-SYSTEM", name: "System / sync error", remarks: true },
    { code: "SC-BACKDATE", name: "Backdated entry (offline capture)", remarks: true },
  ],
};

const NUMBER_SERIES = [
  // `prefix` is filled in from the organisation below: a consignment note
  // number is printed on the carrier's own paperwork, so it must carry the
  // carrier's letters and not ours.
  { document: "LR" as const, pattern: "{PREFIX}{YYYY}{MM}{DD}{SEQ}", prefix: "", padding: 4, reset: "DAILY" as const },
  { document: "MANIFEST" as const, pattern: "M{SEQ}", prefix: "M", padding: 6, reset: "NEVER" as const },
  { document: "TRIP" as const, pattern: "TRIP-{YYYY}-{SEQ}", prefix: "TRIP", padding: 5, reset: "FINANCIAL_YEAR" as const },
  { document: "PICKUP" as const, pattern: "PU{YY}{MM}{DD}{SEQ}", prefix: "PU", padding: 4, reset: "DAILY" as const },
  { document: "DELIVERY_RUN" as const, pattern: "RUN-{BRANCH}-{YY}{MM}{DD}-{SEQ}", prefix: "RUN", padding: 2, reset: "DAILY" as const },
  { document: "INVOICE" as const, pattern: "INV/{FY}/{BRANCH}/{SEQ}", prefix: "INV", padding: 4, reset: "FINANCIAL_YEAR" as const },
  { document: "EXCEPTION" as const, pattern: "EXC{SEQ}", prefix: "EXC", padding: 7, reset: "NEVER" as const },
  { document: "COMPLAINT" as const, pattern: "CMP{SEQ}", prefix: "CMP", padding: 6, reset: "NEVER" as const },
];

export async function seedMasters(orgId: string) {
  step("service types");
  for (const s of SERVICE_TYPES) {
    await db.serviceType.upsert({
      where: { orgId_code: { orgId, code: s.code } },
      create: { ...s, orgId },
      update: s,
    });
  }
  done(SERVICE_TYPES.length);

  step("package types");
  for (const [i, pkg] of PACKAGE_TYPES.entries()) {
    await db.packageType.upsert({
      where: { orgId_code: { orgId, code: pkg.code } },
      create: { ...pkg, orgId, sortOrder: i * 10 },
      update: { ...pkg, sortOrder: i * 10 },
    });
  }
  done(PACKAGE_TYPES.length);

  step("tax rates");
  const taxIds = new Map<string, string>();
  const effectiveFrom = new Date("2024-04-01");
  for (const t of TAX_RATES) {
    const row = await db.taxRate.upsert({
      where: { orgId_code: { orgId, code: t.code } },
      create: { ...t, orgId, effectiveFrom },
      update: { name: t.name, ratePercent: t.ratePercent, isReverseCharge: t.isReverseCharge },
    });
    taxIds.set(t.code, row.id);
  }
  done(TAX_RATES.length);

  step("charge types");
  for (const c of CHARGE_TYPES) {
    await db.chargeType.upsert({
      where: { orgId_code: { orgId, code: c.code } },
      create: {
        orgId,
        code: c.code,
        name: c.name,
        nature: c.nature,
        defaultBasis: c.basis,
        taxRateId: taxIds.get(c.tax),
        sortOrder: c.order,
      },
      update: {
        name: c.name,
        nature: c.nature,
        defaultBasis: c.basis,
        taxRateId: taxIds.get(c.tax),
        sortOrder: c.order,
      },
    });
  }
  done(CHARGE_TYPES.length);

  step("reason codes");
  let reasonCount = 0;
  const reasonGroups = Object.entries(REASONS) as [ReasonCategory, ReasonSeed[]][];
  for (const [category, list] of reasonGroups) {
    for (const [i, r] of list.entries()) {
      const data = {
        name: r.name,
        isChargeable: r.chargeable ?? false,
        triggersReattempt: r.reattempt ?? false,
        triggersException: r.exception ?? false,
        notifiesConsignor: r.consignor ?? false,
        notifiesConsignee: r.consignee ?? false,
        requiresPhoto: r.photo ?? false,
        requiresRemarks: r.remarks ?? false,
        sortOrder: i * 10,
      };
      await db.reasonCode.upsert({
        where: { orgId_category_code: { orgId, category, code: r.code } },
        create: { orgId, category, code: r.code, ...data },
        update: data,
      });
      reasonCount++;
    }
  }
  done(reasonCount);

  step("number series");

  // The LR prefix belongs to the carrier, not to the platform. Read once
  // here rather than passed in, so a caller cannot seed one tenant's series
  // with another's letters.
  const org = await db.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { lrPrefix: true },
  });

  for (const n of NUMBER_SERIES) {
    // Not an upsert: branchId is null on these network-wide series, and a
    // compound unique containing a null cannot be used as a `where` target.
    const existing = await db.numberSeries.findFirst({
      where: { orgId, document: n.document, branchId: null },
    });

    const data = {
      pattern: n.pattern,
      prefix: n.document === "LR" ? org.lrPrefix : n.prefix,
      padding: n.padding,
      resetPolicy: n.reset,
    };

    if (existing) {
      // Never reset currentValue — that would re-issue numbers already printed.
      await db.numberSeries.update({ where: { id: existing.id }, data });
    } else {
      await db.numberSeries.create({
        data: { orgId, document: n.document, ...data },
      });
    }
  }
  done(NUMBER_SERIES.length);
}
