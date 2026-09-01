/**
 * The core module — bookings, consignments, customers, masters and
 * administration — driven over HTTP as signed-in people.
 *
 *   npx tsx scripts/verify-core.ts [--base http://localhost:3010]
 *
 * The other core checks (`verify-branch-flow`, `verify-shipment-lifecycle`)
 * prove the services. This proves the screens: that the control exists,
 * that the person who may not use it is not offered it, and that the branch
 * boundary holds on a URL typed by hand rather than only in a dropdown.
 *
 * Every assertion below is pinned to a record this script created or named.
 * Nothing counts rows and nothing compares a page against a table total —
 * `verify-reweigh.ts` did that once and started failing the day the table
 * held six rows, reporting a defect in a product that was fine.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { basePrisma, prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor } from "../src/lib/tenant";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";
import { createBooking } from "../src/lib/shipment/booking";
import type { SessionUser } from "../src/lib/auth/session";
import type { DataScope } from "../src/generated/prisma/client";

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

/** Branch crews, as `seed-branch-logins.ts` numbers them. */
const ADMIN = "9999999999";
const GGN_MANAGER = "9333000001";
const GGN_BOOKING = "9333000002";
const GGN_DISPATCH = "9333000004";
const JAI_BOOKING = "9444000002";

/** The throwaway account the forced password change is proved against. */
const TEMP_MOBILE = "9000000101";
const TEMP_PASSWORD = "Handover@1";

let passes = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

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

/** Same flow, for an account whose password is not the shared fixture one. */
async function signInWith(mobile: string, password: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const csrf = await hostFollow(HOST, PORT, "/api/auth/csrf", jar);
  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };
  const response = await hostFetch(HOST, PORT, "/api/auth/callback/password", {
    method: "POST",
    cookie: jar.header(),
    body: new URLSearchParams({
      mobile,
      password,
      csrfToken,
      callbackUrl: `${BASE}/dashboard`,
    }).toString(),
  });
  jar.absorb(response);
  return jar;
}

const SCOPE_RANK: Record<string, number> = {
  OWN: 0,
  BRANCH: 1,
  BRANCH_SET: 2,
  NETWORK: 3,
};

/**
 * A session exactly as sign-in builds one, for the two consignments this
 * script has to plant before it can look for them. The screens themselves
 * are driven over HTTP; this only puts a row on the page to find.
 */
async function sessionFor(mobile: string): Promise<SessionUser | null> {
  const user = await prisma.user.findFirst({
    where: { mobile, status: "ACTIVE" },
    include: {
      primaryBranch: { select: { id: true, code: true, name: true } },
      branchScopes: { select: { branchId: true } },
      roles: {
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      },
    },
  });
  if (!user) return null;

  const permissions = new Set<string>();
  let scope: DataScope = "OWN";
  for (const link of user.roles) {
    for (const rp of link.role.permissions) permissions.add(rp.permission.code);
    if (SCOPE_RANK[link.role.scope] > SCOPE_RANK[scope]) scope = link.role.scope;
  }

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
    roles: user.roles.map((r) => ({
      code: r.role.code,
      name: r.role.name,
      scope: r.role.scope,
    })),
    permissions,
    scope,
    branchIds,
  };
}

/** The contents of one `<select>`, so a branch list can be read on its own. */
function selectBlock(html: string, name: string): string {
  const match = html.match(
    new RegExp(`<select[^>]*name="${name}"[\\s\\S]*?</select>`),
  );
  return match?.[0] ?? "";
}

