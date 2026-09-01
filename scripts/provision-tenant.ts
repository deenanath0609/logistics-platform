/**
 * Provisions a new carrier on the platform, from a terminal.
 *
 *   npx tsx scripts/provision-tenant.ts --slug acme-freight --name "Acme Freight" \
 *     --subdomain acme --owner-mobile 9800000001 --owner-name "Priya Rao"
 *
 * A thin CLI over `provisionTenant()` in `src/lib/platform/provisioning.ts`,
 * which is the same code path the operator console's "New tenant" screen
 * uses. That matters more than it sounds: the previous version of this
 * script had its own implementation built on the seed, so a tenant created
 * here and a tenant created in the console would have differed in exactly
 * the ways nobody checks — which templates are active, where a counter
 * starts, whether a DLT sender id came along.
 *
 * What the service does, in one transaction: creates the organisation as
 * PROVISIONING, copies a template carrier's geography, masters, roles,
 * notification templates and SLA policies into it, creates one head-office
 * branch and one owner login, and writes the onboarding checklist. The
 * long pole on that checklist is DLT sender registration, which takes one
 * to three weeks of external approval per tenant and cannot be automated
 * away.
 *
 * Flags:
 *   --slug            required
 *   --name            required
 *   --subdomain       defaults to the slug
 *   --legal-name      defaults to the name
 *   --lr-prefix       defaults to LR
 *   --owner-name      defaults to "Owner"
 *   --owner-mobile    defaults to 9000000001
 *   --owner-email     optional
 *   --owner-password  set the owner's password instead of generating one.
 *                     For a carrier a script has to sign into afterwards —
 *                     CI, a fixture, a demonstration. A password given here
 *                     was not handed out by us, so first sign-in does not
 *                     force a change. Leave it off for a real carrier.
 *   --template        slug or id of the carrier to copy from; defaults to
 *                     the oldest, which is what the console defaults to
 *   --branch-code     defaults to HO
 *   --branch-name     defaults to "Head Office"
 *   --branch-city     defaults to the template's first city
 *   --branch-address  defaults to "Head Office"
 *   --branch-pincode  defaults to the first PIN of the chosen city
 *   --branch-phone    optional
 */
import "dotenv/config";
import { disconnectDb } from "../src/lib/prisma-base";
import { readingTenant } from "../src/lib/platform/db";
import {
  listTemplateTenants,
  provisionTenant,
} from "../src/lib/platform/provisioning";

type Args = Record<string, string>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    args[key] = next && !next.startsWith("--") ? next : "true";
  }
  return args;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Fills in the head office from the template's geography.
 *
 * The console asks an operator for these; a terminal should not demand six
 * more flags to create a test tenant. Picking the template's first city
 * and one of its PINs is a *default*, not a guess at the truth — the
 * branch is the carrier's own and the onboarding checklist has "confirm
 * branch network" as a blocking task for exactly this reason.
 */
async function defaultHeadOffice(templateOrgId: string, args: Args) {
  const city = args["branch-city"];
  const pincode = args["branch-pincode"];
  if (city && pincode) return { city, pincode };

  // A read inside one named tenant: under RLS the operator connection has
  // no tenant on its session and would otherwise see nothing.
  const geography = await readingTenant(templateOrgId, async (tx) => {
    const firstCity = await tx.city.findFirst({
      where: { orgId: templateOrgId },
      orderBy: { code: "asc" },
      select: { id: true, name: true },
    });
    if (!firstCity) return null;
    const firstPin = await tx.pincode.findFirst({
      where: { orgId: templateOrgId, cityId: firstCity.id },
      orderBy: { code: "asc" },
      select: { code: true },
    });
    return { city: firstCity.name, pincode: firstPin?.code ?? null };
  });

  if (!geography?.pincode) {
    die(
      "The template carrier has no geography to place a head office in. " +
        "Pass --branch-city and --branch-pincode, or pick another template.",
    );
  }

  return { city: city ?? geography.city, pincode: pincode ?? geography.pincode };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const slug = args.slug;
  const name = args.name;
  if (!slug || !name) {
    die(
      "Usage: npx tsx scripts/provision-tenant.ts --slug <slug> --name <name> " +
        "[--subdomain <subdomain>] [--template <slug>] [--owner-mobile <mobile>] " +
        "[--owner-name <name>]",
    );
  }

  const subdomain = args.subdomain ?? slug;

  // Resolve the template first: everything else defaults off it.
  const templates = await listTemplateTenants();
  if (templates.length === 0) {
    die(
      "There is no carrier to copy masters from. The first tenant on a platform " +
        "has to be seeded — run `npm run db:seed` — after which this script can " +
        "provision every further carrier.",
    );
  }

  const wanted = args.template;
  const template = wanted
    ? templates.find((row) => row.slug === wanted || row.id === wanted)
    : templates[0];
  if (!template) {
    die(
      `No carrier matches --template "${wanted}". Available: ` +
        templates.map((row) => row.slug).join(", "),
    );
  }

  const headOffice = await defaultHeadOffice(template.id, args);

  console.log(`\nProvisioning "${name}" at ${subdomain}.<platform>`);
  console.log(`  copying masters from ${template.name} (${template.slug})\n`);

  const result = await provisionTenant(
    {
      name,
      legalName: args["legal-name"] ?? null,
      slug,
      subdomain,
      lrPrefix: args["lr-prefix"] ?? "LR",
      planId: null,
      templateOrgId: template.id,
      branch: {
        code: args["branch-code"] ?? "HO",
        name: args["branch-name"] ?? "Head Office",
        city: headOffice.city,
        address: args["branch-address"] ?? "Head Office",
        pincode: headOffice.pincode,
        phone: args["branch-phone"] ?? null,
      },
      owner: {
        name: args["owner-name"] ?? "Owner",
        mobile: args["owner-mobile"] ?? "9000000001",
        email: args["owner-email"] ?? null,
        password: args["owner-password"] ?? null,
      },
    },
    // No operator is signed in at a terminal, and the audit row says so
    // rather than borrowing somebody's identity. `recordPlatformAudit`
    // renders a null actor as "out of band" in the console.
    null,
  );

  if (!result.ok) die(`\nRefused: ${result.error}`);

  const { data } = result;
  const rows = Object.entries(data.copied)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${table} ${count}`)
    .join(", ");

  console.log(`  organisation   ${data.orgId}`);
  console.log(`  copied         ${rows}`);
  console.log(`\nNext:`);
  console.log(`  1. Point ${data.subdomain}.<platform> at this deployment.`);
  // Second, and before anyone is told the address. The session cookie is
  // issued `Secure` in production, and a browser will not send a Secure
  // cookie back over plain HTTP — so on a host with no certificate this
  // carrier can sign in and find themselves signed out on the very next
  // click. That reads as a broken login, and the cause is three layers away.
  console.log(`  2. Issue this host's certificate:  sudo carrier-cert ${data.subdomain}`);
  console.log(`     Until it exists, sign-in appears to work and no session survives.`);
  console.log(`  3. Sign in at https://${data.subdomain}.<platform>/login`);
  console.log(`     ${args["owner-mobile"] ?? "9000000001"} / ${data.ownerPassword}`);
  console.log(
    args["owner-password"]
      ? `     The password you supplied. No change is forced at first sign-in.`
      : `     Shown once. It is not stored anywhere but the hash on the user row.`,
  );
  console.log(`  4. Start DLT sender registration — it is the long pole.`);
  console.log(`  5. Load rate cards; nothing can be billed without them.`);
  console.log(`  6. Set status to ACTIVE once the blocking tasks are done.\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
