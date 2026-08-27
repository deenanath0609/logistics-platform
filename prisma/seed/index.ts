/**
 * Phase 1 seed — identity, network, and operational masters.
 *
 *   npm run db:seed
 *
 * Idempotent: safe to run against a database that already has data.
 * Nothing here resets a counter or overwrites a changed password.
 */
import { db, disconnect, step, done } from "./client";
import { seedPermissions, seedRoles } from "./rbac";
import { seedNetwork } from "./network";
import { seedMasters } from "./masters";
import { seedNotificationTemplates } from "./notifications";
import { seedSla } from "./sla";
import { seedBillingSeries } from "./billing";
import { seedRateCards } from "./rate-cards";
import { seedUsers } from "./users";

async function seedOrganization() {
  step("organization");

  const org = await db.organization.upsert({
    where: { slug: "city-logistics" },
    create: {
      name: process.env.APP_NAME ?? "City Logistics",
      legalName: "City Logistics Private Limited",
      slug: "city-logistics",
      lrPrefix: process.env.LR_PREFIX ?? "CL",
      city: "Delhi",
      state: "Delhi",
      currency: process.env.DEFAULT_CURRENCY ?? "INR",
      timezone: process.env.DEFAULT_TIMEZONE ?? "Asia/Kolkata",
    },
    update: {},
  });

  done(org.name);
  return org;
}

async function main() {
  const started = Date.now();
  console.log("\nSeeding City Logistics — Phase 1\n");

  const org = await seedOrganization();

  await seedPermissions();
  await seedRoles(org.id);

  const { branchIds } = await seedNetwork(org.id);
  await seedMasters(org.id);
  await seedBillingSeries(org.id);
  // After masters — slabs resolve ServiceType.code, rules resolve ChargeType.code.
  await seedRateCards(org.id);
  await seedNotificationTemplates();
  const { devPassword } = await seedUsers(org.id, branchIds);
  // After roles exist — escalation ladders resolve Role.code.
  await seedSla(org.id);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nDone in ${seconds}s`);
  console.log("\n  Sign in with mobile + password:");
  console.log(`    admin      9999999999 / ${devPassword}`);
  console.log(`    ops        9999900001 / ${devPassword}`);
  console.log(`    booking    9999900003 / ${devPassword}`);
  console.log("  Full list in prisma/seed/users.ts\n");
}

main()
  .catch((error) => {
    console.error("\nSeed failed:", error);
    process.exitCode = 1;
  })
  .finally(disconnect);
