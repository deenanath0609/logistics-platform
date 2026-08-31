/**
 * Proves a branch-scoped person cannot read another branch's consignment.
 *
 *   npx tsx scripts/verify-branch-scope.ts [--base http://localhost:3010]
 *
 * Tenant isolation stops one carrier reaching another's data, and
 * `verify-tenant-isolation.ts` covers it thoroughly. This is the boundary
 * *inside* a carrier: a booking clerk at one branch has no business reading
 * the consignor, the consignee, the freight or the COD amount on a
 * consignment belonging to a branch they do not cover — and less business
 * printing its consignment note on the carrier's letterhead.
 *
 * The list screen scoped correctly and the two `[id]` screens did not, which
 * is the shape this kind of hole usually takes: the index is written with
 * the filter in mind and the detail page is written as "load by id". Every
 * other `[id]` screen in the product checks `coversBranch`; shipments were
 * the outliers, and this is here so they cannot become outliers again.
 *
 * Driven over HTTP as the clerk, because the guard being tested lives in a
 * page and only a request can reach it.
 */
import "dotenv/config";
import { basePrisma, prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor } from "../src/lib/tenant";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "true");
}

const BASE = args.get("base") ?? "http://localhost:3010";
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
const SUBDOMAIN = args.get("tenant") ?? "city-logistics";
const HOST = `${SUBDOMAIN}.${ROOT}`;

/** The narrow role: a booking clerk, scoped to one branch. */
const CLERK_MOBILE = args.get("mobile") ?? "9999900003";
const PASSWORD = args.get("password") ?? "Admin@123";

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function signIn() {
  const jar = new CookieJar();

  const csrf = await hostFollow(HOST, PORT, "/api/auth/csrf", jar);
  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };

  const body = new URLSearchParams({
    mobile: CLERK_MOBILE,
    password: PASSWORD,
    csrfToken,
    callbackUrl: `${BASE}/dashboard`,
  });

  const response = await hostFetch(HOST, PORT, "/api/auth/callback/password", {
    method: "POST",
    cookie: jar.header(),
    body: body.toString(),
  });
  jar.absorb(response);

  return jar;
}

async function main() {
  // `organization` carries no row-level policy — it is how a tenant is
  // resolved in the first place — so it is readable here. Everything after
  // it is tenant-owned and has to be read inside the tenant, which is what
  // `runWithTenant` below is for.
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });

  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${SUBDOMAIN}" is closed.`);

  const clerk = await runWithTenant(tenant, async () =>
    await prisma.user.findFirstOrThrow({
      where: { mobile: CLERK_MOBILE },
      select: { name: true, primaryBranchId: true },
    }),
  );

  const homeBranchId = clerk.primaryBranchId;
  if (!homeBranchId) {
    console.error(`  ${CLERK_MOBILE} has no primary branch; nothing to scope to.`);
    process.exit(1);
  }

  console.log(`\nBranch scope — ${org.slug}, as ${clerk.name} (${CLERK_MOBILE})\n`);

  // Read as the tenant, not as the clerk: the point is to name a
  // consignment this person is not supposed to see, which their own session
  // could not find — that refusal is the behaviour under test, not a way to
  // set it up.
  const foreign = await runWithTenant(tenant, async () =>
    await prisma.shipment.findFirst({
    where: {
      deletedAt: null,
      bookingBranchId: { not: homeBranchId },
      originBranchId: { not: homeBranchId },
      destinationBranchId: { not: homeBranchId },
      OR: [
        { currentBranchId: null },
        { currentBranchId: { not: homeBranchId } },
      ],
    },
    select: {
      id: true,
      lrNumber: true,
      originBranch: { select: { code: true } },
    },
    }),
  );

  const own = await runWithTenant(tenant, async () =>
    await prisma.shipment.findFirst({
      where: { deletedAt: null, originBranchId: homeBranchId },
      select: { id: true, lrNumber: true },
    }),
  );

  const jar = await signIn();

  const dashboard = await hostFollow(HOST, PORT, "/dashboard", jar);
  check(
    "the clerk is signed in",
    !dashboard.finalPath.includes("/login"),
    dashboard.finalPath,
  );

  if (!own) {
    console.log("  [SKIP] this branch has booked nothing, so there is no control case");
  } else {
    const mine = await hostFollow(HOST, PORT, `/shipments/${own.id}`, jar);
    check(
      "their own branch's consignment opens",
      mine.status === 200 && mine.body.includes(own.lrNumber),
      `${own.lrNumber} — HTTP ${mine.status}`,
    );
  }

  if (!foreign) {
    console.log(
      "  [SKIP] every consignment touches this branch, so there is nothing to be refused",
    );
  } else {
    const detail = await hostFollow(HOST, PORT, `/shipments/${foreign.id}`, jar);
    check(
      "another branch's consignment is refused",
      detail.status === 404 || !detail.body.includes(foreign.lrNumber),
      detail.body.includes(foreign.lrNumber)
        ? `LEAK — ${foreign.lrNumber} (${foreign.originBranch.code}) rendered in full`
        : `HTTP ${detail.status}`,
    );

    const print = await hostFollow(HOST, PORT, `/shipments/${foreign.id}/print`, jar);
    check(
      "and its consignment note cannot be printed",
      print.status === 404 || !print.body.includes(foreign.lrNumber),
      print.body.includes(foreign.lrNumber)
        ? `LEAK — the consignment note for ${foreign.lrNumber} printed`
        : `HTTP ${print.status}`,
    );
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nThe branch-scope check could not run:\n", error);
  process.exit(1);
});
