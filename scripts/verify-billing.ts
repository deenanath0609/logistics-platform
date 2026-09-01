/**
 * Billing, end to end — the money a carrier will not forgive getting wrong.
 *
 *   npx tsx scripts/verify-billing.ts [--tenant city-logistics]
 *                                     [--limited acme]
 *                                     [--base http://localhost:3010]
 *
 * Two halves, deliberately, and for the reason `verify-pickup-screens.ts`
 * gives: the services can be right while no person can reach them, and the
 * screens can render while the service underneath gives money away. So the
 * finance screens are driven over HTTP as a signed-in person, and the
 * billing services are driven directly with a real `SessionUser` resolved
 * out of the database.
 *
 * Every refusal is asserted twice — that it was refused, and that nothing
 * was written on either side of it. A guard that returns an error message
 * after the row has landed is not a guard.
 *
 * ── Assertions are scoped to the record under test ───────────────────────
 *
 * Never to a count of a table. `verify-reweigh.ts` compared a `count()` of
 * the whole notification log against a `findMany({ take: 6 })` and started
 * failing the seventh time it was run — reporting a defect while the
 * product was fine, which teaches everybody to ignore a red line. Every
 * check below names the invoice, the consignment or the note it is about.
 * ────────────────────────────────────────────────────────────────────────
 */
import "dotenv/config";
import Decimal from "decimal.js";
import { basePrisma, prisma } from "../src/lib/prisma";
import {
  runWithTenant,
  tenantContextFor,
  type TenantContext,
} from "../src/lib/tenant";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";
import type { SessionUser } from "../src/lib/auth/session";
import type { DataScope } from "../src/generated/prisma/client";
import { MODULES } from "../src/lib/modules/modules";
import { modulesForPlan, narrowToModules } from "../src/lib/modules/registry";
import { createBooking } from "../src/lib/shipment/booking";
import {
  priceShipment,
  snapshotShipment,
  storeFreightCalculation,
} from "../src/lib/pricing/resolve";
import { calculateFreight } from "../src/lib/pricing/engine";
import { coverageGaps } from "../src/lib/pricing/rerate";
import {
  billableShipments,
  cancelInvoice,
  createCreditNote,
  generateInvoice,
  issueInvoice,
} from "../src/lib/billing/invoice";
import { createDebitNote, liveInvoiceForShipment } from "../src/lib/billing/debit-note";
import { recordPayment } from "../src/lib/billing/receivables";
import { totalInvoice } from "../src/lib/billing/totals";
import { businessDay } from "../src/lib/time/business-day";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "true");
}

const BASE = args.get("base") ?? "http://localhost:3010";
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
const SUBDOMAIN = args.get("tenant") ?? "city-logistics";
const LIMITED = args.get("limited") ?? "acme";
const HOST = `${SUBDOMAIN}.${ROOT}`;
const LIMITED_HOST = `${LIMITED}.${ROOT}`;
const PASSWORD = args.get("password") ?? "Admin@123";

/** Network admin. */
const ADMIN_MOBILE = args.get("admin") ?? "9999999999";
/** Accounts — network scope, holds the billing permissions. */
const ACCOUNTS_MOBILE = args.get("accounts") ?? "9999900010";
/** Branch Manager at BR-GGN: branch scope, and holds `allReads`. */
const GGN_MOBILE = args.get("ggn") ?? "9333000001";
/** Branch Manager at BR-BOM: covers neither end of the probe consignment. */
const BOM_MOBILE = args.get("bom") ?? "9555000001";

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ────────────────────────────────────────────────────────────
// HTTP
// ────────────────────────────────────────────────────────────

/**
 * Signs in, and retries.
 *
 * `next dev` compiles a route on first request, and a sign-in that lands
 * while `/dashboard` is still being built comes back looking like a refused
 * login. Retried rather than believed: a flaky red line here would read as
 * "the branch manager cannot sign in", which is a defect report about the
 * wrong thing entirely.
 */
async function signIn(host: string, mobile: string) {
  let jar = new CookieJar();
  let detail = "";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    jar = new CookieJar();

    const csrf = await hostFetch(host, PORT, "/api/auth/csrf", { cookie: jar.header() });
    jar.absorb(csrf);
    const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };

    const posted = await hostFetch(host, PORT, "/api/auth/callback/password", {
      method: "POST",
      cookie: jar.header(),
      body: new URLSearchParams({
        mobile,
        password: PASSWORD,
        csrfToken,
        callbackUrl: `http://${host}:${PORT}/dashboard`,
      }).toString(),
    });
    jar.absorb(posted);

    const landed = await hostFollow(host, PORT, "/dashboard", jar);
    detail = `HTTP ${landed.status} at ${landed.finalPath}`;

    if (landed.status === 200 && !landed.finalPath.startsWith("/login")) {
      return { jar, signedIn: true, detail };
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  return { jar, signedIn: false, detail };
}

/**
 * A page, retried briefly.
 *
 * `next dev` answers a request for a route it has not compiled yet with the
 * shell and no content, so a first assertion on rendered HTML can fail on a
 * page that is perfectly correct. Retried on the *content*, not on the
 * status, because a 200 is exactly what the shell comes back as.
 */
async function page(
  host: string,
  path: string,
  jar: CookieJar,
  marker?: string,
): Promise<{ status: number; body: string; finalPath: string }> {
  let last = await hostFollow(host, PORT, path, jar);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!marker || last.body.includes(marker)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    last = await hostFollow(host, PORT, path, jar);
  }

  return last;
}

// ────────────────────────────────────────────────────────────
// Actors
// ────────────────────────────────────────────────────────────

const SCOPE_RANK: Record<DataScope, number> = {
  OWN: 0,
  BRANCH: 1,
  BRANCH_SET: 2,
  NETWORK: 3,
};

