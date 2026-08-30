/**
 * Phase 1 seed — identity, network, and operational masters.
 *
 *   npm run db:seed
 *
 * Idempotent: safe to run against a database that already has data.
 * Nothing here resets a counter or overwrites a changed password.
 *
 * Everything below the permission catalogue is seeded *per organisation*.
 * The org id is threaded down as a parameter rather than looked up inside
 * each module: a module that re-queries "the" organisation works right up
 * until there are two, and then quietly writes one tenant's masters into
 * the other.
 */
import { disconnect } from "./client";
import { ORGANIZATIONS, seedOrganization } from "./organizations";
import { seedPermissions } from "./rbac";
import { seedPlans } from "./plans";
import { seedOrganizationData } from "./org-data";

async function main() {
  const started = Date.now();
  console.log(
    `\nSeeding Phase 1 — ${ORGANIZATIONS.length} organisation(s)\n`,
  );

  await seedPermissions();
  // Platform-level, like the permission catalogue: a price list, not a
  // tenant's data. Without it a new carrier comes up with the product off.
  await seedPlans();

  let devPassword = "";

  for (const [i, def] of ORGANIZATIONS.entries()) {
    if (i > 0) console.log("");
    const org = await seedOrganization(def);
    ({ devPassword } = await seedOrganizationData(org.id));
  }

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
