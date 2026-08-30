/**
 * Does the SLA engine actually measure anything?
 *
 *   npx tsx scripts/verify-sla.ts [tenant-subdomain]
 *
 * The engine, the scanner and the reports were all built and unit-tested,
 * but until a policy row exists every shipment resolves to NOT_APPLICABLE
 * and "no data" on the on-time report is indistinguishable from a broken
 * scanner. This checks the whole chain against the real database.
 */
import "dotenv/config";
import { basePrisma, prisma } from "../src/lib/prisma";
import {
  runWithTenant,
  tenantContextFor,
  type TenantContext,
} from "../src/lib/tenant";
import { runSlaScan } from "../src/lib/sla/scanner";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};

/**
 * The organisation this run acts as.
 *
 * There is no request here and so no `Host` header, which means every
 * tenant-scoped query would be refused until one is named. Naming it on the
 * command line rather than reading an environment variable keeps the choice
 * in the shell history of whoever ran the script, next to the results.
 *
 * `findFirstOrThrow` on `basePrisma`: `Organization` is the tenant list
 * itself, one of the two tables ADR 001 keeps global.
 */
async function actingTenant(): Promise<TenantContext> {
  const subdomain = process.argv[2] ?? "city-logistics";

  const org = await basePrisma.organization.findFirstOrThrow({
    where: { subdomain },
    select: {
      id: true,
      slug: true,
      subdomain: true,
      customDomain: true,
      status: true,
    },
  });

  const tenant = tenantContextFor(org, "job");
  if (!tenant) {
    throw new Error(`Organisation "${subdomain}" is closed; refusing to run against it.`);
  }
  return tenant;
}

async function run() {
  const policies = await prisma.slaPolicy.count({ where: { isActive: true } });
  const rungs = await prisma.escalationRule.count();
  check("policies are seeded", policies > 0, `${policies} active`);
  check("escalation ladder configured", rungs > 0, `${rungs} rungs`);

  const before = await prisma.shipmentSla.groupBy({
    by: ["state"],
    _count: true,
  });
  console.log(
    `\n  before: ${
      before.length === 0
        ? "no ShipmentSla rows"
        : before.map((b) => `${b.state} ${b._count}`).join(", ")
    }`,
  );

  console.log("  running a scan…");
  const result = await runSlaScan();
  console.log(`  scan result: ${JSON.stringify(result)}`);

  const after = await prisma.shipmentSla.groupBy({
    by: ["state"],
    _count: true,
  });
  console.log(
    `  after:  ${
      after.length === 0
        ? "no ShipmentSla rows"
        : after.map((b) => `${b.state} ${b._count}`).join(", ")
    }\n`,
  );

  const measured = after
    .filter((row) => row.state !== "NOT_APPLICABLE")
    .reduce((sum, row) => sum + row._count, 0);

  check("shipments are now measured", measured > 0, `${measured} with a due date`);

  const withDue = await prisma.shipmentSla.findFirst({
    where: { dueAt: { not: undefined }, state: { not: "NOT_APPLICABLE" } },
    include: {
      shipment: { select: { lrNumber: true, currentStatus: true } },
    },
  });

  if (withDue) {
    console.log(
      `    e.g. ${withDue.shipment.lrNumber} (${withDue.shipment.currentStatus}) ` +
        `due ${withDue.dueAt.toISOString()} — ${withDue.state}`,
    );
    check("a due date was computed", Boolean(withDue.dueAt));
    check("a policy was attached", Boolean(withDue.policyId));
  }

  // Running it again must not duplicate exceptions — the dedupe key names
  // the problem, not the moment.
  const exceptionsBefore = await prisma.exception.count();
  await runSlaScan();
  const exceptionsAfter = await prisma.exception.count();
  check(
    "a second scan raises no duplicate exceptions",
    exceptionsAfter === exceptionsBefore,
    `${exceptionsBefore} → ${exceptionsAfter}`,
  );

  const openExceptions = await prisma.exception.groupBy({
    by: ["kind"],
    _count: true,
    where: { status: { in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] } },
  });
  console.log(
    `\n  open exceptions: ${
      openExceptions.length === 0
        ? "none"
        : openExceptions.map((e) => `${e.kind} ${e._count}`).join(", ")
    }`,
  );

  console.log(
    failures === 0
      ? "\nThe engine measures. On-time reporting has data to work from.\n"
      : `\n${failures} check(s) failed.\n`,
  );

  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  const tenant = await actingTenant();
  console.log(`\nSLA engine · acting as ${tenant.slug} (${tenant.subdomain})\n`);
  // `runSlaScan()` is one pass over one tenant now — the sweep that covers
  // them all is `forEachTenant` in `startSlaScanner`. Calling it in here
  // therefore scans this organisation and no other, which is what makes the
  // before/after counts either side of it mean anything.
  await runWithTenant(tenant, run);
}

main().catch(async (error) => {
  console.error("\nCrashed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