/**
 * The same `SessionUser` the app assembles, built off the database.
 *
 * Assembled here rather than imported because `getCurrentUser` reads a
 * request's cookies and there is no request in a script. The scope and
 * `branchIds` rules are the ones in `lib/auth/session.ts` — if they drift,
 * the branch-scope checks below stop meaning anything, so they are short
 * enough to read side by side.
 */
async function actorFor(mobile: string): Promise<SessionUser> {
  const user = await prisma.user.findFirstOrThrow({
    where: { mobile },
    select: {
      id: true,
      orgId: true,
      name: true,
      mobile: true,
      email: true,
      isFieldUser: true,
      mustChangePassword: true,
      primaryBranch: { select: { id: true, code: true, name: true } },
      branchScopes: { select: { branchId: true } },
      roles: {
        select: {
          role: {
            select: {
              code: true,
              name: true,
              scope: true,
              isActive: true,
              permissions: { select: { permission: { select: { code: true } } } },
            },
          },
        },
      },
    },
  });

  const roles = user.roles.map((r) => r.role).filter((role) => role.isActive);

  const permissions = new Set<string>();
  for (const role of roles) {
    for (const rp of role.permissions) permissions.add(rp.permission.code);
  }

  const scope = roles.reduce<DataScope>(
    (widest, role) => (SCOPE_RANK[role.scope] > SCOPE_RANK[widest] ? role.scope : widest),
    "OWN",
  );

  const branchIds =
    scope === "NETWORK"
      ? null
      : scope === "BRANCH_SET"
        ? [
            ...new Set(
              [user.primaryBranch?.id, ...user.branchScopes.map((s) => s.branchId)].filter(
                (id): id is string => Boolean(id),
              ),
            ),
          ]
        : user.primaryBranch
          ? [user.primaryBranch.id]
          : [];

  return {
    id: user.id,
    orgId: user.orgId,
    name: user.name,
    mobile: user.mobile,
    email: user.email,
    isFieldUser: user.isFieldUser,
    mustChangePassword: user.mustChangePassword,
    primaryBranch: user.primaryBranch,
    roles: roles.map((r) => ({ code: r.code, name: r.name, scope: r.scope })),
    permissions,
    scope,
    branchIds,
  };
}

/** The same actor with one permission taken away, to prove a refusal. */
function without(actor: SessionUser, permission: string): SessionUser {
  const permissions = new Set(actor.permissions);
  permissions.delete(permission);
  return { ...actor, permissions };
}

/**
 * The same actor, narrowed to one branch.
 *
 * The point of this rather than reusing a branch manager: a branch manager
 * is refused by the *permission* long before the branch check is reached,
 * so a refusal proves nothing about branch scope. This actor holds every
 * billing permission and is simply somewhere else — which is the only way
 * to see the branch guard actually fire.
 */
function scopedTo(actor: SessionUser, branchIds: string[]): SessionUser {
  return { ...actor, scope: "BRANCH", branchIds };
}

// ────────────────────────────────────────────────────────────
// The run
// ────────────────────────────────────────────────────────────

const UNRATED_SERVICE_CODE = "PROBE-NORATE";

