import { db, step, done } from "./client";
import {
  DEFAULT_SLA_POLICIES,
  DEFAULT_ESCALATION_RULES,
  DEFAULT_SLA_SYSTEM_CONFIG,
} from "../../src/lib/sla/defaults";

/**
 * SLA policies, escalation ladders and thresholds.
 *
 * Without at least one policy the scanner returns NOT_APPLICABLE for every
 * shipment, and "no data" on the on-time report is indistinguishable from a
 * broken scanner. These make every booked shipment measurable from day one;
 * an operations manager is expected to argue with the numbers, which is
 * what the admin screen at /masters/sla-policies is for.
 *
 * Idempotent, and deliberately conservative on re-run: an existing policy
 * is left alone rather than reset, because by then somebody has probably
 * tuned it.
 */
export async function seedSla(orgId: string) {
  step("SLA policies");

  const [serviceTypes, cities, zones] = await Promise.all([
    db.serviceType.findMany({ where: { orgId }, select: { id: true, code: true } }),
    db.city.findMany({ where: { orgId }, select: { id: true, code: true } }),
    db.zone.findMany({ where: { orgId }, select: { id: true, code: true } }),
  ]);

  const serviceByCode = new Map(serviceTypes.map((s) => [s.code, s.id]));
  const cityByCode = new Map(cities.map((c) => [c.code, c.id]));
  const zoneByCode = new Map(zones.map((z) => [z.code, z.id]));

  let created = 0;
  let skipped = 0;
  const unresolved: string[] = [];

  for (const seed of DEFAULT_SLA_POLICIES) {
    // A policy referencing a code this install does not have would
    // resolve to "any", silently widening its scope. Skip it and say so.
    const missing: string[] = [];
    const resolve = (
      code: string | null,
      map: Map<string, string>,
      label: string,
    ) => {
      if (!code) return null;
      const id = map.get(code);
      if (!id) missing.push(`${label} ${code}`);
      return id ?? null;
    };

    const serviceTypeId = resolve(seed.serviceTypeCode, serviceByCode, "service");
    const originCityId = resolve(seed.originCityCode, cityByCode, "city");
    const destinationCityId = resolve(seed.destinationCityCode, cityByCode, "city");
    const originZoneId = resolve(seed.originZoneCode, zoneByCode, "zone");
    const destinationZoneId = resolve(seed.destinationZoneCode, zoneByCode, "zone");

    if (missing.length > 0) {
      unresolved.push(`${seed.code} (${missing.join(", ")})`);
      continue;
    }

    const existing = await db.slaPolicy.findFirst({
      where: { orgId, code: seed.code },
    });
    if (existing) {
      skipped++;
      continue;
    }

    await db.slaPolicy.create({
      data: {
        orgId,
        code: seed.code,
        name: seed.name,
        serviceTypeId,
        originCityId,
        destinationCityId,
        originZoneId,
        destinationZoneId,
        transitHours: seed.transitHours,
        useWorkingHours: seed.useWorkingHours,
        respectCutoff: seed.respectCutoff,
        atRiskPercent: seed.atRiskPercent,
        priority: seed.priority,
        isActive: seed.isActive,
      },
    });
    created++;
  }

  done(`${created} new, ${skipped} kept`);
  if (unresolved.length > 0) {
    console.log(`    ! skipped, unknown master: ${unresolved.join("; ")}`);
  }

  // ── Escalation ladders ────────────────────────────────────
  step("escalation rules");

  const roles = await db.role.findMany({
    where: { orgId },
    select: { id: true, code: true },
  });
  const roleByCode = new Map(roles.map((r) => [r.code, r.id]));
  let rungs = 0;

  for (const rule of DEFAULT_ESCALATION_RULES) {
    const roleCode = rule.notifyRoleCode ?? null;
    if (roleCode && !roleByCode.has(roleCode)) continue;

    await db.escalationRule.upsert({
      where: {
        orgId_kind_level: { orgId, kind: rule.kind, level: rule.level },
      },
      create: {
        orgId,
        kind: rule.kind,
        level: rule.level,
        afterMinutes: rule.afterMinutes,
        notifyRoleCode: roleCode,
      },
      update: { afterMinutes: rule.afterMinutes, notifyRoleCode: roleCode },
    });
    rungs++;
  }

  done(rungs);

  // ── Thresholds ────────────────────────────────────────────
  step("SLA thresholds");

  for (const config of DEFAULT_SLA_SYSTEM_CONFIG) {
    const existing = await db.systemConfig.findFirst({
      where: { orgId, key: config.key },
    });

    // Never overwrite a tuned threshold on re-seed.
    if (existing) continue;

    await db.systemConfig.create({
      data: {
        orgId,
        key: config.key,
        value: config.value,
        description: config.description,
        category: config.category,
      },
    });
  }

  done(DEFAULT_SLA_SYSTEM_CONFIG.length);
}
