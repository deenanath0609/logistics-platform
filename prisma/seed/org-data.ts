/**
 * Everything one tenant owns, in the order the dependencies allow.
 *
 * Deliberately its own module rather than living in `index.ts`: importing
 * `index.ts` runs the whole Phase 1 seed as a side effect and closes the
 * connection pool on the way out, so a caller that only wanted this
 * function — `scripts/provision-tenant.ts` does — gets a seeded database
 * and a dead pool instead.
 */
import { seedRoles } from "./rbac";
import { seedNetwork } from "./network";
import { seedMasters } from "./masters";
import { seedNotificationTemplates } from "./notifications";
import { seedSla } from "./sla";
import { seedBillingSeries } from "./billing";
import { seedRateCards } from "./rate-cards";
import { seedUsers } from "./users";

/**
 * `Permission` is the exception and is seeded once for the whole platform —
 * the `resource.action` catalogue is code, not tenant data (ADR 001 §4).
 */
export async function seedOrganizationData(orgId: string) {
  await seedRoles(orgId);

  const { branchIds } = await seedNetwork(orgId);
  await seedMasters(orgId);
  await seedBillingSeries(orgId);
  // After masters — slabs resolve ServiceType.code, rules resolve ChargeType.code.
  await seedRateCards(orgId);
  await seedNotificationTemplates(orgId);
  const { devPassword } = await seedUsers(orgId, branchIds);
  // After roles exist — escalation ladders resolve Role.code.
  await seedSla(orgId);

  return { devPassword };
}
