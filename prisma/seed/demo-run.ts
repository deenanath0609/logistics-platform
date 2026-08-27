/**
 * Demo data loader.
 *
 *   npm run db:seed:demo
 *
 * Adds customers, portal logins, vehicles and drivers for testing. Kept
 * out of the main seed because invented trucks do not belong in
 * production. Safe to re-run.
 */
import { db, disconnect } from "./client";
import { seedDemo } from "./demo";

async function main() {
  console.log("\nLoading demo data\n");

  const org = await db.organization.findFirstOrThrow({ select: { id: true } });
  const { portalPassword } = await seedDemo(org.id);

  console.log("\nDone.\n");
  console.log("  Customer portal — sign in at /portal/login");
  console.log(`    priya@acme.test        / ${portalPassword}   (Acme, owner)`);
  console.log(`    vikram@acme.test       / ${portalPassword}   (Acme, member)`);
  console.log(`    anil@bharattex.test    / ${portalPassword}   (Bharat Textiles, owner)`);
  console.log("");
}

main()
  .catch((error) => {
    console.error("\nDemo seed failed:", error);
    process.exitCode = 1;
  })
  .finally(disconnect);
