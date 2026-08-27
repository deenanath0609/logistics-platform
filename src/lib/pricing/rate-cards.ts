import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { RateBasis, ChargeBasis, ShipmentMode } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { recordAudit } from "@/server/services/audit";
import type { ChargeCondition } from "./engine";

/**
 * Rate-card administration.
 *
 * The one rule everything here exists to enforce: an approved version is
 * frozen. Invoices reference it, and editing one would rewrite history —
 * a customer's June invoice would silently reprice at July's rates and
 * nobody would ever know why the ledger stopped agreeing.
 *
 * Drafts are freely editable. Approving is a separate, audited act.
 */

export type Result<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const FROZEN =
  "This version is approved and cannot be edited — invoices reference it. " +
  "Create a new version instead.";

/** Throws nothing; returns the guard message when the version is frozen. */
export async function assertDraft(
  versionId: string,
  client: Pick<typeof prisma, "rateCardVersion"> = prisma,
): Promise<string | null> {
  const version = await client.rateCardVersion.findUnique({
    where: { id: versionId },
    select: { isApproved: true },
  });

  if (!version) return "That rate-card version no longer exists.";
  return version.isApproved ? FROZEN : null;
}

// ────────────────────────────────────────────────────────────
// Cards
// ────────────────────────────────────────────────────────────

export async function createRateCard(
  input: {
    code: string;
    name: string;
    customerId?: string | null;
    isDefault?: boolean;
    notes?: string | null;
    /** Effective-from for the first draft version. */
    effectiveFrom: Date;
  },
  actor: SessionUser,
): Promise<Result<{ rateCardId: string; versionId: string }>> {
  if (!can(actor, "ratecard.manage")) {
    return { ok: false, error: "You do not have permission to manage rate cards." };
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const card = await tx.rateCard.create({
        data: {
          orgId: actor.orgId,
          code: input.code.toUpperCase(),
          name: input.name,
          customerId: input.customerId || null,
          isDefault: input.isDefault ?? false,
          notes: input.notes ?? undefined,
          createdById: actor.id,
        },
        select: { id: true, code: true },
      });

      // Every card starts with a draft v1 — a card with no version cannot
      // price anything, and making the operator create one by hand is a
      // step nobody ever remembers.
      const version = await tx.rateCardVersion.create({
        data: {
          rateCardId: card.id,
          version: 1,
          effectiveFrom: input.effectiveFrom,
          isApproved: false,
        },
        select: { id: true },
      });

      return { card, version };
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "RateCard",
      entityId: created.card.id,
      entityRef: created.card.code,
      after: {
        code: created.card.code,
        name: input.name,
        customerId: input.customerId ?? null,
        scope: input.customerId ? "CUSTOMER" : "PUBLISHED",
      },
    });

    return { ok: true, rateCardId: created.card.id, versionId: created.version.id };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

export async function updateRateCard(
  input: {
    rateCardId: string;
    name?: string;
    notes?: string | null;
    isActive?: boolean;
    isDefault?: boolean;
  },
  actor: SessionUser,
): Promise<Result> {
  if (!can(actor, "ratecard.manage")) {
    return { ok: false, error: "You do not have permission to manage rate cards." };
  }

  const before = await prisma.rateCard.findUnique({
    where: { id: input.rateCardId },
    select: { id: true, code: true, name: true, notes: true, isActive: true, isDefault: true },
  });
  if (!before) return { ok: false, error: "That rate card no longer exists." };

  const after = await prisma.rateCard.update({
    where: { id: input.rateCardId },
    data: {
      name: input.name ?? undefined,
      notes: input.notes === undefined ? undefined : input.notes,
      isActive: input.isActive ?? undefined,
      isDefault: input.isDefault ?? undefined,
    },
    select: { code: true, name: true, notes: true, isActive: true, isDefault: true },
  });

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "RateCard",
    entityId: input.rateCardId,
    entityRef: before.code,
    before,
    after,
  });

  return { ok: true };
}

// ────────────────────────────────────────────────────────────
// Versions
// ────────────────────────────────────────────────────────────

/**
 * Opens a new draft version.
 *
 * Slabs and rules are copied from the version being superseded, because a
 * revision is almost always "last year's card with three rates changed" —
 * retyping forty slabs to change three is how a card gets a typo in it.
 */