async function main() {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${SUBDOMAIN}" is closed.`);

  console.log(`\nCore screens — ${org.slug}\n`);

  // ── Fixtures ──────────────────────────────────────────────
  const fixture = await runWithTenant(tenant, async () => {
    // Three branches, not two. The consignment that must be *invisible* to
    // Gurugram has to run between two other branches entirely: a shipment is
    // visible to its origin, its current location and its destination, so
    // Jaipur→Gurugram is one Gurugram may legitimately see and would have
    // made this whole section pass for the wrong reason.
    const [ggn, jai, bom] = await Promise.all([
      prisma.branch.findFirstOrThrow({ where: { code: "BR-GGN" }, select: { id: true } }),
      prisma.branch.findFirstOrThrow({ where: { code: "HUB-JAI" }, select: { id: true } }),
      prisma.branch.findFirstOrThrow({ where: { code: "BR-BOM" }, select: { id: true } }),
    ]);

    const [service, packageType, gurugram, jaipur, ggnRole] = await Promise.all([
      prisma.serviceType.findFirstOrThrow({
        where: { isActive: true, mode: "PTL" },
        select: { id: true },
      }),
      prisma.packageType.findFirstOrThrow({ where: { isActive: true }, select: { id: true } }),
      prisma.city.findFirstOrThrow({ where: { code: "GGN" }, select: { id: true } }),
      prisma.city.findFirstOrThrow({ where: { code: "JAI" }, select: { id: true } }),
      prisma.role.findFirstOrThrow({ where: { code: "BOOKING_EXEC" }, select: { id: true } }),
    ]);

    const ggnBooker = await sessionFor(GGN_BOOKING);
    const jaiBooker = await sessionFor(JAI_BOOKING);
    if (!ggnBooker || !jaiBooker) {
      throw new Error(
        "Branch crews are missing. Run `npm run seed:branch-logins` and try again.",
      );
    }

    const book = (
      booker: SessionUser,
      originId: string,
      destinationId: string,
      label: string,
      pickupRequired: boolean,
    ) =>
      createBooking(
        {
          mode: "PTL",
          serviceTypeId: service.id,
          bookingBranchId: originId,
          originBranchId: originId,
          destinationBranchId: destinationId,
          consignorName: `Core check — ${label}`,
          consignorPhone: "9811100021",
          consignorAddress: "Plot 14, Udyog Vihar Phase IV",
          consignorCityId: gurugram.id,
          consignorPincode: "122015",
          consigneeName: `Core check — ${label}`,
          consigneePhone: "9811100022",
          consigneeAddress: "22 Vaishali Nagar",
          consigneeCityId: jaipur.id,
          consigneePincode: "302013",
          packageCount: 1,
          packageTypeId: packageType.id,
          actualWeight: 5,
          goodsDescription: "Core screen verification — auto-generated",
          declaredValue: 5000,
          paymentType: "PAID",
          pickupRequired,
        },
        booker,
      );

    const atGgn = await book(ggnBooker, ggn.id, jai.id, "Gurugram", false);
    const atJai = await book(jaiBooker, jai.id, bom.id, "Jaipur", false);
    // One that asks for a van, so the date the collection is filed under can
    // be read back.
    const collected = await book(ggnBooker, ggn.id, jai.id, "Collection", true);
    if (!atGgn.ok || !atJai.ok || !collected.ok) {
      throw new Error(
        `Could not plant the consignments: ${[
          atGgn.ok ? null : atGgn.error,
          atJai.ok ? null : atJai.error,
          collected.ok ? null : collected.error,
        ]
          .filter(Boolean)
          .join(" / ")}`,
      );
    }

    // An account owned by nobody — the shape a network-scoped user creates
    // by leaving "Owning branch" blank. The listing has always hidden these
    // from a branch-scoped reader; the detail page used not to.
    const stamp = Date.now().toString(36).toUpperCase().slice(-6);
    const unowned = await prisma.customer.create({
      data: {
        orgId: org.id,
        code: `COREUNOWNED${stamp}`,
        name: "Core check — network-owned account",
        type: "CORPORATE",
        phone: "9811100023",
        paymentTerm: "CASH",
        branchId: null,
      },
      select: { id: true, code: true },
    });

    /**
     * One audit row against each consignment, at the branch that booked it.
     *
     * They are searched for by `entityId` — the shipment's own id — and
     * asserted on by `entityRef`, the LR number the table prints. Searching
     * on the thing being asserted would pass on the search box echoing the
     * query back, which is not a test of anything.
     *
     * These rows stay behind. `audit_log` refuses DELETE by trigger, which
     * is the whole point of an audit trail, so they are written against real
     * consignments and under an entity the screen already lists rather than
     * inventing a category that would sit in the filter for ever.
     */
    const auditFor = (
      shipmentId: string,
      lrNumber: string,
      branchId: string,
    ) =>
      prisma.auditLog.create({
        data: {
          orgId: org.id,
          action: "UPDATE",
          entity: "Shipment",
          entityId: shipmentId,
          entityRef: lrNumber,
          branchId,
          reason: "Core screen verification — auto-generated",
        },
        select: { id: true, entityId: true, entityRef: true },
      });

    // Somebody holding a password an administrator chose for them.
    const temp = await prisma.user.upsert({
      where: { orgId_mobile: { orgId: org.id, mobile: TEMP_MOBILE } },
      create: {
        orgId: org.id,
        name: "Core check — handed a password",
        mobile: TEMP_MOBILE,
        primaryBranchId: ggn.id,
        passwordHash: await bcrypt.hash(TEMP_PASSWORD, 10),
        mustChangePassword: true,
        status: "ACTIVE",
        roles: { create: [{ orgId: org.id, roleId: ggnRole.id }] },
      },
      update: {
        passwordHash: await bcrypt.hash(TEMP_PASSWORD, 10),
        mustChangePassword: true,
        status: "ACTIVE",
        deletedAt: null,
        lockedUntil: null,
        failedLoginCount: 0,
      },
      select: { id: true },
    });

    const dispatcher = await prisma.user.findFirstOrThrow({
      where: { mobile: GGN_DISPATCH },
      select: { id: true },
    });

    const [ggnAudit, jaiAudit] = await Promise.all([
      auditFor(atGgn.shipmentId, atGgn.lrNumber, ggn.id),
      auditFor(atJai.shipmentId, atJai.lrNumber, jai.id),
    ]);

    return {
      ggnId: ggn.id,
      jaiId: jai.id,
      ggnShipment: { id: atGgn.shipmentId, lr: atGgn.lrNumber },
      jaiShipment: { id: atJai.shipmentId, lr: atJai.lrNumber },
      collectedShipmentId: collected.shipmentId,
      unowned,
      jaiAudit,
      ggnAudit,
      tempUserId: temp.id,
      dispatcherId: dispatcher.id,
    };
  });

  // ── The day a collection is filed under ───────────────────
  //
  // `requestedDate` is a `@db.Date` column, which keeps the UTC calendar
  // day. Booking wrote a raw instant into it, so at IST (+5:30) anything
  // booked before 05:30 was filed under yesterday — and `/pickups` asks for
  // one exact day, so no van was ever sent. Asserted against the calendar
  // day *here*, in local time, which is the day the person booking is
  // living in.
  //
  // Honest about its own reach: this is decisive only when the two calendars
  // actually disagree, which at IST means between 00:00 and 05:30. Run at
  // noon it proves the value is a clean calendar day and nothing more. It is
  // still the right assertion — it is the shape the failure takes — and it
  // will catch a regression on any overnight run.
  console.log("The collection a booking raises");

  const raised = await runWithTenant(tenant, async () =>
    prisma.pickupRequest.findFirstOrThrow({
      where: { shipmentId: fixture.collectedShipmentId },
      select: { number: true, requestedDate: true },
    }),
  );

  const now = new Date();
  const expected = Date.UTC(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  check(
    "it is dated the day the booking was actually taken",
    raised.requestedDate.getTime() === expected,
    `${raised.number} — stored ${raised.requestedDate.toISOString()}, expected ${new Date(expected).toISOString()}`,
  );

  const adminJar = await signIn(ADMIN, "/shipments");
  const ggnJar = await signIn(GGN_BOOKING, "/shipments");
  const managerJar = await signIn(GGN_MANAGER, "/shipments");

  // ── The screens are reachable at all ──────────────────────
  console.log("The core screens open");

  for (const [label, path] of [
    ["the shipments list", "/shipments"],
    ["the booking counter", "/shipments/new"],
    ["bulk booking", "/shipments/bulk"],
    ["the customer list", "/customers"],
    ["reason codes", "/masters/reason-codes"],
    ["tax rates", "/masters/tax-rates"],
    ["the user roster", "/admin/users"],
    ["roles and permissions", "/admin/roles"],
    ["the audit trail", "/admin/audit"],
  ] as const) {
    const page = await hostFollow(HOST, PORT, path, adminJar);
    check(
      `${label} renders`,
      page.status === 200 && !page.finalPath.includes("/login"),
      `HTTP ${page.status} at ${page.finalPath}`,
    );
  }

  // ── The origin of a booking is not a free choice ──────────
  console.log("\nWhere a booking may be raised");

  const counter = await hostFollow(HOST, PORT, "/shipments/new", ggnJar);
  const origins = selectBlock(counter.body, "originBranchId");
  const destinations = selectBlock(counter.body, "destinationBranchId");

  check(
    "the Gurugram clerk is offered their own counter as an origin",
    origins.includes("BR-GGN"),
    "origin select",
  );
  check(
    "and is not offered a branch they do not work at",
    origins.length > 0 && !origins.includes("HUB-JAI"),
    "origin select",
  );
  check(
    "while the destination stays the whole network",
    destinations.includes("HUB-JAI"),
    "a consignment goes wherever it is addressed",
  );

  // The branch master is itself scoped — it is the table every other scope
  // check points at, so a manager reading it sees their own nodes and no
  // more. The create and edit dialogs are not rendered for them at all,
  // which is why no other branch's code reaches the page.
  const network = await hostFollow(HOST, PORT, "/masters/branches", managerJar);
  check(
    "the branch master shows a manager their own node and not the network",
    network.status === 200 &&
      network.body.includes("BR-GGN") &&
      !network.body.includes("HUB-JAI"),
    `HTTP ${network.status}`,
  );

  const bulk = await hostFollow(HOST, PORT, "/shipments/bulk", ggnJar);
  check(
    "the bulk uploader offers the same narrowed branch list",
    selectBlock(bulk.body, "branchId").includes("BR-GGN") &&
      !selectBlock(bulk.body, "branchId").includes("HUB-JAI"),
  );

  // ── A consignment belongs to its branches ─────────────────
  //
  // Searched by LR number, asserted on the row's own link. The search box
  // renders the query back, so asking whether the page "contains the LR
  // number you just searched for" is a test of the search box.
  console.log("\nA consignment another branch booked");

  const rowFor = (id: string) => `/shipments/${id}`;

  const ownList = await hostFollow(
    HOST,
    PORT,
    `/shipments?q=${fixture.ggnShipment.lr}`,
    ggnJar,
  );
  check(
    "the clerk's own consignment is on their list",
    ownList.body.includes(rowFor(fixture.ggnShipment.id)),
    fixture.ggnShipment.lr,
  );

  const otherList = await hostFollow(
    HOST,
    PORT,
    `/shipments?q=${fixture.jaiShipment.lr}`,
    ggnJar,
  );
  check(
    "Jaipur's is not",
    !otherList.body.includes(rowFor(fixture.jaiShipment.id)),
    fixture.jaiShipment.lr,
  );

  const byId = await hostFollow(
    HOST,
    PORT,
    `/shipments/${fixture.jaiShipment.id}`,
    ggnJar,
  );
  check(
    "and typing its address does not open it either",
    byId.status === 404,
    `HTTP ${byId.status}`,
  );

  const printed = await hostFollow(
    HOST,
    PORT,
    `/shipments/${fixture.jaiShipment.id}/print`,
    ggnJar,
  );
  check(
    "nor does printing it",
    printed.status === 404,
    `HTTP ${printed.status}`,
  );

  const adminOpens = await hostFollow(
    HOST,
    PORT,
    `/shipments/${fixture.jaiShipment.id}`,
    adminJar,
  );
  check(
    "while the network administrator opens it normally",
    adminOpens.status === 200 && adminOpens.body.includes(fixture.jaiShipment.lr),
    `HTTP ${adminOpens.status}`,
  );

  // ── An account owned by nobody ────────────────────────────
  console.log("\nA customer account with no owning branch");

  const unownedList = await hostFollow(
    HOST,
    PORT,
    `/customers?q=${fixture.unowned.code}`,
    ggnJar,
  );
  check(
    "it is not on a branch clerk's list",
    !unownedList.body.includes(`/customers/${fixture.unowned.id}`),
    fixture.unowned.code,
  );

  const unownedPage = await hostFollow(
    HOST,
    PORT,
    `/customers/${fixture.unowned.id}`,
    ggnJar,
  );
  check(
    "and is not readable by id either — one rule, both surfaces",
    unownedPage.status === 404,
    `HTTP ${unownedPage.status}`,
  );

  const unownedAdmin = await hostFollow(
    HOST,
    PORT,
    `/customers/${fixture.unowned.id}`,
    adminJar,
  );
  check(
    "the network administrator, who owns it, opens it",
    unownedAdmin.status === 200 && unownedAdmin.body.includes(fixture.unowned.code),
    `HTTP ${unownedAdmin.status}`,
  );

  // ── The audit trail is a branch's own ─────────────────────
  console.log("\nThe audit trail");

  const trailOwn = await hostFollow(
    HOST,
    PORT,
    `/admin/audit?q=${fixture.ggnAudit.entityId}`,
    managerJar,
  );
  check(
    "a branch manager sees what happened at their own branch",
    trailOwn.body.includes(fixture.ggnAudit.entityRef ?? ""),
    fixture.ggnAudit.entityRef ?? "",
  );

  const trailOther = await hostFollow(
    HOST,
    PORT,
    `/admin/audit?q=${fixture.jaiAudit.entityId}`,
    managerJar,
  );
  check(
    "and not what happened at another",
    !trailOther.body.includes(fixture.jaiAudit.entityRef ?? ""),
    fixture.jaiAudit.entityRef ?? "",
  );

  const trailAdmin = await hostFollow(
    HOST,
    PORT,
    `/admin/audit?q=${fixture.jaiAudit.entityId}`,
    adminJar,
  );
  check(
    "the network administrator sees both",
    trailAdmin.body.includes(fixture.jaiAudit.entityRef ?? ""),
    fixture.jaiAudit.entityRef ?? "",
  );

  // ── Roles can be made, not only ticked ────────────────────
  console.log("\nRoles");

  const rolesAdmin = await hostFollow(HOST, PORT, "/admin/roles", adminJar);
  check(
    "a role can be created from the roles screen",
    rolesAdmin.body.includes("New role"),
    "the create control is on the page",
  );

  const rolesManager = await hostFollow(HOST, PORT, "/admin/roles", managerJar);
  check(
    "a branch manager may read the roles and not make one",
    rolesManager.status === 200 && !rolesManager.body.includes("New role"),
    `HTTP ${rolesManager.status} — user.read without role.manage`,
  );

  const dispatchRole = await runWithTenant(tenant, async () =>
    prisma.role.findFirstOrThrow({
      where: { code: "DISPATCH_MANAGER" },
      select: { id: true },
    }),
  );

  const roleAdmin = await hostFollow(
    HOST,
    PORT,
    `/admin/roles/${dispatchRole.id}`,
    adminJar,
  );
  check(
    "a role can be renamed and re-scoped from its own page",
    roleAdmin.body.includes("Edit role"),
    "the edit control is on the page",
  );

  const roleManager = await hostFollow(
    HOST,
    PORT,
    `/admin/roles/${dispatchRole.id}`,
    managerJar,
  );
  check(
    "but not by somebody who may only read it",
    roleManager.status === 200 && !roleManager.body.includes("Edit role"),
    `HTTP ${roleManager.status}`,
  );

  // ── BRANCH_SET reaches more than one branch ───────────────
  console.log("\nThe branches a dispatch role reaches");

  const jaiRow = await hostFollow(
    HOST,
    PORT,
    `/shipments?q=${fixture.jaiShipment.lr}`,
    await signIn(GGN_DISPATCH, "/shipments"),
  );
  check(
    "with no branches assigned, the dispatch manager sees only their own",
    !jaiRow.body.includes(rowFor(fixture.jaiShipment.id)),
    fixture.jaiShipment.lr,
  );

  const rosterBefore = await hostFollow(
    HOST,
    PORT,
    `/admin/users?q=${GGN_DISPATCH}`,
    adminJar,
  );
  check(
    "and the roster does not claim otherwise",
    rosterBefore.status === 200 && !rosterBefore.body.includes("+HUB-JAI"),
    GGN_DISPATCH,
  );

  await runWithTenant(tenant, async () => {
    await prisma.userBranchScope.create({
      data: { orgId: org.id, userId: fixture.dispatcherId, branchId: fixture.jaiId },
    });
  });

  const widened = await signIn(GGN_DISPATCH, "/shipments");
  const afterWidening = await hostFollow(
    HOST,
    PORT,
    `/shipments?q=${fixture.jaiShipment.lr}`,
    widened,
  );
  check(
    "assigned a second branch, they see that branch's freight",
    afterWidening.body.includes(rowFor(fixture.jaiShipment.id)),
    "BRANCH_SET no longer collapses to the home branch",
  );

  const rosterAfter = await hostFollow(
    HOST,
    PORT,
    `/admin/users?q=${GGN_DISPATCH}`,
    adminJar,
  );
  check(
    "and the roster says so, on the row",
    rosterAfter.body.includes("+HUB-JAI"),
    "the reason they can see Jaipur is legible to whoever asks",
  );

  await runWithTenant(tenant, async () => {
    await prisma.userBranchScope.deleteMany({
      where: { userId: fixture.dispatcherId, branchId: fixture.jaiId },
    });
  });

  const narrowed = await signIn(GGN_DISPATCH, "/shipments");
  const afterNarrowing = await hostFollow(
    HOST,
    PORT,
    `/shipments?q=${fixture.jaiShipment.lr}`,
    narrowed,
  );
  check(
    "and lose it again when it is taken away",
    !afterNarrowing.body.includes(rowFor(fixture.jaiShipment.id)),
    "the reach is the rows, not the role alone",
  );

  // ── A password somebody else chose ────────────────────────
  console.log("\nThe password an administrator handed over");

  const handedJar = await signInWith(TEMP_MOBILE, TEMP_PASSWORD);

  const bounced = await hostFollow(HOST, PORT, "/shipments", handedJar);
  check(
    "every page redirects to the change screen",
    bounced.finalPath.startsWith("/password"),
    `landed at ${bounced.finalPath}`,
  );

  const bouncedElsewhere = await hostFollow(HOST, PORT, "/customers", handedJar);
  check(
    "it is the whole application, not one screen",
    bouncedElsewhere.finalPath.startsWith("/password"),
    `landed at ${bouncedElsewhere.finalPath}`,
  );

  check(
    "and the screen says why they are there",
    bounced.status === 200 && bounced.body.includes("Choose your own password"),
    `HTTP ${bounced.status}`,
  );

  // Nothing was written by the bounce: the account still carries the flag,
  // so a redirect cannot be mistaken for the change having happened.
  const stillFlagged = await runWithTenant(tenant, async () =>
    prisma.user.findUniqueOrThrow({
      where: { id: fixture.tempUserId },
      select: { mustChangePassword: true },
    }),
  );
  check(
    "the account is untouched until the password is actually changed",
    stillFlagged.mustChangePassword === true,
  );

  await runWithTenant(tenant, async () => {
    await prisma.user.update({
      where: { id: fixture.tempUserId },
      data: { mustChangePassword: false },
    });
  });

  const released = await signInWith(TEMP_MOBILE, TEMP_PASSWORD);
  const working = await hostFollow(HOST, PORT, "/shipments", released);
  check(
    "once it is their own password, the application opens",
    working.status === 200 && !working.finalPath.startsWith("/password"),
    `HTTP ${working.status} at ${working.finalPath}`,
  );

  const byChoice = await hostFollow(HOST, PORT, "/password", released);
  check(
    "and the screen is still reachable by choice",
    byChoice.status === 200 && byChoice.body.includes("Change your password"),
    `HTTP ${byChoice.status}`,
  );

  // The way in for somebody not being forced is the user menu, whose
  // contents a dropdown only builds when it is opened — so what is checked
  // here is that the route answers to a signed-in person who is not carrying
  // the flag, which is the thing that would break.
  const chosen = await hostFollow(HOST, PORT, "/password", adminJar);
  check(
    "an administrator who was never forced can still change theirs",
    chosen.status === 200 && chosen.body.includes("Change your password"),
    `HTTP ${chosen.status}`,
  );

  // ── Tidy up ───────────────────────────────────────────────
  //
  // The consignments and the audit rows stay: both are records the product
  // refuses to delete, and `audit_log` enforces that with a trigger. What
  // this script invented purely for its own sake goes.
  await runWithTenant(tenant, async () => {
    await prisma.customer.delete({ where: { id: fixture.unowned.id } });
    // Deactivated rather than deleted, for the reason written out at
    // `deactivateUser` — the sign-ins above left `LoginActivity` rows
    // pointing at this account.
    await prisma.user.update({
      where: { id: fixture.tempUserId },
      data: { status: "INACTIVE", deletedAt: new Date() },
    });
  });

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nThe core screen check could not run:\n", error);
  process.exit(1);
});
