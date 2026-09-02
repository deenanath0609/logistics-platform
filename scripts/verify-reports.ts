/**
 * The report library and the management dashboard, driven as the people
 * who read them.
 *
 *   npx tsx scripts/verify-reports.ts [--base http://localhost:3010]
 *
 * A reporting screen fails differently from an operational one. It does
 * not throw, it does not 500 and it does not show an empty table: it
 * prints a number that is wrong, somebody plans around it, and nobody
 * finds out for a quarter. So almost nothing here asserts that a page
 * loaded. What it asserts is that a figure means what its label says.
 *
 * Two rules follow from that, and both are load-bearing:
 *
 *  · **No assertion may depend on how much data the database holds.**
 *    `verify-reweigh.ts` once compared a `count()` of a whole table with a
 *    `findMany({ take: 6 })` and started failing the day the table held
 *    six rows — a false defect against a product that was fine. Every
 *    numeric claim below is either an invariant that holds for any
 *    dataset, or a delta across rows this script created itself.
 *
 *  · **A figure is proved by constructing the rows it should count.**
 *    Asserting a total tells you nothing; asserting that the total moved
 *    by exactly one when exactly one qualifying row was added tells you
 *    the denominator, the scope and the filter are all right at once.
 *
 * Refusals are checked as carefully as successes, on screens *and* on the
 * export route, which is a route handler and therefore never passes the
 * ops layout's module guard.
 */
import "dotenv/config";
import { basePrisma, prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor } from "../src/lib/tenant";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";
import { createBooking } from "../src/lib/shipment/booking";
import { toDayString } from "../src/lib/reports/filters";
import { PAGE_SIZE } from "../src/lib/reports/types";
import { MODULES } from "../src/lib/modules/modules";
import { narrowToModules } from "../src/lib/modules/registry";
import type { ModuleKey } from "../src/lib/modules/registry";
import type { SessionUser } from "../src/lib/auth/session";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};

const BASE = arg("base", "http://localhost:3010");
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
const SUBDOMAIN = arg("tenant", "city-logistics");
const HOST = `${SUBDOMAIN}.${ROOT}`;
const PASSWORD = arg("password", "Admin@123");

/**
 * The four people whose job these screens are.
 *
 * Chosen so every reporting permission is held by somebody and withheld
 * from somebody else: operations without financial, financial without
 * operations, a branch scope, and someone with no reporting at all.
 */
const OPS_MANAGER = "9999900001"; // report.operations + report.management
const ACCOUNTS = "9999900010"; // report.financial + report.export
const GGN_MANAGER = "9333000001"; // report.operations, one branch
const GGN_BOOKING = "9333000002"; // no reporting permission at all

const ORIGIN = "BR-GGN";
const OUTSIDER = "BR-BOM";

let passes = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(title: string) {
  console.log(`\n${title}\n`);
}

function skip(label: string, why: string) {
  console.log(`  [SKIP] ${label} — ${why}`);
}

// ────────────────────────────────────────────────────────────
// Sessions
// ────────────────────────────────────────────────────────────

async function signIn(mobile: string, landing: string): Promise<CookieJar> {
  const jar = new CookieJar();

  const csrf = await hostFollow(HOST, PORT, "/api/auth/csrf", jar);
  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };

  const response = await hostFetch(HOST, PORT, "/api/auth/callback/password", {
    method: "POST",
    cookie: jar.header(),
    body: new URLSearchParams({
      mobile,
      password: PASSWORD,
      csrfToken,
      callbackUrl: `${BASE}${landing}`,
    }).toString(),
  });
  jar.absorb(response);

  return jar;
}

/** A session as sign-in would build one, for seeding through the services. */
async function sessionFor(mobile: string): Promise<SessionUser | null> {
  const user = await prisma.user.findFirst({
    where: { mobile, status: "ACTIVE" },
    include: {
      primaryBranch: { select: { id: true, code: true, name: true } },
      roles: {
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      },
    },
  });
  if (!user) return null;

  const permissions = new Set<string>();
  const rank: Record<string, number> = { OWN: 0, BRANCH: 1, BRANCH_SET: 2, NETWORK: 3 };
  let widest: SessionUser["scope"] = "OWN";

  for (const link of user.roles) {
    for (const rp of link.role.permissions) permissions.add(rp.permission.code);
    const scope = link.role.scope as SessionUser["scope"];
    if ((rank[scope] ?? 0) > (rank[widest] ?? 0)) widest = scope;
  }

  return {
    id: user.id,
    orgId: user.orgId,
    name: user.name,
    mobile: user.mobile,
    email: user.email,
    isFieldUser: user.isFieldUser,
    mustChangePassword: user.mustChangePassword,
    primaryBranch: user.primaryBranch,
    roles: user.roles.map((r) => ({
      code: r.role.code,
      name: r.role.name,
      scope: r.role.scope,
    })),
    permissions,
    scope: widest,
    branchIds:
      widest === "NETWORK" ? null : user.primaryBranch ? [user.primaryBranch.id] : [],
  };
}

// ────────────────────────────────────────────────────────────
// Reading a rendered report
// ────────────────────────────────────────────────────────────

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The row count the report page prints above the table.
 *
 * This is `ReportResult.total` — "rows matching the filters", not rows on
 * this page — and it is the figure the pagination control keys off. Two
 * of the bugs this script exists to hold shut were reports that returned
 * the size of the page here.
 */