export async function createVersion(
  input: {
    rateCardId: string;
    effectiveFrom: Date;
    effectiveTo?: Date | null;
    copyFromVersionId?: string | null;
    notes?: string | null;
  },
  actor: SessionUser,
): Promise<Result<{ versionId: string; version: number; copiedSlabs: number }>> {
  if (!can(actor, "ratecard.manage")) {
    return { ok: false, error: "You do not have permission to manage rate cards." };
  }

  const card = await prisma.rateCard.findUnique({
    where: { id: input.rateCardId },
    select: {
      id: true,
      code: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { id: true, version: true } },
    },
  });
  if (!card) return { ok: false, error: "That rate card no longer exists." };

  const nextVersionNumber = (card.versions[0]?.version ?? 0) + 1;
  const copyFrom = input.copyFromVersionId ?? card.versions[0]?.id ?? null;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const version = await tx.rateCardVersion.create({
        data: {
          rateCardId: card.id,
          version: nextVersionNumber,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? undefined,
          isApproved: false,
          notes: input.notes ?? undefined,
        },
        select: { id: true },
      });

      let copiedSlabs = 0;

      if (copyFrom) {
        const source = await tx.rateCardVersion.findUnique({
          where: { id: copyFrom },
          select: { slabs: true, rules: true },
        });

        if (source) {
          if (source.slabs.length > 0) {
            await tx.rateSlab.createMany({
              data: source.slabs.map((slab) => ({
                versionId: version.id,
                serviceTypeId: slab.serviceTypeId,
                mode: slab.mode,
                originZoneId: slab.originZoneId,
                destinationZoneId: slab.destinationZoneId,
                originCityId: slab.originCityId,
                destinationCityId: slab.destinationCityId,
                vehicleTypeId: slab.vehicleTypeId,
                weightFromKg: slab.weightFromKg,
                weightToKg: slab.weightToKg,
                basis: slab.basis,
                rate: slab.rate,
                minimumCharge: slab.minimumCharge,
                minimumChargeableKg: slab.minimumChargeableKg,
                transitHours: slab.transitHours,
                priority: slab.priority,
              })),
            });
            copiedSlabs = source.slabs.length;
          }

          if (source.rules.length > 0) {
            await tx.chargeRule.createMany({
              data: source.rules.map((rule) => ({
                versionId: version.id,
                chargeTypeId: rule.chargeTypeId,
                basis: rule.basis,
                rate: rule.rate,
                minimumAmount: rule.minimumAmount,
                maximumAmount: rule.maximumAmount,
                appliesWhen: rule.appliesWhen ?? Prisma.JsonNull,
                isAutomatic: rule.isAutomatic,
                sortOrder: rule.sortOrder,
              })),
            });
          }
        }
      }

      return { version, copiedSlabs };
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "RateCardVersion",
      entityId: created.version.id,
      entityRef: `${card.code} v${nextVersionNumber}`,
      after: {
        version: nextVersionNumber,
        effectiveFrom: input.effectiveFrom.toISOString().slice(0, 10),
        copiedFrom: copyFrom,
        copiedSlabs: created.copiedSlabs,
      },
    });

    return {
      ok: true,
      versionId: created.version.id,
      version: nextVersionNumber,
      copiedSlabs: created.copiedSlabs,
    };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

export async function updateVersionDates(
  input: {
    versionId: string;
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    notes?: string | null;
  },
  actor: SessionUser,
): Promise<Result> {
  if (!can(actor, "ratecard.manage")) {
    return { ok: false, error: "You do not have permission to manage rate cards." };
  }

  const frozen = await assertDraft(input.versionId);
  if (frozen) return { ok: false, error: frozen };

  const before = await prisma.rateCardVersion.findUnique({
    where: { id: input.versionId },
    select: {
      effectiveFrom: true,
      effectiveTo: true,
      notes: true,
      version: true,
      rateCard: { select: { code: true } },
    },
  });
  if (!before) return { ok: false, error: "That version no longer exists." };

  await prisma.rateCardVersion.update({
    where: { id: input.versionId },
    data: {
      effectiveFrom: input.effectiveFrom ?? undefined,
      effectiveTo: input.effectiveTo === undefined ? undefined : input.effectiveTo,
      notes: input.notes === undefined ? undefined : input.notes,
    },
  });

  await recordAudit({
    user: actor,
    action: "UPDATE",
    entity: "RateCardVersion",
    entityId: input.versionId,
    entityRef: `${before.rateCard.code} v${before.version}`,
    before: {
      effectiveFrom: before.effectiveFrom,
      effectiveTo: before.effectiveTo,
      notes: before.notes,
    },
    after: {
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      notes: input.notes,
    },
  });

  return { ok: true };
}

/**
 * Approves a version, freezing it.
 *
 * Deliberately one-way. "Unapproving" would be indistinguishable from
 * editing an approved version, which is the thing this whole module
 * exists to prevent; the way back is a new version.
 */