async function run() {
  const [admin, accounts, ggn, bom] = await Promise.all([
    actorFor(ADMIN_MOBILE),
    actorFor(ACCOUNTS_MOBILE),
    actorFor(GGN_MOBILE),
    actorFor(BOM_MOBILE),
  ]);

  console.log(
    `  ${admin.name} (${admin.scope}) · ${accounts.name} (${accounts.scope}) · ` +
      `${ggn.name} @ ${ggn.primaryBranch?.code} · ${bom.name} @ ${bom.primaryBranch?.code}`,
  );

  const [ggnBranch, jaipurHub, gurugram, jaipur, ptlExpress] = await Promise.all([
    prisma.branch.findFirstOrThrow({ where: { code: "BR-GGN" } }),
    prisma.branch.findFirstOrThrow({ where: { code: "HUB-JAI" } }),
    prisma.city.findFirstOrThrow({ where: { code: "GGN" } }),
    prisma.city.findFirstOrThrow({ where: { code: "JAI" } }),
    prisma.serviceType.findFirstOrThrow({ where: { code: "PTL-EXP" } }),
  ]);

  // ══════════════════════════════════════════════════════════
  section("A booking prices against the published tariff");
  // ══════════════════════════════════════════════════════════

  const customer = await prisma.customer.findFirstOrThrow({
    where: { code: "ACME01" },
    select: { id: true, code: true, name: true, creditDays: true, branchId: true },
  });

  const priced = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: ptlExpress.id,
      bookingBranchId: ggnBranch.id,
      originBranchId: ggnBranch.id,
      destinationBranchId: jaipurHub.id,
      consignorId: customer.id,
      consignorName: customer.name,
      consignorPhone: "9811100030",
      consignorAddress: "Plot 14, Udyog Vihar",
      consignorCityId: gurugram.id,
      consignorPincode: "122015",
      consigneeName: "Billing Probe Receiver",
      consigneePhone: "9811100031",
      consigneeAddress: "22 Vaishali Nagar",
      consigneeCityId: jaipur.id,
      consigneePincode: "302013",
      packageCount: 3,
      actualWeight: 60,
      goodsDescription: "Billing probe — auto-generated",
      paymentType: "PAID",
    },
    admin,
  );

  check("a PTL booking on a priced lane succeeds", priced.ok, priced.ok ? priced.lrNumber : priced.error);
  if (!priced.ok) {
    await prisma.$disconnect();
    process.exit(1);
  }

  const pricedShipment = await prisma.shipment.findUniqueOrThrow({
    where: { id: priced.shipmentId },
    select: {
      id: true,
      lrNumber: true,
      chargeableWeight: true,
      freightAmount: true,
      chargesTotal: true,
      taxAmount: true,
      grandTotal: true,
    },
  });

  check(
    "it priced above zero",
    new Decimal(pricedShipment.grandTotal.toString()).greaterThan(0),
    `₹${pricedShipment.grandTotal} on ${pricedShipment.chargeableWeight} kg`,
  );

  const bookingCalcs = await prisma.freightCalculation.findMany({
    where: { shipmentId: priced.shipmentId },
    select: { id: true, stage: true, grandTotal: true, trace: true },
  });

  check(
    "a BOOKING calculation was stored against this consignment",
    bookingCalcs.some((calc) => calc.stage === "BOOKING"),
    bookingCalcs.map((c) => c.stage).join(", ") || "none",
  );

  const bookingTrace = bookingCalcs.find((c) => c.stage === "BOOKING")?.trace as {
    unrated?: boolean;
    selectedSlabId?: string | null;
    narrative?: string[];
  } | null;

  check(
    "and the trace names the slab that decided the price",
    Boolean(bookingTrace?.selectedSlabId) && bookingTrace?.unrated === false,
    bookingTrace?.selectedSlabId ?? "no slab recorded",
  );

  // 60 kg falls in the 20–100 band at ₹13/kg on PTL-EXP. Recomputed here
  // rather than trusted, so a slab edited in the seed shows up as a
  // mismatch instead of quietly repricing the assertion with it.
  const freight = new Decimal(pricedShipment.freightAmount.toString());
  check(
    "the freight line is the chargeable weight times the slab rate",
    freight.greaterThan(0) &&
      freight
        .minus(new Decimal(pricedShipment.chargeableWeight.toString()).times(13))
        .abs()
        .lessThanOrEqualTo("0.01"),
    `₹${freight.toFixed(2)} for ${pricedShipment.chargeableWeight} kg`,
  );

  // ══════════════════════════════════════════════════════════
  section("A zero price means no rate card resolved, and says so");
  // ══════════════════════════════════════════════════════════

  /*
    Proved on the engine first, at a date before the published tariff took
    effect. `resolveRateCards` returns nothing for that date, so this is the
    exact shape a genuinely unpriced lane produces — without editing a
    master to manufacture it.
  */
  const beforeTheTariff = await priceShipment(
    await snapshotShipment(
      await prisma.shipment.findUniqueOrThrow({
        where: { id: priced.shipmentId },
        select: {
          id: true,
          lrNumber: true,
          mode: true,
          serviceTypeId: true,
          paymentType: true,
          consignorId: true,
          consignorCityId: true,
          consigneeCityId: true,
          consignorPincode: true,
          consigneePincode: true,
          packageCount: true,
          actualWeight: true,
          volumetricWeight: true,
          chargeableWeight: true,
          declaredValue: true,
          codAmount: true,
          isFragile: true,
          isReverseCharge: true,
          serviceType: { select: { volumetricDivisor: true } },
        },
      }),
    ),
    {
      orgId: admin.orgId,
      at: new Date("2020-01-01T00:00:00.000Z"),
      volumetricDivisor: ptlExpress.volumetricDivisor,
    },
  );

  check(
    "pricing before any card was in force comes back unrated, not zero-and-silent",
    beforeTheTariff.unrated && beforeTheTariff.total.isZero(),
    beforeTheTariff.unratedReason ?? "no reason given",
  );
  check(
    "the refusal carries a reason a billing clerk can act on",
    Boolean(beforeTheTariff.unratedReason) &&
      beforeTheTariff.unratedReason!.length > 20,
    beforeTheTariff.unratedReason ?? "",
  );
  check(
    "and the trace mirrors the flag, which is what the gap report queries",
    beforeTheTariff.trace.unrated === true &&
      beforeTheTariff.trace.unratedReason === beforeTheTariff.unratedReason,
  );

  // ══════════════════════════════════════════════════════════
  section("/finance/coverage-gaps surfaces a lane with no rate card");
  // ══════════════════════════════════════════════════════════

  /*
    A real unrated consignment, made the way one actually happens: somebody
    adds a service type and nobody prices it. The published tariff pins each
    slab to a service type, so a new one matches nothing — and the booking
    still goes through, flagged, rather than at zero.

    Created once and reused, so running this twice does not fill the masters
    with probe rows.
  */
  const unratedService =
    (await prisma.serviceType.findFirst({ where: { code: UNRATED_SERVICE_CODE } })) ??
    (await prisma.serviceType.create({
      data: {
        orgId: admin.orgId,
        code: UNRATED_SERVICE_CODE,
        name: "Probe — deliberately unpriced",
        mode: "PTL",
        volumetricDivisor: 5000,
        isActive: true,
      },
    }));

  const unrated = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: unratedService.id,
      bookingBranchId: ggnBranch.id,
      originBranchId: ggnBranch.id,
      destinationBranchId: jaipurHub.id,
      consignorName: "Coverage Gap Probe",
      consignorPhone: "9811100032",
      consignorAddress: "Plot 14, Udyog Vihar",
      consignorCityId: gurugram.id,
      consignorPincode: "122015",
      consigneeName: "Coverage Gap Receiver",
      consigneePhone: "9811100033",
      consigneeAddress: "22 Vaishali Nagar",
      consigneeCityId: jaipur.id,
      consigneePincode: "302013",
      packageCount: 1,
      actualWeight: 10,
      goodsDescription: "Coverage gap probe — auto-generated",
      paymentType: "PAID",
    },
    admin,
  );

  check(
    "a consignment on an unpriced service type still books",
    unrated.ok,
    unrated.ok ? unrated.lrNumber : unrated.error,
  );
  if (!unrated.ok) {
    await prisma.$disconnect();
    process.exit(1);
  }

  const unratedShipment = await prisma.shipment.findUniqueOrThrow({
    where: { id: unrated.shipmentId },
    select: { id: true, lrNumber: true, grandTotal: true },
  });

  check(
    "it priced at zero, because nothing covered it",
    new Decimal(unratedShipment.grandTotal.toString()).isZero(),
    `₹${unratedShipment.grandTotal}`,
  );

  const gapsForAdmin = await coverageGaps({ orgId: admin.orgId, take: 400 }, admin);
  const thisGap = gapsForAdmin.find((row) => row.shipmentId === unrated.shipmentId);

  check(
    "and it is on the coverage-gap report rather than invisible",
    Boolean(thisGap),
    thisGap ? thisGap.reason : "this consignment is not listed",
  );
  check(
    "the report names the lane it could not price",
    thisGap?.origin === "BR-GGN" && thisGap?.destination === "HUB-JAI",
    thisGap ? `${thisGap.origin} → ${thisGap.destination}` : "",
  );

  section("…and the gap report is scoped to the reader's branches");

  const gapsForGgn = await coverageGaps({ orgId: admin.orgId, take: 400 }, ggn);
  const gapsForBom = await coverageGaps({ orgId: admin.orgId, take: 400 }, bom);

  check(
    "the origin branch sees its own unpriced consignment",
    gapsForGgn.some((row) => row.shipmentId === unrated.shipmentId),
    `${gapsForGgn.length} row(s) for ${ggn.primaryBranch?.code}`,
  );
  check(
    "a branch that never touched it does not",
    !gapsForBom.some((row) => row.shipmentId === unrated.shipmentId),
    `${gapsForBom.length} row(s) for ${bom.primaryBranch?.code}`,
  );

  section("…and a lane leaves the report once it has been priced");

  /*
    The worklist rule. Every unrated calculation stays in the table forever
    — that is the point of an append-only record — so the report has to
    judge a consignment on its *latest* one, or a lane you priced and
    re-rated last month is still on the list this month. A worklist that
    never empties is a worklist nobody reads, which is the failure this
    screen exists to prevent.

    Proved by pricing this one consignment against a card built here in
    memory and storing the result the way a re-rate does. Nothing is written
    to the masters, and the assertion names the consignment rather than
    counting rows.
  */
  const gapShipment = await prisma.shipment.findUniqueOrThrow({
    where: { id: unrated.shipmentId },
    select: {
      id: true,
      lrNumber: true,
      mode: true,
      serviceTypeId: true,
      paymentType: true,
      consignorId: true,
      consignorCityId: true,
      consigneeCityId: true,
      consignorPincode: true,
      consigneePincode: true,
      packageCount: true,
      actualWeight: true,
      volumetricWeight: true,
      chargeableWeight: true,
      declaredValue: true,
      codAmount: true,
      isFragile: true,
      isReverseCharge: true,
      serviceType: { select: { volumetricDivisor: true } },
    },
  });

  const nowPriced = calculateFreight(
    await snapshotShipment(gapShipment),
    {
      versionId: "probe:priced-lane",
      rateCardId: "probe:priced-lane",
      rateCardCode: "PROBE-FIX",
      scope: "PUBLISHED",
      version: 1,
      isApproved: true,
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
      slabs: [
        {
          id: "probe:slab",
          serviceTypeId: unratedService.id,
          mode: "PTL",
          basis: "PER_KG",
          rate: "14",
        },
      ],
      rules: [],
    },
    {
      at: businessDay(),
      volumetricDivisor: unratedService.volumetricDivisor,
      chargeTypes: {},
    },
  );

  check(
    "the lane prices once a slab covers it",
    nowPriced.unrated === false && nowPriced.total.greaterThan(0),
    `₹${nowPriced.total.toFixed(2)}`,
  );

  await storeFreightCalculation({
    shipmentId: unrated.shipmentId,
    result: nowPriced,
    stage: "INVOICE",
    userId: admin.id,
  });

  const gapsAfterPricing = await coverageGaps({ orgId: admin.orgId, take: 400 }, admin);

  check(
    "and the consignment drops off the coverage-gap report",
    !gapsAfterPricing.some((row) => row.shipmentId === unrated.shipmentId),
    `${gapsAfterPricing.length} row(s) still listed`,
  );
  check(
    "while its unrated booking calculation is still on the record",
    (
      await prisma.freightCalculation.findMany({
        where: { shipmentId: unrated.shipmentId },
        select: { stage: true },
      })
    ).some((calc) => calc.stage === "BOOKING"),
  );

  // ══════════════════════════════════════════════════════════
  section("The screens answer a signed-in person");
  // ══════════════════════════════════════════════════════════

  const adminSession = await signIn(HOST, ADMIN_MOBILE);
  check(`signed in on ${HOST} as the network admin`, adminSession.signedIn, adminSession.detail);
  if (!adminSession.signedIn) {
    await prisma.$disconnect();
    process.exit(1);
  }

  const screens: Array<{ path: string; marker: string; label: string }> = [
    { path: "/finance/rate-cards", marker: "Rate cards", label: "rate cards" },
    { path: "/finance/coverage-gaps", marker: "coverage gaps", label: "coverage gaps" },
    { path: "/finance/invoices", marker: "Invoices", label: "invoices" },
    { path: "/finance/receivables", marker: "Receivables", label: "receivables" },
    { path: "/finance/settlements", marker: "settlement", label: "settlements" },
    { path: "/finance/profitability", marker: "Profitability", label: "profitability" },
  ];

  for (const screen of screens) {
    const response = await page(HOST, screen.path, adminSession.jar, screen.marker);
    check(
      `${screen.label} renders`,
      response.status === 200 && response.body.includes(screen.marker),
      `HTTP ${response.status} at ${response.finalPath}`,
    );
  }

  const gapScreen = await page(
    HOST,
    "/finance/coverage-gaps",
    adminSession.jar,
    unratedShipment.lrNumber,
  );
  check(
    "the unpriced consignment is on the screen, by LR number",
    gapScreen.body.includes(unratedShipment.lrNumber),
    unratedShipment.lrNumber,
  );

  const rateCard = await prisma.rateCard.findFirstOrThrow({ select: { id: true, code: true } });
  const cardScreen = await page(
    HOST,
    `/finance/rate-cards/${rateCard.id}`,
    adminSession.jar,
    rateCard.code,
  );
  check(
    "a rate card opens on its own screen",
    cardScreen.status === 200 && cardScreen.body.includes(rateCard.code),
    `HTTP ${cardScreen.status}`,
  );

  // ══════════════════════════════════════════════════════════
  section("Billing is a paid module, on screens and on server actions");
  // ══════════════════════════════════════════════════════════

  const limitedOrg = await basePrisma.organization.findFirst({
    where: { subdomain: LIMITED },
    select: { name: true, plan: { select: { name: true, features: true } } },
  });

  if (!limitedOrg) {
    check(`a carrier without billing exists at "${LIMITED}"`, false, "not found");
  } else {
    const granted = modulesForPlan(limitedOrg.plan?.features ?? [], MODULES);
    check(
      `${limitedOrg.name} is on a plan without billing`,
      !granted.has("billing"),
      `${limitedOrg.plan?.name ?? "no plan"} · ${[...granted].join(", ")}`,
    );

    const limitedSession = await signIn(LIMITED_HOST, ADMIN_MOBILE);
    check(`signed in on ${LIMITED_HOST}`, limitedSession.signedIn, limitedSession.detail);

    if (limitedSession.signedIn) {
      for (const path of [
        "/finance/invoices",
        "/finance/receivables",
        "/finance/settlements",
        "/finance/coverage-gaps",
      ]) {
        const response = await hostFollow(LIMITED_HOST, PORT, path, limitedSession.jar);
        const refused =
          response.finalPath.startsWith("/not-on-plan") ||
          response.finalPath.startsWith("/forbidden") ||
          response.status === 404;
        check(`${path} is refused by URL`, refused, `HTTP ${response.status} at ${response.finalPath}`);
      }
    }

    /*
      The other half, and the one a URL guard cannot cover.

      A server action does not pass the layout's `requireModuleForPath`, so
      gating rests entirely on the session's permission set being narrowed —
      which only happens for a permission some module *owns*. Every billing
      permission is checked here, not a representative one: `settlement.
      prepare` was the odd one out, held by nobody's module, so
      `prepareSettlementAction` answered a carrier who never bought billing.
    */
    const billingPermissions = MODULES.billing.permissions;
    const kept = narrowToModules(billingPermissions, granted, MODULES);

    check(
      "every billing permission is withheld from a session on a plan without it",
      kept.size === 0,
      kept.size === 0 ? `${billingPermissions.length} checked` : `still held: ${[...kept].join(", ")}`,
    );

    for (const permission of ["settlement.prepare", "invoice.create", "payment.record"]) {
      check(
        `  · ${permission} is owned by a module and therefore gated`,
        !kept.has(permission) && billingPermissions.includes(permission),
      );
    }
  }

  // ══════════════════════════════════════════════════════════
  section("An invoice is raised, and cannot be raised twice");
  // ══════════════════════════════════════════════════════════

  const period = {
    from: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    to: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };

  const billable = await billableShipments(
    { customerId: customer.id, from: period.from, to: period.to },
    accounts,
  );

  check(
    "the new consignment is billable to its account",
    billable.some((shipment) => shipment.id === priced.shipmentId),
    `${billable.length} billable consignment(s)`,
  );

  const drafted = await generateInvoice(
    {
      customerId: customer.id,
      branchId: ggnBranch.id,
      periodFrom: period.from,
      periodTo: period.to,
      shipmentIds: [priced.shipmentId],
    },
    accounts,
  );

  check("an invoice drafts", drafted.ok, drafted.ok ? drafted.number : drafted.error);
  if (!drafted.ok) {
    await prisma.$disconnect();
    process.exit(1);
  }

  const invoiceId = drafted.invoiceId;

  const draft = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: {
      id: true,
      number: true,
      status: true,
      invoiceDate: true,
      dueDate: true,
      subtotal: true,
      taxAmount: true,
      roundOff: true,
      total: true,
      amountDue: true,
      branchId: true,
      lines: { select: { amount: true, taxAmount: true, shipmentId: true, hsnSac: true } },
    },
  });

  check("it starts as a draft", draft.status === "DRAFT", draft.status);
  check(
    "every line traces to the consignment it came from",
    draft.lines.length > 0 && draft.lines.every((line) => line.shipmentId === priced.shipmentId),
    `${draft.lines.length} line(s)`,
  );
  check(
    "and every line carries an HSN/SAC, without which it is not a tax invoice",
    draft.lines.every((line) => Boolean(line.hsnSac)),
    [...new Set(draft.lines.map((line) => line.hsnSac))].join(", "),
  );

  section("…the second attempt at the same consignments is refused");

  const doubleBilled = await generateInvoice(
    {
      customerId: customer.id,
      branchId: ggnBranch.id,
      shipmentIds: [priced.shipmentId],
    },
    accounts,
  );

  check(
    "billing the same consignment again is refused",
    doubleBilled.ok === false,
    doubleBilled.ok ? `it raised ${doubleBilled.number}` : doubleBilled.error,
  );

  const invoicesOnThisShipment = await prisma.invoiceLine.findMany({
    where: {
      shipmentId: priced.shipmentId,
      invoice: { status: { notIn: ["CANCELLED"] } },
    },
    select: { invoiceId: true },
  });

  check(
    "and the consignment is still on exactly one live invoice",
    new Set(invoicesOnThisShipment.map((line) => line.invoiceId)).size === 1,
    `${new Set(invoicesOnThisShipment.map((l) => l.invoiceId)).size} invoice(s)`,
  );

  check(
    "it also drops off the billable list once billed",
    !(
      await billableShipments(
        { customerId: customer.id, from: period.from, to: period.to },
        accounts,
      )
    ).some((shipment) => shipment.id === priced.shipmentId),
  );

  // ══════════════════════════════════════════════════════════
  section("Rounding and tax reconcile, with no float anywhere");
  // ══════════════════════════════════════════════════════════

  const recomputed = totalInvoice(
    draft.lines.map((line) => ({
      amount: line.amount.toString(),
      taxAmount: line.taxAmount.toString(),
    })),
    false,
  );

  check(
    "the stored subtotal is the sum of the lines, to the paisa",
    recomputed.subtotal.equals(new Decimal(draft.subtotal.toString())),
    `${recomputed.subtotal.toFixed(2)} vs ${draft.subtotal}`,
  );
  check(
    "the stored tax is the sum of the line taxes",
    recomputed.taxAmount.equals(new Decimal(draft.taxAmount.toString())),
    `${recomputed.taxAmount.toFixed(2)} vs ${draft.taxAmount}`,
  );
  check(
    "the total is a whole rupee",
    new Decimal(draft.total.toString()).decimalPlaces() === 0 ||
      new Decimal(draft.total.toString()).modulo(1).isZero(),
    `₹${draft.total}`,
  );
  check(
    "and the rounding difference is kept rather than absorbed",
    new Decimal(draft.subtotal.toString())
      .plus(new Decimal(draft.taxAmount.toString()))
      .plus(new Decimal(draft.roundOff.toString()))
      .equals(new Decimal(draft.total.toString())),
    `${draft.subtotal} + ${draft.taxAmount} + ${draft.roundOff} = ${draft.total}`,
  );

  section("…and the document is dated on the carrier's calendar");

  check(
    "the invoice date is the Indian business day, not the UTC one",
    draft.invoiceDate.toISOString().slice(0, 10) ===
      businessDay().toISOString().slice(0, 10),
    `${draft.invoiceDate.toISOString().slice(0, 10)} vs ${businessDay()
      .toISOString()
      .slice(0, 10)}`,
  );
  check(
    "the due date is the invoice date plus the account's credit days",
    draft.dueDate.getTime() - draft.invoiceDate.getTime() ===
      (customer.creditDays ?? 0) * 24 * 60 * 60 * 1000,
    `${draft.invoiceDate.toISOString().slice(0, 10)} + ${customer.creditDays} = ${draft.dueDate
      .toISOString()
      .slice(0, 10)}`,
  );
  check(
    "and the number carries the financial year of that day",
    draft.number.includes(
      `${String(
        draft.invoiceDate.getUTCMonth() >= 3
          ? draft.invoiceDate.getUTCFullYear()
          : draft.invoiceDate.getUTCFullYear() - 1,
      ).slice(-2)}${String(
        (draft.invoiceDate.getUTCMonth() >= 3
          ? draft.invoiceDate.getUTCFullYear()
          : draft.invoiceDate.getUTCFullYear() - 1) + 1,
      ).slice(-2)}`,
    ),
    draft.number,
  );

  // ══════════════════════════════════════════════════════════
  section("Refusals, and what they leave behind");
  // ══════════════════════════════════════════════════════════

  const billedFromElsewhere = await generateInvoice(
    {
      customerId: customer.id,
      branchId: ggnBranch.id,
      shipmentIds: [priced.shipmentId],
    },
    scopedTo(accounts, [bom.primaryBranch!.id]),
  );
  check(
    "raising an invoice from a branch the actor does not cover is refused",
    billedFromElsewhere.ok === false,
    billedFromElsewhere.ok ? `it raised ${billedFromElsewhere.number}` : billedFromElsewhere.error,
  );

  const before = await snapshotInvoice(invoiceId);

  const noPermission = await issueInvoice(
    { invoiceId, reason: "Probe — should be refused." },
    without(accounts, "invoice.approve"),
  );
  check(
    "issuing without invoice.approve is refused",
    noPermission.ok === false,
    noPermission.ok ? "it was issued" : noPermission.error,
  );

  const noReason = await issueInvoice({ invoiceId, reason: "   " }, accounts);
  check(
    "issuing without a reason is refused — approval is audited",
    noReason.ok === false,
    noReason.ok ? "it was issued" : noReason.error,
  );

  const wrongBranch = await issueInvoice(
    { invoiceId, reason: "Probe — wrong branch." },
    scopedTo(accounts, [bom.primaryBranch!.id]),
  );
  check(
    "issuing another branch's invoice is refused even holding invoice.approve",
    wrongBranch.ok === false &&
      !wrongBranch.ok &&
      wrongBranch.error.includes("another branch"),
    wrongBranch.ok ? "it was issued" : wrongBranch.error,
  );

  check(
    "and after three refusals the invoice is byte-for-byte where it was",
    JSON.stringify(await snapshotInvoice(invoiceId)) === JSON.stringify(before),
    JSON.stringify(await snapshotInvoice(invoiceId)),
  );

  // ══════════════════════════════════════════════════════════
  section("An issued invoice does not change underneath the customer");
  // ══════════════════════════════════════════════════════════

  const issued = await issueInvoice(
    { invoiceId, reason: "Checked against the consignment note and the rate card." },
    accounts,
  );
  check("the invoice issues", issued.ok, issued.ok ? issued.number : issued.error);

  const afterIssue = await snapshotInvoice(invoiceId);
  check("its status is ISSUED", afterIssue.status === "ISSUED", afterIssue.status);
  check(
    "issuing did not move a single figure",
    afterIssue.subtotal === before.subtotal &&
      afterIssue.taxAmount === before.taxAmount &&
      afterIssue.total === before.total,
    `${afterIssue.subtotal} / ${afterIssue.taxAmount} / ${afterIssue.total}`,
  );

  const reissued = await issueInvoice({ invoiceId, reason: "Again." }, accounts);
  check(
    "it cannot be issued a second time",
    reissued.ok === false,
    reissued.ok ? "it was issued twice" : reissued.error,
  );

  const overCredit = await createCreditNote(
    {
      invoiceId,
      amount: new Decimal(afterIssue.total).plus(1000).toFixed(2),
      reason: "Probe — more than the invoice is worth.",
    },
    accounts,
  );
  check(
    "a credit note larger than the invoice is refused",
    overCredit.ok === false,
    overCredit.ok ? "it was raised" : overCredit.error,
  );

  const stillIssued = await snapshotInvoice(invoiceId);
  check(
    "and the refused credit note left the invoice untouched",
    JSON.stringify(stillIssued) === JSON.stringify(afterIssue),
    JSON.stringify(stillIssued),
  );

  // ══════════════════════════════════════════════════════════
  section("A debit note is the only way to add to an issued invoice");
  // ══════════════════════════════════════════════════════════

  const link = await liveInvoiceForShipment(priced.shipmentId);
  check(
    "the consignment resolves to the invoice it is billed on",
    link?.invoiceId === invoiceId && link?.isIssued === true,
    link ? `${link.number} · issued ${link.isIssued}` : "no link",
  );

  const debitWrongBranch = await createDebitNote(
    {
      againstInvoiceId: invoiceId,
      shipmentId: priced.shipmentId,
      amount: "500.00",
      reason: "Probe — wrong branch.",
    },
    scopedTo(accounts, [bom.primaryBranch!.id]),
  );
  check(
    "raising one against another branch's invoice is refused even holding invoice.create",
    debitWrongBranch.ok === false &&
      !debitWrongBranch.ok &&
      debitWrongBranch.error.includes("another branch"),
    debitWrongBranch.ok ? "it was raised" : debitWrongBranch.error,
  );

  const debitNothing = await createDebitNote(
    {
      againstInvoiceId: invoiceId,
      amount: "0",
      reason: "Probe — for nothing.",
    },
    accounts,
  );
  check(
    "a debit note for nothing is refused, and points at the credit note",
    debitNothing.ok === false &&
      !debitNothing.ok &&
      debitNothing.error.toLowerCase().includes("credit note"),
    debitNothing.ok ? "it was raised" : debitNothing.error,
  );

  const debitNoReason = await createDebitNote(
    { againstInvoiceId: invoiceId, amount: "500.00", reason: "" },
    accounts,
  );
  check(
    "and one with no reason is refused — the customer will ask",
    debitNoReason.ok === false,
    debitNoReason.ok ? "it was raised" : debitNoReason.error,
  );

  const notesAfterRefusals = await prisma.invoice.count({
    where: { notes: { contains: afterIssue.number } },
  });
  check(
    "three refusals raised no supplementary document against this invoice",
    notesAfterRefusals === 0,
    `${notesAfterRefusals} note(s) referencing ${afterIssue.number}`,
  );

  const debit = await createDebitNote(
    {
      againstInvoiceId: invoiceId,
      shipmentId: priced.shipmentId,
      amount: "500.00",
      taxAmount: "25.00",
      taxPercent: "5",
      reason: "Probe — chargeable weight revised at the hub.",
    },
    accounts,
  );

  check("a debit note raises", debit.ok, debit.ok ? debit.number : debit.error);

  if (debit.ok) {
    const note = await prisma.invoice.findUniqueOrThrow({
      where: { id: debit.debitNoteId },
      select: {
        number: true,
        status: true,
        customerId: true,
        branchId: true,
        subtotal: true,
        total: true,
        amountDue: true,
        notes: true,
      },
    });

    check("it is numbered from the debit-note series", note.number.startsWith("DN/"), note.number);
    check(
      "it inherits the original's customer and branch",
      note.customerId === customer.id && note.branchId === draft.branchId,
      `${note.customerId} @ ${note.branchId}`,
    );
    check(
      "it names the invoice it corrects",
      (note.notes ?? "").includes(afterIssue.number),
      note.notes ?? "",
    );
    check(
      "it carries only the delta, not the whole consignment again",
      new Decimal(note.subtotal.toString()).equals("500"),
      `₹${note.subtotal}`,
    );

    const untouched = await snapshotInvoice(invoiceId);
    check(
      "and the invoice it corrects is exactly as it was issued",
      JSON.stringify(untouched) === JSON.stringify(afterIssue),
      `${untouched.total} vs ${afterIssue.total}`,
    );
  }

  section("…and none is raised where none is due");

  const uninvoicedLink = await liveInvoiceForShipment(unrated.shipmentId);
  check(
    "a consignment that has not been billed is on no invoice",
    uninvoicedLink === null,
    uninvoicedLink ? uninvoicedLink.number : "none",
  );

  // ══════════════════════════════════════════════════════════
  section("Money received, and what it stops");
  // ══════════════════════════════════════════════════════════

  const payment = await recordPayment(
    {
      customerId: customer.id,
      amount: "100.00",
      mode: "NEFT",
      reference: "PROBE-BILLING-001",
      receivedOn: businessDay(),
      allocations: [{ invoiceId, amount: "100.00" }],
    },
    accounts,
  );

  check("a receipt records and allocates", payment.ok, payment.ok ? payment.number : payment.error);

  if (payment.ok) {
    const partly = await snapshotInvoice(invoiceId);
    // Compared as `Decimal`, not as strings: Postgres hands back "100" for
    // a `Decimal(14,2)` holding 100.00, and an assertion that cannot tell
    // those apart fails on a ledger that is exactly right.
    check(
      "the invoice is now partly paid",
      partly.status === "PARTIALLY_PAID" &&
        new Decimal(partly.amountPaid).equals("100"),
      `${partly.status} · paid ₹${partly.amountPaid} · due ₹${partly.amountDue}`,
    );
    check(
      "and what is due is the total less what was paid, exactly",
      new Decimal(partly.total).minus(partly.amountPaid).equals(new Decimal(partly.amountDue)),
      `${partly.total} − ${partly.amountPaid} = ${partly.amountDue}`,
    );

    const cancelled = await cancelInvoice(
      { invoiceId, reason: "Probe — should be refused, money is against it." },
      accounts,
    );
    check(
      "cancelling an invoice money has landed on is refused",
      cancelled.ok === false,
      cancelled.ok ? "it was cancelled" : cancelled.error,
    );
    check(
      "and the refusal changed nothing",
      JSON.stringify(await snapshotInvoice(invoiceId)) === JSON.stringify(partly),
    );

    const overAllocated = await recordPayment(
      {
        customerId: customer.id,
        amount: "10.00",
        mode: "NEFT",
        reference: "PROBE-BILLING-002",
        receivedOn: businessDay(),
        allocations: [{ invoiceId, amount: "999999.00" }],
      },
      accounts,
    );
    check(
      "allocating more than an invoice still owes is refused",
      overAllocated.ok === false,
      overAllocated.ok ? "it was recorded" : overAllocated.error,
    );
    check(
      "and no receipt was written for the refused allocation",
      (await prisma.payment.count({ where: { reference: "PROBE-BILLING-002" } })) === 0,
    );
    check(
      "the invoice is where it was before that attempt",
      JSON.stringify(await snapshotInvoice(invoiceId)) === JSON.stringify(partly),
    );
  }

  // ══════════════════════════════════════════════════════════
  section("The branch filter survives the search box");
  // ══════════════════════════════════════════════════════════

  /*
    `anyBranchScope` returns `{ OR: [...] }` and so does a search. Spread
    into one object literal the second silently replaces the first, and the
    screen looks right until somebody types. Proved on the rendered page
    rather than on the query, because the query is not what leaked.
  */
  const ggnSession = await signIn(HOST, GGN_MOBILE);
  check(`signed in as ${ggn.name} at ${ggn.primaryBranch?.code}`, ggnSession.signedIn, ggnSession.detail);

  if (ggnSession.signedIn) {
    const elsewhere = await prisma.invoice.findFirst({
      where: { branchId: { not: ggn.primaryBranch?.id ?? "" } },
      select: { id: true, number: true, branch: { select: { code: true } } },
      orderBy: { invoiceDate: "desc" },
    });

    if (!elsewhere) {
      check("there is an invoice at another branch to search for", false, "none exists");
    } else {
      const searched = await page(
        HOST,
        `/finance/invoices?q=${encodeURIComponent(elsewhere.number)}`,
        ggnSession.jar,
        "Invoices",
      );
      /*
        Asserted on the link, not on the number. The search box echoes what
        was typed back into its own value and the empty state quotes it as
        well, so the number is on the page either way — looking for it would
        report a leak on a screen that correctly found nothing.
      */
      const row = `/finance/invoices/${elsewhere.id}`;
      check(
        `searching for ${elsewhere.branch.code}'s invoice number opens no row`,
        searched.status === 200 && !searched.body.includes(row),
        `looked for a link to ${elsewhere.number}`,
      );

      const receivables = await page(
        HOST,
        `/finance/receivables?q=${encodeURIComponent(customer.name)}`,
        ggnSession.jar,
        "Receivables",
      );
      check(
        "and the receivables search still renders for a branch reader",
        receivables.status === 200,
        `HTTP ${receivables.status}`,
      );
    }

    const otherBranchGaps = await signIn(HOST, BOM_MOBILE);
    if (otherBranchGaps.signedIn) {
      const screen = await page(
        HOST,
        "/finance/coverage-gaps",
        otherBranchGaps.jar,
        "coverage gaps",
      );
      check(
        "a branch that never touched the consignment does not see it on the gap screen",
        screen.status === 200 && !screen.body.includes(unratedShipment.lrNumber),
        `HTTP ${screen.status}`,
      );
    } else {
      check(`signed in as ${bom.name}`, false, otherBranchGaps.detail);
    }
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );

  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

