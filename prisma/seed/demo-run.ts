/**
 * Demo data loader.
 *
 *   npm run db:seed:demo
 *
 * Adds customers, portal logins, vehicles and drivers for testing. Kept
 * out of the main seed because invented trucks do not belong in
 * production. Safe to re-run.
 *
 * Loads into the default tenant unless another slug is named:
 *
 *   npm run db:seed:demo -- acme-freight
 */
import { db, disconnect } from "./client";
import { DEFAULT_ORG_SLUG } from "./organizations";
import { seedDemo } from "./demo";

async function main() {
  // By slug, not "the first row": once a second tenant exists, `findFirst`
  // loads Acme's demo trucks into whoever was inserted earliest.
  const slug = process.argv[2] ?? DEFAULT_ORG_SLUG;

  console.log(`\nLoading demo data into ${slug}\n`);

  const org = await db.organization.findUniqueOrThrow({
    where: { slug },
    select: { id: true },
  });
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