export async function approveVersion(
  input: { versionId: string; reason: string },
  actor: SessionUser,
): Promise<Result<{ label: string }>> {
  if (!can(actor, "ratecard.manage")) {
    return { ok: false, error: "You do not have permission to approve rate cards." };
  }
  if (!input.reason?.trim()) {
    return { ok: false, error: "Give a reason — approving a rate card is audited." };
  }

  const version = await prisma.rateCardVersion.findUnique({
    where: { id: input.versionId },
    select: {
      id: true,
      version: true,
      isApproved: true,
      effectiveFrom: true,
      effectiveTo: true,
      rateCard: { select: { id: true, code: true, customerId: true } },
      _count: { select: { slabs: true, rules: true } },
    },
  });

  if (!version) return { ok: false, error: "That version no longer exists." };
  if (version.isApproved) return { ok: false, error: "That version is already approved." };
  if (version._count.slabs === 0) {
    return {
      ok: false,
      error:
        "This version has no rate slabs. Approving it would price every lane as " +
        "unrated — add at least one before approving.",
    };
  }

  const label = `${version.rateCard.code} v${version.version}`;

  await prisma.rateCardVersion.update({
    where: { id: version.id },
    data: { isApproved: true, approvedAt: new Date(), approvedById: actor.id },
  });

  await recordAudit({
    user: actor,
    action: "APPROVE",
    entity: "RateCardVersion",
    entityId: version.id,
    entityRef: label,
    before: { isApproved: false },
    after: {
      isApproved: true,
      slabs: version._count.slabs,
      chargeRules: version._count.rules,
      effectiveFrom: version.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: version.effectiveTo?.toISOString().slice(0, 10) ?? null,
    },
    reason: input.reason.trim(),
  });

  return { ok: true, label };
}

// ────────────────────────────────────────────────────────────
// Slabs and charge rules
// ────────────────────────────────────────────────────────────

export type SlabInput = {
  id?: string | null;
  versionId: string;
  serviceTypeId?: string | null;
  mode?: ShipmentMode | null;
  originZoneId?: string | null;
  destinationZoneId?: string | null;
  originCityId?: string | null;
  destinationCityId?: string | null;
  vehicleTypeId?: string | null;
  weightFromKg?: string | number | null;
  weightToKg?: string | number | null;
  basis: RateBasis;
  rate: string | number;
  minimumCharge?: string | number | null;
  minimumChargeableKg?: string | number | null;
  transitHours?: number | null;
  priority?: number;
};

