import { db, step, done } from "./client";
import { Prisma } from "../../src/generated/prisma/client";
import type { ChargeCondition } from "../../src/lib/pricing/engine";

/**
 * A published tariff, so a fresh install does not book at zero rupees.
 *
 * Without a rate card the engine resolves nothing, flags the consignment
 * `unrated`, and prices it at ₹0 — correctly, and invisibly. Every booking
 * in a new database was therefore free, the re-rate on a hub weighing moved
 * ₹0 to ₹0, and the tolerance check could never fire because a percentage
 * of zero is zero. Nothing was broken; there was simply nothing to price
 * against.
 *
 * These are plausible North-India PTL numbers, not a real tariff. They
 * exist so the money path is exercised end to end from the first run. The
 * card is published (no customer), so a customer-specific card always beats
 * it — the engine resolves most-specific-first.
 *
 * Idempotent, and deliberately conservative: if the card already exists it
 * is left completely alone. An approved version is frozen because invoices
 * reference it, and an operator who has tuned these rates must not have
 * them reset by a re-seed.
 */

const CARD_CODE = "STD-PUBLISHED";

/** Weight bands, inclusive of `fromKg` and exclusive of `toKg`. */
type Slab = {
  service: string;
  fromKg: number;
  toKg: number | null;
  ratePerKg: number;
  minimumCharge: number;
  /** The floor the trade actually bills on: nobody rates a 400-gram carton. */
  minimumChargeableKg: number;
  transitHours: number;
};

const SLABS: Slab[] = [
  // ── Part load, express ──────────────────────────────────
  { service: "PTL-EXP", fromKg: 0, toKg: 20, ratePerKg: 16, minimumCharge: 420, minimumChargeableKg: 10, transitHours: 24 },
  { service: "PTL-EXP", fromKg: 20, toKg: 100, ratePerKg: 13, minimumCharge: 420, minimumChargeableKg: 10, transitHours: 24 },
  { service: "PTL-EXP", fromKg: 100, toKg: 500, ratePerKg: 11, minimumCharge: 420, minimumChargeableKg: 10, transitHours: 30 },
  { service: "PTL-EXP", fromKg: 500, toKg: null, ratePerKg: 9.5, minimumCharge: 420, minimumChargeableKg: 10, transitHours: 30 },

  // ── Part load, standard ─────────────────────────────────
  { service: "PTL-STD", fromKg: 0, toKg: 20, ratePerKg: 12, minimumCharge: 320, minimumChargeableKg: 10, transitHours: 72 },
  { service: "PTL-STD", fromKg: 20, toKg: 100, ratePerKg: 9.5, minimumCharge: 320, minimumChargeableKg: 10, transitHours: 72 },
  { service: "PTL-STD", fromKg: 100, toKg: 500, ratePerKg: 8, minimumCharge: 320, minimumChargeableKg: 10, transitHours: 78 },
  { service: "PTL-STD", fromKg: 500, toKg: null, ratePerKg: 6.75, minimumCharge: 320, minimumChargeableKg: 10, transitHours: 78 },

  // ── Courier ─────────────────────────────────────────────
  { service: "CRR-EXP", fromKg: 0, toKg: 5, ratePerKg: 45, minimumCharge: 90, minimumChargeableKg: 0.5, transitHours: 48 },
  { service: "CRR-EXP", fromKg: 5, toKg: 20, ratePerKg: 32, minimumCharge: 90, minimumChargeableKg: 0.5, transitHours: 48 },
  { service: "CRR-EXP", fromKg: 20, toKg: null, ratePerKg: 24, minimumCharge: 90, minimumChargeableKg: 0.5, transitHours: 48 },
];

/**
 * FTL does not price per kilogram — a booked vehicle costs what it costs
 * whether it leaves half full or full. `PER_TRIP` with a zero weight band
 * so the slab matches any consignment on the lane.
 */
const FTL_TRIP_RATE = 18500;

type Rule = {
  charge: string;
  basis:
    | "FLAT"
    | "PER_KG"
    | "PER_PACKAGE"
    | "PERCENT_OF_FREIGHT"
    | "PERCENT_OF_DECLARED_VALUE"
    | "PERCENT_OF_COD";
  rate: number;
  minimumAmount?: number;
  maximumAmount?: number;
  appliesWhen?: ChargeCondition;
  sortOrder: number;
};