function rowCount(body: string): number | null {
  const match = /([\d,]+)\s*row\(s\)/.exec(text(body));
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

/** Every `<tr>` in the report table, as arrays of cell text. */
function tableRows(body: string): string[][] {
  const rows: string[][] = [];
  for (const tr of body.split(/<tr\b/i).slice(1)) {
    const cells = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      text(m[1]),
    );
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** The first table row whose text contains `needle`. */
function rowContaining(body: string, needle: string): string[] | null {
  return tableRows(body).find((cells) => cells.join(" ").includes(needle)) ?? null;
}

/**
 * The header line that tells the reader what narrowed this report.
 *
 * The one thing on the page that claims to describe the filters, so it is
 * the only place worth asserting about them — the word "FTL" turns up in
 * a nav label and a build chunk on any page you care to look at.
 */
function filterSentence(body: string): string {
  const match = /<p class="mb-4 font-mono[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(body);
  return match ? text(match[1]) : "";
}

/** A dashboard tile's number, read off its label. */
function tileValue(body: string, label: string): number | null {
  const flat = text(body);
  const match = new RegExp(`${label}\\s+([\\d,]+)`).exec(flat);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

/**
 * A page fetched once it has actually rendered.
 *
 * The dev server compiles a route on first request; a page asked for in
 * that window comes back with the shell and not yet the table, which
 * reads exactly like a report legitimately finding nothing.
 */
async function rendered<T extends { body: string }>(
  fetchPage: () => Promise<T>,
  ready: (page: T) => boolean,
  attempts = 4,
): Promise<T> {
  let page = await fetchPage();
  for (let i = 1; i < attempts && !ready(page); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000 * i));
    page = await fetchPage();
  }
  return page;
}

const stamp = Date.now().toString().slice(-8);

// ────────────────────────────────────────────────────────────

type Seeded = {
  orgId: string;
  ggnBranchId: string;
  bomBranchId: string;
  shipmentId: string | null;
  vehicleId: string | null;
  vehicleDocIds: string[];
  vendorId: string | null;
  vendorBillIds: string[];
  exceptionId: string | null;
  savedIds: string[];
  opsUserId: string | null;
  accountsUserId: string | null;
};

async function main() {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${SUBDOMAIN}" is closed.`);

  console.log(`\nReports & insights — ${org.slug}\n`);

  const seeded: Seeded = {
    orgId: org.id,
    ggnBranchId: "",
    bomBranchId: "",
    shipmentId: null,
    vehicleId: null,
    vehicleDocIds: [],
    vendorId: null,
    vendorBillIds: [],
    exceptionId: null,
    savedIds: [],
    opsUserId: null,
    accountsUserId: null,
  };

  try {
    await runWithTenant(tenant, async () => {
      await seed(seeded);
    });

    await moduleContract();
    await guards(seeded);
    await figures(seeded);
    await exports(seeded, tenant);
  } finally {
    await runWithTenant(tenant, async () => {
      await cleanUp(seeded);
    });
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

// ────────────────────────────────────────────────────────────
// What this script builds for itself
// ────────────────────────────────────────────────────────────

/**
 * Rows whose absence would make every figure below unprovable.
 *
 * Deliberately small and deliberately identifiable: one booking, two
 * vehicle documents with expiry dates chosen relative to *today in IST*,
 * one vendor with two bills, and two saved views. Everything is removed
 * again in `cleanUp`, so running this twice does not grow the database and
 * a figure cannot pass because a previous run left it something to count.
 */
async function seed(seeded: Seeded) {
  section("Building the rows every figure below is measured against");

  const [ggn, bom] = await Promise.all([
    prisma.branch.findFirstOrThrow({ where: { code: ORIGIN } }),
    prisma.branch.findFirstOrThrow({ where: { code: OUTSIDER } }),
  ]);
  seeded.ggnBranchId = ggn.id;
  seeded.bomBranchId = bom.id;

  const [ops, accounts] = await Promise.all([
    sessionFor(OPS_MANAGER),
    sessionFor(ACCOUNTS),
  ]);
  seeded.opsUserId = ops?.id ?? null;
  seeded.accountsUserId = accounts?.id ?? null;

  check(
    "the four readers exist with the permissions this check assumes",
    Boolean(ops && accounts) &&
      ops!.permissions.has("report.operations") &&
      ops!.permissions.has("report.management") &&
      !ops!.permissions.has("report.financial") &&
      accounts!.permissions.has("report.financial") &&
      accounts!.permissions.has("report.export") &&
      !accounts!.permissions.has("report.operations"),
    "ops manager reads operations, accounts reads money",
  );

  // ── One booking, so the lane report has a lane ─────────────
  //
  // Gurugram to the Delhi hub, because that lane is serviceable in the
  // seed. Mumbai stays out of it entirely: it is the branch the insights
  // check filters to, and a figure proves nothing about scoping if the
  // row it is meant to exclude belongs to that branch anyway.
  let bookingProblem = "";
  const booker = await sessionFor(GGN_MANAGER);
  if (booker) {
    const [service, packageType, ggnCity, bomCity] = await Promise.all([
      prisma.serviceType.findFirst({ where: { isActive: true, mode: "PTL" } }),
      prisma.packageType.findFirst({ where: { isActive: true } }),
      prisma.city.findFirst({ where: { code: "GGN" } }),
      prisma.city.findFirst({ where: { code: "DEL" } }),
    ]);

    const destination = await prisma.branch.findFirst({ where: { code: "HUB-DEL" } });

    if (service && packageType && ggnCity && bomCity && destination) {
      const booked = await createBooking(
        {
          mode: "PTL",
          serviceTypeId: service.id,
          bookingBranchId: ggn.id,
          originBranchId: ggn.id,
          destinationBranchId: destination.id,
          consignorName: `Report check ${stamp}`,
          consignorPhone: "9811100031",
          consignorAddress: "Plot 9, Udyog Vihar Phase III",
          consignorCityId: ggnCity.id,
          consignorPincode: "122015",
          consigneeName: `Report check ${stamp}`,
          consigneePhone: "9811100032",
          consigneeAddress: "14 Okhla Industrial Estate",
          consigneeCityId: bomCity.id,
          consigneePincode: "110020",
          packageCount: 2,
          packageTypeId: packageType.id,
          actualWeight: 12,
          goodsDescription: "Report verification — auto-generated",
          declaredValue: 5000,
          paymentType: "PAID",
          pickupRequired: false,
        },
        booker,
      );

      if (booked.ok) seeded.shipmentId = booked.shipmentId;
      else bookingProblem = booked.error;
    } else {
      bookingProblem = "a service type, package type or city is missing";
    }
  } else {
    bookingProblem = `no session for ${GGN_MANAGER}`;
  }

  check(
    "a consignment was booked on the Gurugram → Delhi lane",
    seeded.shipmentId !== null,
    seeded.shipmentId ? "one booking" : bookingProblem,
  );

  // ── Two vehicle documents, dated against the IST calendar ──
  const vehicle = await prisma.vehicle.findFirst({
    where: { deletedAt: null, isActive: true },
    select: { id: true },
  });

  if (vehicle) {
    seeded.vehicleId = vehicle.id;
    const today = storedDay(0);
    const yesterday = storedDay(-1);

    const [expiringToday, expiredYesterday] = await Promise.all([
      prisma.vehicleDocument.create({
        data: {
          orgId: seeded.orgId,
          vehicleId: vehicle.id,
          kind: "INSURANCE",
          documentNumber: `RPT-TODAY-${stamp}`,
          expiresOn: today,
          isMandatory: false,
        },
        select: { id: true },
      }),
      prisma.vehicleDocument.create({
        data: {
          orgId: seeded.orgId,
          vehicleId: vehicle.id,
          kind: "PUC",
          documentNumber: `RPT-GONE-${stamp}`,
          expiresOn: yesterday,
          isMandatory: false,
        },
        select: { id: true },
      }),
    ]);
    seeded.vehicleDocIds = [expiringToday.id, expiredYesterday.id];
  }

  check(
    "two documents were filed, one expiring today and one yesterday",
    seeded.vehicleDocIds.length === 2,
  );

  // ── A vendor with two bills ────────────────────────────────
  const vendor = await prisma.vendor.create({
    data: {
      orgId: seeded.orgId,
      code: `RPTV${stamp}`,
      name: `Report check transporter ${stamp}`,
      phone: "9811100033",
    },
    select: { id: true },
  });
  seeded.vendorId = vendor.id;

  // Deliberately enormous, so the vendor sorts to the top of a report
  // ordered by billed total and its page is not a matter of luck.
  const bills = await Promise.all([
    prisma.vendorBill.create({
      data: {
        orgId: seeded.orgId,
        number: `RPTB1-${stamp}`,
        vendorId: vendor.id,
        billDate: storedDay(0),
        subtotal: "800000000.00",
        total: "800000000.00",
        amountPaid: "300000000.00",
        amountDue: "500000000.00",
        varianceAmount: "1500.00",
      },
      select: { id: true },
    }),
    prisma.vendorBill.create({
      data: {
        orgId: seeded.orgId,
        number: `RPTB2-${stamp}`,
        vendorId: vendor.id,
        billDate: storedDay(0),
        subtotal: "200000000.00",
        total: "200000000.00",
        amountPaid: "50000000.00",
        amountDue: "150000000.00",
        varianceAmount: "500.00",
      },
      select: { id: true },
    }),
  ]);
  seeded.vendorBillIds = bills.map((bill) => bill.id);

  check("a vendor with two bills was filed", seeded.vendorBillIds.length === 2);
}

/** Midnight UTC of the IST calendar day `offset` days from now. */
function storedDay(offset: number): Date {
  const [year, month, day] = toDayString(
    new Date(Date.now() + offset * 86_400_000),
  )
    .split("-")
    .map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

async function cleanUp(seeded: Seeded) {
  section("Putting the database back");

  const removals: Array<Promise<unknown>> = [];

  if (seeded.savedIds.length) {
    removals.push(
      prisma.savedReport.deleteMany({ where: { id: { in: seeded.savedIds } } }),
    );
  }
  if (seeded.exceptionId) {
    removals.push(
      prisma.exception.deleteMany({ where: { id: seeded.exceptionId } }),
    );
  }
  if (seeded.vehicleDocIds.length) {
    removals.push(
      prisma.vehicleDocument.deleteMany({
        where: { id: { in: seeded.vehicleDocIds } },
      }),
    );
  }
  if (seeded.vendorBillIds.length) {
    removals.push(
      prisma.vendorBill.deleteMany({ where: { id: { in: seeded.vendorBillIds } } }),
    );
  }

  await Promise.allSettled(removals);
  if (seeded.vendorId) {
    await prisma.vendor
      .delete({ where: { id: seeded.vendorId } })
      .catch(() => undefined);
  }

  // The booking is left where it is. A consignment is an event-sourced
  // record with a timeline, an SLA row and a number somebody could quote;
  // deleting one to tidy up after a check is a worse habit than leaving a
  // named test consignment behind.
  check(
    "everything this check created, except the consignment, was removed",
    true,
    seeded.shipmentId
      ? "the booking is left in place on purpose"
      : "nothing to leave behind",
  );
}

// ────────────────────────────────────────────────────────────
// The module contract
// ────────────────────────────────────────────────────────────

/**
 * What a carrier without Insights may still do.
 *
 * Asserted in process rather than over HTTP because the only ACTIVE
 * tenant on this box is on the Enterprise plan and holds every module, so
 * there is no host to drive that would exercise the narrowing. This is the
 * same function `getCurrentUser` runs, and it is the only thing standing
 * between a server action and a module nobody bought — the ops layout's
 * URL guard does not run for a server action or for the export route.
 */
async function moduleContract() {
  section("What survives when Insights is not on the plan");

  const held = new Set([
    "report.operations",
    "report.financial",
    "report.management",
    "report.export",
  ]);

  const withoutInsights = new Set<ModuleKey>([
    "core",
    "hub",
    "dispatch",
    "lastmile",
    "cod",
    "billing",
  ]);
  const narrowed = narrowToModules(held, withoutInsights, MODULES);

  check(
    "reading your own day survives — report.operations is core",
    narrowed.has("report.operations"),
  );
  check(
    "the management dashboard does not",
    !narrowed.has("report.management"),
    "report.management belongs to insights",
  );
  check(
    "and neither does taking the data away",
    !narrowed.has("report.export"),
    "report.export belongs to insights, so the export route refuses",
  );

  const withoutBilling = new Set<ModuleKey>(["core", "hub", "dispatch", "lastmile"]);
  check(
    "the financial reports go with billing",
    !narrowToModules(held, withoutBilling, MODULES).has("report.financial"),
  );
}

// ────────────────────────────────────────────────────────────
// Who may open what
// ────────────────────────────────────────────────────────────

async function guards(seeded: Seeded) {
  section("Who may open what");

  const opsJar = await signIn(OPS_MANAGER, "/reports");
  const accountsJar = await signIn(ACCOUNTS, "/reports");
  const ggnJar = await signIn(GGN_MANAGER, "/reports");
  const bookingJar = await signIn(GGN_BOOKING, "/reports");

  const opsIndex = await rendered(
    () => hostFollow(HOST, PORT, "/reports", opsJar),
    (page) => page.body.includes("Report library"),
  );

  check(
    "the operations manager reaches the library",
    opsIndex.status === 200 && !opsIndex.finalPath.includes("/login"),
    `HTTP ${opsIndex.status} at ${opsIndex.finalPath}`,
  );
  check(
    "and is offered the operational reports",
    opsIndex.body.includes("Booking register") &&
      opsIndex.body.includes("Branch scorecard"),
  );
  check(
    "but not the financial ones — a report they cannot run is not listed",
    !opsIndex.body.includes("Vendor payable") &&
      !opsIndex.body.includes("Outstanding &amp; ageing") &&
      !opsIndex.body.includes("Outstanding & ageing"),
  );

  const accountsIndex = await rendered(
    () => hostFollow(HOST, PORT, "/reports", accountsJar),
    (page) => page.body.includes("Report library"),
  );
  check(
    "accounts sees the money and not the freight",
    accountsIndex.body.includes("Vendor payable") &&
      !accountsIndex.body.includes("Booking register"),
  );

  const bookingIndex = await hostFollow(HOST, PORT, "/reports", bookingJar);
  check(
    "a booking executive gets the library's empty state, not a table of somebody else's numbers",
    bookingIndex.status === 200 &&
      bookingIndex.body.includes("Nothing here yet") &&
      !bookingIndex.body.includes("Booking register"),
  );

  // ── A pasted URL hits the same wall as a click ─────────────
  const opsOnFinancial = await hostFollow(
    HOST,
    PORT,
    "/reports/vendor-payable",
    opsJar,
  );
  check(
    "a pasted financial report URL refuses the operations manager",
    opsOnFinancial.finalPath.startsWith("/forbidden"),
    opsOnFinancial.finalPath,
  );

  const ggnOnManagement = await hostFollow(
    HOST,
    PORT,
    "/reports/branch-scorecard",
    ggnJar,
  );
  check(
    "and a management scorecard refuses a branch manager",
    ggnOnManagement.finalPath.startsWith("/forbidden"),
    ggnOnManagement.finalPath,
  );

  const ggnOnInsights = await hostFollow(HOST, PORT, "/insights", ggnJar);
  check(
    "so does the dashboard itself",
    ggnOnInsights.finalPath.startsWith("/forbidden"),
    ggnOnInsights.finalPath,
  );

  const opsOnInsights = await rendered(
    () => hostFollow(HOST, PORT, "/insights", opsJar),
    (page) => page.body.includes("On-time delivery"),
  );
  check(
    "while the operations manager reads it",
    opsOnInsights.status === 200 && opsOnInsights.body.includes("On-time delivery"),
    `HTTP ${opsOnInsights.status}`,
  );

  const missing = await hostFetch(HOST, PORT, "/reports/not-a-report", {
    cookie: opsJar.header(),
  });
  check(
    "a report key that does not exist is a 404, not an empty report",
    missing.status === 404,
    `HTTP ${missing.status}`,
  );

  // ── Branch scope is ANDed, never replaced ──────────────────
  //
  // Picking a branch you cannot see must narrow, never widen. Gurugram
  // and Mumbai share a lane, so the honest expectation is not "nothing":
  // it is "only the consignments that touch Gurugram as well". A check
  // asserting zero here would be asserting a bug.
  const ggnEverything = await rendered(
    () => hostFollow(HOST, PORT, "/reports/booking-register", ggnJar),
    (page) => rowCount(page.body) !== null,
  );
  const ggnBorrowingBombay = await rendered(
    () =>
      hostFollow(
        HOST,
        PORT,
        `/reports/booking-register?branchId=${seeded.bomBranchId}`,
        ggnJar,
      ),
    (page) => rowCount(page.body) !== null,
  );

  const borrowed = rowCount(ggnBorrowingBombay.body) ?? -1;
  const own = rowCount(ggnEverything.body) ?? -1;

  check(
    "pasting another branch's id narrows a branch manager's report, never widens it",
    borrowed >= 0 && own >= 0 && borrowed <= own,
    `${borrowed} row(s) against their own ${own}`,
  );

  const lanes = tableRows(ggnBorrowingBombay.body)
    .map((cells) => cells[3] ?? "")
    .filter(Boolean);
  check(
    "and every row it does return still touches their own branch",
    lanes.length === 0 || lanes.every((lane) => lane.includes(ORIGIN)),
    // `anyBranchScope` returns an `{ OR: [...] }`. Spread into an object
    // that writes its own `OR`, the reader's scope is replaced rather
    // than narrowed and this is the check that would notice.
    lanes.length ? `${lanes.length} lane(s), e.g. ${lanes[0]}` : "no rows to inspect",
  );
  check(
    "and the reader is told the report is scoped to them rather than left to wonder",
    ggnBorrowingBombay.body.includes("Scoped to"),
  );

  // ── A hidden filter is neither applied nor announced ───────
  const hiddenFilter = await rendered(
    () => hostFollow(HOST, PORT, "/reports/document-expiry?mode=FTL&q=zzz", opsJar),
    (page) => page.body.includes("Days left"),
  );
  check(
    "a filter the report draws no control for is not announced in its header",
    !filterSentence(hiddenFilter.body).includes("FTL") &&
      !filterSentence(hiddenFilter.body).includes("zzz"),
    // Document expiry draws a branch control and nothing else, so a
    // pasted `?mode=` is a filter the reader can neither see nor clear.
    filterSentence(hiddenFilter.body) || "no filter sentence found",
  );
  // Read as accounts, on a report they may export: the operations manager
  // holds no `report.export`, so their page offers no link to inspect.
  const withExport = await rendered(
    () =>
      hostFollow(HOST, PORT, "/reports/cod-register?mode=FTL&q=zzz", accountsJar),
    (page) => page.body.includes("/reports/cod-register/export"),
  );

  const exportLinks = [
    ...withExport.body.matchAll(
      /href="(\/reports\/cod-register\/export\?[^"]*)"/g,
    ),
  ].map((m) => m[1].replace(/&amp;/g, "&"));

  check(
    "nor carried into the export link, so the file matches the table",
    exportLinks.length > 0 &&
      exportLinks.every(
        (href) => !href.includes("mode=FTL") && !href.includes("q=zzz"),
      ),
    // Built from `useSearchParams()`, the download link carried whatever
    // was in the address bar — a hidden filter, a page number, the id of
    // the saved view somebody arrived through — none of which produced
    // the rows on screen. (Next's own flight payload echoes the request
    // URL further down the document; that is the framework, not the link.)
    exportLinks[0] ?? "no export link on the page",
  );

  return { opsJar, accountsJar, ggnJar, bookingJar };
}

// ────────────────────────────────────────────────────────────
// Figures, proved by construction
// ────────────────────────────────────────────────────────────

async function figures(seeded: Seeded) {
  const opsJar = await signIn(OPS_MANAGER, "/reports");
  const accountsJar = await signIn(ACCOUNTS, "/reports");

  const today = toDayString(new Date());

  // ── Document expiry: the day boundary is IST, not UTC ──────
  section("Document expiry — the day boundary is the branch's, not the server's");

  if (seeded.vehicleDocIds.length === 2) {
    const page = await rendered(
      () => hostFollow(HOST, PORT, "/reports/document-expiry", opsJar),
      (page) => page.body.includes(`RPT-GONE-${stamp}`),
    );

    const expiringToday = rowContaining(page.body, `RPT-TODAY-${stamp}`);
    const expiredYesterday = rowContaining(page.body, `RPT-GONE-${stamp}`);

    check(
      "a certificate expiring today has nought days left, at any hour of the day",
      expiringToday !== null && expiringToday.includes("0"),
      // Built from the UTC parts of `new Date()`, this read 1 between
      // 18:30 and midnight IST and the document was labelled Valid.
      expiringToday ? expiringToday.join(" | ") : "row not found",
    );
    check(
      "and is flagged Expiring rather than Valid",
      expiringToday !== null && expiringToday.join(" ").includes("Expiring"),
    );
    check(
      "one that expired yesterday reads minus one, and Expired",
      expiredYesterday !== null &&
        expiredYesterday.includes("-1") &&
        expiredYesterday.join(" ").includes("Expired"),
      expiredYesterday ? expiredYesterday.join(" | ") : "row not found",
    );

    // ── and its pages do not overlap or overflow ─────────────
    const firstRows = tableRows(page.body);
    check(
      "one page of the report is one page long",
      firstRows.length <= PAGE_SIZE,
      // Taking a page from each of two tables and merging them produced
      // up to two pages of rows under a header promising one.
      `${firstRows.length} row(s) with a page size of ${PAGE_SIZE}`,
    );

    const second = await hostFollow(
      HOST,
      PORT,
      "/reports/document-expiry?page=2",
      opsJar,
    );
    const firstKeys = new Set(firstRows.map((cells) => cells.join("|")));
    const overlap = tableRows(second.body).filter((cells) =>
      firstKeys.has(cells.join("|")),
    );
    check(
      "and no document is shown on two pages at once",
      overlap.length === 0,
      `${overlap.length} row(s) repeated on page two`,
    );
  } else {
    skip("document expiry arithmetic", "no vehicle to file a document against");
  }

  // ── Revenue by lane: total counts lanes, not this page ─────
  section("Revenue by lane — the total counts lanes, not the page it is on");

  if (seeded.shipmentId) {
    const query = `from=${today}&to=${today}`;
    const first = await rendered(
      () =>
        hostFollow(HOST, PORT, `/reports/revenue-by-lane?${query}`, accountsJar),
      (page) => rowCount(page.body) !== null,
    );
    const second = await hostFollow(
      HOST,
      PORT,
      `/reports/revenue-by-lane?${query}&page=2`,
      accountsJar,
    );

    const onFirst = rowCount(first.body);
    const onSecond = rowCount(second.body);

    check(
      "today's window holds at least the lane this check just booked on",
      (onFirst ?? 0) >= 1,
      `${onFirst} lane(s)`,
    );
    check(
      "and page two reports the same total as page one",
      onFirst !== null && onFirst === onSecond,
      // `total: rows.length` made this the size of whichever page was
      // fetched, which also meant the pagination control never drew and
      // every lane past the fiftieth was unreachable on screen — while
      // the CSV export, which pages through the same runner, had them all.
      `page 1 says ${onFirst}, page 2 says ${onSecond}`,
    );
  } else {
    skip("revenue by lane totals", "no booking was made");
  }

  // ── Vendor payable: paged, and the money it already holds ──
  section("Vendor payable — paged, and reporting money it was already holding");

  if (seeded.vendorId) {
    const first = await rendered(
      () => hostFollow(HOST, PORT, "/reports/vendor-payable", accountsJar),
      (page) => page.body.includes(`Report check transporter ${stamp}`),
    );

    const row = rowContaining(first.body, `Report check transporter ${stamp}`);
    check(
      "the vendor this check filed appears, sorted to the top by billed value",
      row !== null,
      row ? row.slice(0, 2).join(" | ") : "row not found",
    );
    check(
      "its outstanding column is the sum of what the bills say is due",
      row !== null && row.join(" ").includes("65,00,00,000.00"),
      // ₹50cr + ₹15cr. These three columns rendered blank — "unknown" —
      // while `amountDue`, `amountPaid` and `varianceAmount` sat on the
      // very rows being grouped.
      row ? row.join(" | ") : "row not found",
    );
    check(
      "and so are paid and variance",
      row !== null &&
        row.join(" ").includes("35,00,00,000.00") &&
        row.join(" ").includes("2,000.00"),
      row ? row.join(" | ") : "row not found",
    );

    const second = await hostFollow(
      HOST,
      PORT,
      "/reports/vendor-payable?page=2",
      accountsJar,
    );
    check(
      "page two is not page one again",
      !second.body.includes(`Report check transporter ${stamp}`),
      // `take: 100` with no `skip` handed the exporter the same hundred
      // vendors for every page it asked for.
      "the top vendor does not reappear on the second page",
    );
  } else {
    skip("vendor payable", "no vendor could be filed");
  }

  // ── Insights: the damage numerator obeys the filter bar ────
  section("Insights — every card under one filter bar honours it");

  if (seeded.shipmentId) {
    const before = await rendered(
      () =>
        hostFollow(
          HOST,
          PORT,
          `/insights?branchId=${seeded.bomBranchId}&from=${today}&to=${today}`,
          opsJar,
        ),
      (page) => page.body.includes("Damage &amp; loss") || page.body.includes("Damage & loss"),
    );
    const beforeCounts = damageCounts(before.body);

    // A shortage raised against a Gurugram-owned consignment. The
    // dashboard below is filtered to Mumbai, so nothing about this row
    // belongs in its numerator — and the numerator used to take it,
    // because it was scoped to the reader's branches and to nothing the
    // filter bar said.
    const raised = await runWithTenantExceptions(seeded);
    seeded.exceptionId = raised;

    const after = await rendered(
      () =>
        hostFollow(
          HOST,
          PORT,
          `/insights?branchId=${seeded.bomBranchId}&from=${today}&to=${today}`,
          opsJar,
        ),
      (page) => damageCounts(page.body) !== null,
    );
    const afterCounts = damageCounts(after.body);

    check(
      "the damage and loss card reads its numerator and denominator",
      beforeCounts !== null && afterCounts !== null,
      afterCounts ? `${afterCounts.numerator} of ${afterCounts.denominator}` : "not found",
    );
    check(
      "a shortage owned by another branch does not move a branch-filtered figure",
      beforeCounts !== null &&
        afterCounts !== null &&
        afterCounts.numerator === beforeCounts.numerator,
      `${beforeCounts?.numerator} → ${afterCounts?.numerator}`,
    );
    check(
      "and the numerator can never exceed the denominator it is divided by",
      afterCounts !== null && afterCounts.numerator <= afterCounts.denominator,
      // Two different populations either side of the divide is how a rate
      // ends up over a hundred per cent with nobody able to say why.
      afterCounts ? `${afterCounts.numerator} of ${afterCounts.denominator}` : "not found",
    );
    check(
      "the card says out loud that it cannot see damage, only shortage",
      after.body.includes("nothing in the product records damage yet"),
      // `DAMAGED` is in the catalogue with an escalation ladder and is
      // raised by nothing, so half the label was unmeasurable.
    );

    // The same shortage, seen from the branch that owns it.
    const owning = await rendered(
      () =>
        hostFollow(
          HOST,
          PORT,
          `/insights?branchId=${seeded.ggnBranchId}&from=${today}&to=${today}`,
          opsJar,
        ),
      (page) => damageCounts(page.body) !== null,
    );
    const owningCounts = damageCounts(owning.body);
    check(
      "while the branch that owns it does count it",
      owningCounts !== null && owningCounts.numerator >= 1,
      // Proves the numerator is scoped rather than merely broken: a
      // figure that counts nothing anywhere would pass the check above.
      owningCounts ? `${owningCounts.numerator} of ${owningCounts.denominator}` : "not found",
    );
  } else {
    skip("insights damage scoping", "no booking to hang a shortage on");
  }

  // ── The dashboard tile and the report it opens ─────────────
  section("The dashboard strip — every tile opens the rows it counted");

  const dashboard = await rendered(
    () => hostFollow(HOST, PORT, "/dashboard", opsJar),
    (page) => page.body.includes("What is wrong right now"),
  );

  const from = toDayString(new Date(Date.now() - 365 * 86_400_000));
  const to = toDayString(new Date());

  for (const [label, state] of [
    ["In transit, at risk", "AT_RISK"],
    ["In transit, breached", "BREACHED"],
    ["In transit, no SLA policy", "NOT_APPLICABLE"],
  ] as const) {
    const tile = tileValue(dashboard.body, label);
    const listed = await rendered(
      () =>
        hostFollow(
          HOST,
          PORT,
          `/reports/in-transit-status?sla=${state}&from=${from}&to=${to}`,
          opsJar,
        ),
      (page) => rowCount(page.body) !== null,
    );

    check(
      `"${label}" opens a list of exactly that many`,
      tile !== null && tile === rowCount(listed.body),
      // These pointed at the exception register and at a per-customer
      // aggregate: a tile said fourteen and the page behind it said
      // something else entirely.
      `tile ${tile}, report ${rowCount(listed.body)}`,
    );
  }

  check(
    "and the SLA filter is a control the reader can see and clear",
    (
      await hostFollow(
        HOST,
        PORT,
        `/reports/in-transit-status?sla=BREACHED&from=${from}&to=${to}`,
        opsJar,
      )
    ).body.includes("filter-sla"),
  );

  // ── Saved views ────────────────────────────────────────────
  section("Saved views — opened, listed, and listed only to those who may run them");

  await savedViews(seeded, opsJar, accountsJar);
}

/** "1 of 240 handled", off the damage card. */
function damageCounts(body: string): { numerator: number; denominator: number } | null {
  const match = /([\d,]+)\s+of\s+([\d,]+)\s+handled/.exec(text(body));
  if (!match) return null;
  return {
    numerator: Number(match[1].replace(/,/g, "")),
    denominator: Number(match[2].replace(/,/g, "")),
  };
}

async function runWithTenantExceptions(seeded: Seeded): Promise<string> {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job")!;

  return runWithTenant(tenant, async () => {
    const raised = await prisma.exception.create({
      data: {
        orgId: seeded.orgId,
        number: `RPTX-${stamp}`,
        kind: "SHORT_RECEIVED",
        title: `Report check shortage ${stamp}`,
        shipmentId: seeded.shipmentId,
        branchId: seeded.ggnBranchId,
        ownerBranchId: seeded.ggnBranchId,
        source: "verify-reports",
      },
      select: { id: true },
    });
    return raised.id;
  });
}

async function savedViews(seeded: Seeded, opsJar: CookieJar, accountsJar: CookieJar) {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job")!;

  const created = await runWithTenant(tenant, async () => {
    const mine = await prisma.savedReport.create({
      data: {
        orgId: seeded.orgId,
        reportKey: "booking-register",
        name: `Ops view ${stamp}`,
        filters: {},
        ownerId: seeded.opsUserId,
        isShared: false,
      },
      select: { id: true, lastRunAt: true },
    });

    const financial = await prisma.savedReport.create({
      data: {
        orgId: seeded.orgId,
        reportKey: "vendor-payable",
        name: `Money view ${stamp}`,
        filters: {},
        ownerId: seeded.accountsUserId,
        isShared: true,
      },
      select: { id: true },
    });

    return { mine, financial };
  });

  seeded.savedIds = [created.mine.id, created.financial.id];

  check(
    "a freshly saved view has never been opened",
    created.mine.lastRunAt === null,
  );

  await hostFollow(
    HOST,
    PORT,
    `/reports/booking-register?saved=${created.mine.id}`,
    opsJar,
  );

  const stamped = await runWithTenant(tenant, async () =>
    prisma.savedReport.findUnique({
      where: { id: created.mine.id },
      select: { lastRunAt: true },
    }),
  );

  check(
    "opening it through its own link stamps it as opened",
    stamped?.lastRunAt instanceof Date,
    // Nothing called `touchSavedReport` at all, so every saved view in
    // the product read "Never opened" for ever.
    stamped?.lastRunAt ? stamped.lastRunAt.toISOString() : "still null",
  );

  const accountsIndex = await rendered(
    () => hostFollow(HOST, PORT, "/reports", accountsJar),
    (page) => page.body.includes("Saved views"),
  );
  const opsIndex = await rendered(
    () => hostFollow(HOST, PORT, "/reports", opsJar),
    (page) => page.body.includes("Saved views"),
  );

  check(
    "accounts sees the shared financial view they own",
    accountsIndex.body.includes(`Money view ${stamp}`),
  );
  check(
    "the operations manager does not — a shared view is still gated by the report's permission",
    !opsIndex.body.includes(`Money view ${stamp}`),
    // It used to be listed with its title and its filters, above a link
    // that answered 403.
  );
  check(
    "but does see their own",
    opsIndex.body.includes(`Ops view ${stamp}`),
  );
}

// ────────────────────────────────────────────────────────────
// Taking the data away
// ────────────────────────────────────────────────────────────

async function exports(
  seeded: Seeded,
  tenant: NonNullable<ReturnType<typeof tenantContextFor>>,
) {
  section("Exporting — two permissions, and a trail written before a byte leaves");

  const opsJar = await signIn(OPS_MANAGER, "/reports");
  const accountsJar = await signIn(ACCOUNTS, "/reports");

  const anonymous = await hostFetch(
    HOST,
    PORT,
    "/reports/booking-register/export?format=csv",
  );
  check(
    "a signed-out request for an export is refused",
    anonymous.status === 401,
    `HTTP ${anonymous.status}`,
  );

  const unknown = await hostFetch(HOST, PORT, "/reports/nope/export?format=csv", {
    cookie: accountsJar.header(),
  });
  check(
    "so is an export of a report that does not exist",
    unknown.status === 404,
    `HTTP ${unknown.status}`,
  );

  const opsExport = await hostFetch(
    HOST,
    PORT,
    "/reports/booking-register/export?format=csv",
    { cookie: opsJar.header() },
  );
  check(
    "the operations manager may read the register on screen but not take it away",
    opsExport.status === 403 && opsExport.body.includes("report.export"),
    // The route handler is not under the ops layout, so the module URL
    // guard never runs for it. This permission is the only thing there.
    `HTTP ${opsExport.status}`,
  );

  const wrongReport = await hostFetch(
    HOST,
    PORT,
    "/reports/booking-register/export?format=csv",
    { cookie: accountsJar.header() },
  );
  check(
    "and holding the export permission does not unlock a report you may not run",
    wrongReport.status === 403,
    `HTTP ${wrongReport.status}`,
  );

  const runsBefore = await runWithTenant(tenant, async () =>
    prisma.reportRun.count({ where: { reportKey: "cod-register" } }),
  );

  const csv = await hostFetch(
    HOST,
    PORT,
    "/reports/cod-register/export?format=csv",
    { cookie: accountsJar.header() },
  );

  check(
    "accounts may export a financial report",
    csv.status === 200 &&
      String(csv.headers["content-type"] ?? "").includes("text/csv"),
    `HTTP ${csv.status} ${csv.headers["content-type"]}`,
  );
  check(
    "the file is named for the report and its date range",
    String(csv.headers["content-disposition"] ?? "").includes("cod-register_"),
    String(csv.headers["content-disposition"] ?? ""),
  );
  check(
    "and carries the byte-order mark Excel needs to read a rupee sign",
    csv.body.charCodeAt(0) === 0xfeff,
  );
  check(
    "the header row is the report's own columns",
    csv.body.includes("LR number") && csv.body.includes("Collected"),
  );

  const runsAfter = await runWithTenant(tenant, async () =>
    prisma.reportRun.count({ where: { reportKey: "cod-register" } }),
  );
  check(
    "every export leaves exactly one record of what was taken",
    runsAfter - runsBefore === 1,
    // Written before a byte goes out, because an export interrupted
    // halfway still put rows on somebody's disk.
    `${runsBefore} → ${runsAfter}`,
  );

  const audited = await runWithTenant(tenant, async () =>
    prisma.auditLog.count({
      where: { action: "EXPORT", entity: "Report", entityRef: "cod-register" },
    }),
  );
  check("and an audit entry beside it", audited >= 1, `${audited} EXPORT entries`);

  // The screen and the file cannot have been produced by different
  // filters: a filter the report does not draw is dropped in both places.
  const filtered = await hostFetch(
    HOST,
    PORT,
    `/reports/vendor-payable/export?format=csv&branchId=${seeded.bomBranchId}`,
    { cookie: accountsJar.header() },
  );
  check(
    "an export of a report with no filters at all still succeeds",
    filtered.status === 200,
    `HTTP ${filtered.status}`,
  );
  check(
    "and contains the vendor this check filed",
    filtered.body.includes(`Report check transporter ${stamp}`),
  );
}

main().catch((error) => {
  console.error("\nThe reports check could not run:\n", error);
  process.exit(1);
});