export async function saveSlab(
  input: SlabInput,
  actor: SessionUser,
): Promise<Result<{ slabId: string }>> {
  if (!can(actor, "ratecard.manage")) {
    return { ok: false, error: "You do not have permission to manage rate cards." };
  }

  const frozen = await assertDraft(input.versionId);
  if (frozen) return { ok: false, error: frozen };

  if (
    input.weightFromKg !== null &&
    input.weightFromKg !== undefined &&
    input.weightToKg !== null &&
    input.weightToKg !== undefined &&
    Number(input.weightToKg) <= Number(input.weightFromKg)
  ) {
    return { ok: false, error: "The band's upper bound must be above its lower bound." };
  }

  const data = {
    versionId: input.versionId,
    serviceTypeId: input.serviceTypeId || null,
    mode: input.mode || null,
    originZoneId: input.originZoneId || null,
    destinationZoneId: input.destinationZoneId || null,
    originCityId: input.originCityId || null,
    destinationCityId: input.destinationCityId || null,
    vehicleTypeId: input.vehicleTypeId || null,
    weightFromKg: nullableDecimal(input.weightFromKg),
    weightToKg: nullableDecimal(input.weightToKg),
    basis: input.basis,
    rate: String(input.rate),
    minimumCharge: nullableDecimal(input.minimumCharge),
    minimumChargeableKg: nullableDecimal(input.minimumChargeableKg),
    transitHours: input.transitHours ?? null,
    priority: input.priority ?? 0,
  };

  try {
    const slab = input.id
      ? await prisma.rateSlab.update({
          where: { id: input.id },
          data,
          select: { id: true },
        })
      : await prisma.rateSlab.create({ data, select: { id: true } });

    await recordAudit({
      user: actor,
      action: input.id ? "UPDATE" : "CREATE",
      entity: "RateSlab",
      entityId: slab.id,
      entityRef: `${data.basis} @ ${data.rate}`,
      after: data,
    });

    return { ok: true, slabId: slab.id };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

export async function deleteSlab(
  input: { slabId: string },
  actor: SessionUser,
): Promise<Result> {
  if (!can(actor, "ratecard.manage")) {
    return { ok: false, error: "You do not have permission to manage rate cards." };
  }

  const slab = await prisma.rateSlab.findUnique({
    where: { id: input.slabId },
    select: { id: true, versionId: true, basis: true, rate: true },
  });
  if (!slab) return { ok: false, error: "That slab no longer exists." };

  const frozen = await assertDraft(slab.versionId);
  if (frozen) return { ok: false, error: frozen };

  await prisma.rateSlab.delete({ where: { id: slab.id } });

  await recordAudit({
    user: actor,
    action: "DELETE",
    entity: "RateSlab",
    entityId: slab.id,
    entityRef: `${slab.basis} @ ${slab.rate.toString()}`,
    before: { basis: slab.basis, rate: slab.rate.toString() },
  });

  return { ok: true };
}

export type ChargeRuleInput = {
  id?: string | null;
  versionId: string;
  chargeTypeId: string;
  basis: ChargeBasis;
  rate: string | number;
  minimumAmount?: string | number | null;
  maximumAmount?: string | number | null;
  appliesWhen?: ChargeCondition | null;
  isAutomatic?: boolean;
  sortOrder?: number;
};

export async function saveChargeRule(
  input: ChargeRuleInput,
  actor: SessionUser,
): Promise<Result<{ ruleId: string }>> {
  if (!can(actor, "ratecard.manage")) {
    return { ok: false, error: "You do not have permission to manage rate cards." };
  }

  const frozen = await assertDraft(input.versionId);
  if (frozen) return { ok: false, error: frozen };

  const data = {
    versionId: input.versionId,
    chargeTypeId: input.chargeTypeId,
    basis: input.basis,
    rate: String(input.rate),
    minimumAmount: nullableDecimal(input.minimumAmount),
    maximumAmount: nullableDecimal(input.maximumAmount),
    appliesWhen: (input.appliesWhen ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    isAutomatic: input.isAutomatic ?? true,
    sortOrder: input.sortOrder ?? 0,
  };

  try {
    const rule = input.id
      ? await prisma.chargeRule.update({
          where: { id: input.id },
          data,
          select: { id: true },
        })
      : await prisma.chargeRule.create({ data, select: { id: true } });

    await recordAudit({
      user: actor,
      action: input.id ? "UPDATE" : "CREATE",
      entity: "ChargeRule",
      entityId: rule.id,
      entityRef: `${input.basis} @ ${input.rate}`,
      after: data,
    });

    return { ok: true, ruleId: rule.id };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

export async function deleteChargeRule(
  input: { ruleId: string },
  actor: SessionUser,
): Promise<Result> {
  if (!can(actor, "ratecard.manage")) {
    return { ok: false, error: "You do not have permission to manage rate cards." };
  }

  const rule = await prisma.chargeRule.findUnique({
    where: { id: input.ruleId },
    select: { id: true, versionId: true, basis: true, rate: true },
  });
  if (!rule) return { ok: false, error: "That charge rule no longer exists." };

  const frozen = await assertDraft(rule.versionId);
  if (frozen) return { ok: false, error: frozen };

  await prisma.chargeRule.delete({ where: { id: rule.id } });

  await recordAudit({
    user: actor,
    action: "DELETE",
    entity: "ChargeRule",
    entityId: rule.id,
    entityRef: `${rule.basis} @ ${rule.rate.toString()}`,
    before: { basis: rule.basis, rate: rule.rate.toString() },
  });

  return { ok: true };
}

// ────────────────────────────────────────────────────────────
// Fuel surcharge rules
// ────────────────────────────────────────────────────────────

export async function saveFuelRule(
  input: {
    id?: string | null;
    percent: string | number;
    effectiveFrom: Date;
    effectiveTo?: Date | null;
    notes?: string | null;
  },
  actor: SessionUser,
): Promise<Result> {
  if (!can(actor, "ratecard.manage")) {
    return { ok: false, error: "You do not have permission to set the fuel surcharge." };
  }

  const data = {
    orgId: actor.orgId,
    percent: String(input.percent),
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    notes: input.notes ?? null,
    createdById: actor.id,
  };

  const rule = input.id
    ? await prisma.fuelSurchargeRule.update({
        where: { id: input.id },
        data,
        select: { id: true },
      })
    : await prisma.fuelSurchargeRule.create({ data, select: { id: true } });

  await recordAudit({
    user: actor,
    action: input.id ? "UPDATE" : "CREATE",
    entity: "FuelSurchargeRule",
    entityId: rule.id,
    entityRef: `${input.percent}%`,
    after: {
      percent: String(input.percent),
      effectiveFrom: input.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: input.effectiveTo?.toISOString().slice(0, 10) ?? null,
    },
    reason: "Fuel surcharge revision — every shipment priced from this date moves.",
  });

  return { ok: true };
}

function nullableDecimal(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unique constraint")) {
    return "Another rate card already uses that code.";
  }
  if (message.includes("Foreign key constraint")) {
    return "A referenced master is missing or has been removed.";
  }
  console.error("[pricing/rate-cards]", error);
  return "Something went wrong. The change was not applied.";
}