const RULES: Rule[] = [
  // Diesel moves and the surcharge follows. Kept as a rule rather than a
  // constant so a revision is a data change, not a deploy.
  { charge: "FSC", basis: "PERCENT_OF_FREIGHT", rate: 12, sortOrder: 20 },
  { charge: "DOCKET", basis: "FLAT", rate: 60, sortOrder: 30 },
  { charge: "HANDLING", basis: "PER_PACKAGE", rate: 15, minimumAmount: 30, sortOrder: 40 },
  // Only on PINs the network has marked out-of-delivery-area. Charging it
  // everywhere is the single fastest way to lose a customer's trust.
  {
    charge: "ODA",
    basis: "PER_KG",
    rate: 4,
    minimumAmount: 450,
    appliesWhen: { odaOnly: true },
    sortOrder: 70,
  },
  // Risk cover is only meaningful against a declared value, so the rule
  // states that rather than quietly billing 0.1% of nothing.
  {
    charge: "INSURANCE",
    basis: "PERCENT_OF_DECLARED_VALUE",
    rate: 0.1,
    minimumAmount: 25,
    appliesWhen: { requiresDeclaredValue: true },
    sortOrder: 80,
  },
  {
    charge: "COD_FEE",
    basis: "PERCENT_OF_COD",
    rate: 1.5,
    minimumAmount: 50,
    appliesWhen: { codOnly: true },
    sortOrder: 90,
  },
];

export async function seedRateCards(orgId: string) {
  step("published tariff");

  const existing = await db.rateCard.findFirst({
    where: { orgId, code: CARD_CODE },
    include: { versions: { select: { id: true, isApproved: true } } },
  });

  if (existing) {
    done(`kept (${existing.versions.length} version(s), untouched)`);
    return { rateCardId: existing.id };
  }

  const [services, charges] = await Promise.all([
    db.serviceType.findMany({ select: { id: true, code: true, mode: true } }),
    db.chargeType.findMany({ select: { id: true, code: true } }),
  ]);

  const serviceByCode = new Map(services.map((s) => [s.code, s]));
  const chargeByCode = new Map(charges.map((c) => [c.code, c.id]));

  const card = await db.rateCard.create({
    data: {
      orgId,
      code: CARD_CODE,
      name: "Standard published tariff",
      isDefault: true,
      isActive: true,
      notes:
        "Seeded starting point. Customer-specific cards override it — the " +
        "engine resolves most-specific-first.",
    },
  });

  // Effective from the start of the current month, so a consignment booked
  // with a back-dated pickup date still resolves.
  const now = new Date();
  const effectiveFrom = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );

  const version = await db.rateCardVersion.create({
    data: {
      rateCardId: card.id,
      version: 1,
      effectiveFrom,
      // Approved, because a draft prices nothing. The freeze that follows
      // is the point: a re-seed will not touch it.
      isApproved: true,
      approvedAt: new Date(),
      notes: "Seeded and approved so the first booking prices.",
    },
  });

  let slabCount = 0;

  for (const slab of SLABS) {
    const service = serviceByCode.get(slab.service);
    // A tariff line for a service the network does not offer would sit in
    // the table looking authoritative and never match anything.
    if (!service) continue;

    await db.rateSlab.create({
      data: {
        versionId: version.id,
        serviceTypeId: service.id,
        mode: service.mode,
        weightFromKg: slab.fromKg,
        weightToKg: slab.toKg,
        basis: "PER_KG",
        rate: slab.ratePerKg,
        minimumCharge: slab.minimumCharge,
        minimumChargeableKg: slab.minimumChargeableKg,
        transitHours: slab.transitHours,
      },
    });
    slabCount++;
  }

  const ftl = serviceByCode.get("FTL-STD");
  if (ftl) {
    await db.rateSlab.create({
      data: {
        versionId: version.id,
        serviceTypeId: ftl.id,
        mode: "FTL",
        basis: "PER_TRIP",
        rate: FTL_TRIP_RATE,
        minimumCharge: FTL_TRIP_RATE,
        transitHours: 48,
      },
    });
    slabCount++;
  }

  let ruleCount = 0;

  for (const rule of RULES) {
    const chargeTypeId = chargeByCode.get(rule.charge);
    if (!chargeTypeId) continue;

    await db.chargeRule.create({
      data: {
        versionId: version.id,
        chargeTypeId,
        basis: rule.basis,
        rate: rule.rate,
        minimumAmount: rule.minimumAmount ?? null,
        maximumAmount: rule.maximumAmount ?? null,
        appliesWhen: rule.appliesWhen
          ? (rule.appliesWhen as Prisma.InputJsonObject)
          : undefined,
        isAutomatic: true,
        sortOrder: rule.sortOrder,
      },
    });
    ruleCount++;
  }

  done(`${slabCount} slabs, ${ruleCount} charge rules`);

  const skipped = SLABS.length + 1 - slabCount;
  if (skipped > 0) {
    console.log(`    ! ${skipped} slab(s) skipped — no such service type.`);
  }

  return { rateCardId: card.id };
}