/** Every figure on an invoice, as strings, for a before-and-after compare. */
async function snapshotInvoice(invoiceId: string) {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: {
      number: true,
      status: true,
      subtotal: true,
      taxAmount: true,
      roundOff: true,
      total: true,
      amountPaid: true,
      amountDue: true,
      issuedAt: true,
      cancelledAt: true,
      lines: { select: { amount: true, taxAmount: true }, orderBy: { sortOrder: "asc" } },
    },
  });

  return {
    number: invoice.number,
    status: invoice.status,
    subtotal: invoice.subtotal.toString(),
    taxAmount: invoice.taxAmount.toString(),
    roundOff: invoice.roundOff.toString(),
    total: invoice.total.toString(),
    amountPaid: invoice.amountPaid.toString(),
    amountDue: invoice.amountDue.toString(),
    cancelled: invoice.cancelledAt !== null,
    lines: invoice.lines.map((line) => `${line.amount.toString()}/${line.taxAmount.toString()}`),
  };
}

async function actingTenant(): Promise<TenantContext> {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { subdomain: SUBDOMAIN },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });

  const tenant = tenantContextFor(org, "job");
  if (!tenant) {
    throw new Error(`Organisation "${SUBDOMAIN}" is closed; refusing to run against it.`);
  }
  return tenant;
}

async function main() {
  const tenant = await actingTenant();
  console.log(
    `\nBilling — price, invoice, correct, collect · acting as ${tenant.slug} (${tenant.subdomain})\n`,
  );
  await runWithTenant(tenant, run);
}

main().catch(async (error) => {
  console.error("\nCrashed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
