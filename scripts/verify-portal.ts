/**
 * The customer portal and bulk intake, checked as a process rather than as
 * a set of pages.
 *
 *   npx tsx scripts/verify-portal.ts [--tenant city-logistics]
 *                                    [--dark acme]
 *                                    [--base http://localhost:3010]
 *
 * `smoke-portal.ts` already proves every portal screen renders and that one
 * customer cannot open another's records by id. This does not repeat that.
 * It asks the questions that survive a rendering test:
 *
 *   1. **Is the portal actually gated?** It is a paid module, and a module
 *      gate that only lives in a layout is a gate on pages — not on route
 *      handlers, not on server actions, and not on the sign-in endpoint,
 *      which sits outside `(portal)` altogether. `--dark` names a carrier
 *      whose plan does not include the portal, and every one of those
 *      surfaces is asked for on that host.
 *
 *   2. **Do the three session populations stay apart?** A portal cookie is
 *      offered to the ops screens and a staff cookie to the portal, in both
 *      directions and including the route handlers, which no layout guards.
 *
 *   3. **Does calling off a collection do the three things it has to?**
 *      Close the request with its reason in its own column, take the stop
 *      off the executive, and tell the consignment. And does it refuse a
 *      stranger's pickup in words that do not confirm the pickup is real?
 *
 *   4. **Is the account ever an input?** The bulk stamp is the one place a
 *      consignment's owner is written after the fact, so it is asked to fill
 *      a blank, and then asked to move one that is already set — which it
 *      must refuse.
 *
 * ── On assertions and how much data is in the database ──────
 *
 * Nothing here compares a count of one thing against a page of another.
 * Every row this asserts on is one it created in this run and holds the id
 * of, and every count is of that set. `verify-reweigh.ts` began failing the
 * day its table held six rows, and the product was fine — an assertion whose
 * answer moves with the seed is measuring the seed.
 *
 * Fixtures are left behind, as `verify-spine.ts` leaves its own: a cancelled
 * pickup and a staged batch are ordinary records, and deleting them would
 * make a second run of this script test something different from the first.
 */
import "dotenv/config";
import { basePrisma, disconnectDb } from "../src/lib/prisma-base";
import { prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor } from "../src/lib/tenant";
import { createBooking } from "../src/lib/shipment/booking";
import { createBulkBatch } from "../src/lib/bulk/batch";
import { buildTemplateCsv } from "../src/lib/bulk/template";
import type { SessionUser } from "../src/lib/auth/session";
import type { CustomerSession } from "../src/lib/auth/customer-session";
import {
  cancelPortalPickup,
  createPortalPickup,
  listPortalPickups,
} from "../src/lib/portal/pickups";
import {
  consignorForSession,
  createPortalBulkBatch,
  getPortalBatch,
  stampBulkConsignor,
} from "../src/lib/portal/bulk";
import { amendmentActorFor, bookingActorFor } from "../src/lib/portal/service-actor";
import { PORTAL_GROUPS } from "../src/lib/portal/queries";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";

// ────────────────────────────────────────────────────────────
// Arguments and house-style reporting
// ────────────────────────────────────────────────────────────

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "true");
}

const BASE = args.get("base") ?? process.env.APP_URL ?? "http://localhost:3010";
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
const TENANT = args.get("tenant") ?? "city-logistics";
/** A carrier whose plan does not include the portal. */
const DARK = args.get("dark") ?? "acme";
const HOST = `${TENANT}.${ROOT}`;
const DARK_HOST = `${DARK}.${ROOT}`;

const PORTAL_PASSWORD = process.env.PORTAL_DEMO_PASSWORD ?? "Portal@123";
const STAFF_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? "Admin@123";
const ADMIN_MOBILE = process.env.SMOKE_ADMIN_MOBILE ?? "9999999999";
/**
 * A branch-scoped desk that may upload, used to prove a batch outside its
 * branches is unreachable.
 *
 * The Booking Executive at BR-GGN, not the Branch Manager: `BOOKING_EXEC` is
 * the only BRANCH-scoped role holding `shipment.bulk_upload`, and a desk
 * without the permission lands on `/forbidden` for every batch — which
 * answers a different question and would pass for the wrong reason.
 */
const BRANCH_CLERK_MOBILE = args.get("clerk") ?? "9333000002";

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
// Sign-in helpers — the same route `smoke-portal.ts` uses
// ────────────────────────────────────────────────────────────

async function csrfFor(host: string, jar: CookieJar): Promise<string> {
  const response = await hostFetch(host, PORT, "/api/auth/csrf", {
    cookie: jar.header(),
  });
  jar.absorb(response);
  return (JSON.parse(response.body) as { csrfToken: string }).csrfToken;
}

async function signInCustomer(host: string, email: string, password: string) {
  const jar = new CookieJar();
  const csrfToken = await csrfFor(host, jar);

  const response = await hostFetch(host, PORT, "/api/auth/callback/customer", {
    method: "POST",
    cookie: jar.header(),
    body: new URLSearchParams({
      email,
      password,
      csrfToken,
      callbackUrl: `http://${host}:${PORT}/portal`,
    }).toString(),
  });
  jar.absorb(response);

  return { jar, ok: !(response.location ?? "").includes("error") };
}

async function signInStaff(host: string, mobile: string, password: string) {
  const jar = new CookieJar();
  const csrfToken = await csrfFor(host, jar);

  const response = await hostFetch(host, PORT, "/api/auth/callback/password", {
    method: "POST",
    cookie: jar.header(),
    body: new URLSearchParams({
      mobile,
      password,
      csrfToken,
      callbackUrl: `http://${host}:${PORT}/dashboard`,
    }).toString(),
  });
  jar.absorb(response);

  const landed = await hostFollow(host, PORT, "/dashboard", jar);
  return { jar, ok: landed.status === 200 && !landed.finalPath.startsWith("/login") };
}

/** True when the response is a redirect to `path`. */
function bouncedTo(
  response: { status: number; location: string | null },
  path: string,
): boolean {
  return (
    response.status >= 300 &&
    response.status < 400 &&
    (response.location ?? "").includes(path)
  );
}

// ────────────────────────────────────────────────────────────
// The people this script acts as
// ────────────────────────────────────────────────────────────

type PortalLogin = {
  email: string;
  customerUserId: string;
  customerId: string;
  customerName: string;
  session: CustomerSession;
};

/**
 * Builds the `CustomerSession` the library layer takes, from the row the
 * portal itself would resolve.
 *
 * The screens are driven over HTTP; this is only for the service-layer
 * assertions, which cannot be reached through a `useActionState` action
 * without reconstructing Next's action protocol — the same reason
 * `smoke-portal.ts` signs in through the credentials callback rather than
 * through the login form.
 */
async function loadPortalLogin(email: string): Promise<PortalLogin | null> {
  const user = await prisma.customerUser.findFirst({
    where: { email, deletedAt: null, isActive: true },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      mustChangePassword: true,
      visibleBranchIds: true,
      customer: { select: { id: true, orgId: true, code: true, name: true } },
    },
  });
  if (!user) return null;

  return {
    email: user.email,
    customerUserId: user.id,
    customerId: user.customer.id,
    customerName: user.customer.name,
    session: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      customerId: user.customer.id,
      customerCode: user.customer.code,
      customerName: user.customer.name,
      orgId: user.customer.orgId,
      visibleBranchIds: user.visibleBranchIds,
    },
  };
}

/** Two portal owners on two different accounts under this carrier. */
async function findTwoOwners(): Promise<[PortalLogin, PortalLogin] | null> {
  const users = await prisma.customerUser.findMany({
    where: { deletedAt: null, isActive: true, role: "OWNER" },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { email: true, customerId: true },
  });

  const seen = new Set<string>();
  const picked: PortalLogin[] = [];
  for (const user of users) {
    if (seen.has(user.customerId)) continue;
    seen.add(user.customerId);
    const login = await loadPortalLogin(user.email);
    if (login) picked.push(login);
    if (picked.length === 2) break;
  }

  return picked.length === 2 ? [picked[0], picked[1]] : null;
}

async function loadAdminActor(): Promise<SessionUser> {
  const user = await prisma.user.findFirstOrThrow({
    where: { mobile: ADMIN_MOBILE },
    include: {
      primaryBranch: { select: { id: true, code: true, name: true } },
      roles: {
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      },
    },
  });

  const permissions = new Set<string>();
  for (const link of user.roles) {
    for (const rp of link.role.permissions) permissions.add(rp.permission.code);
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
    scope: "NETWORK",
    branchIds: null,
  };
}

// ────────────────────────────────────────────────────────────
// 1. The portal is a paid module
// ────────────────────────────────────────────────────────────

/**
 * Every surface under `/portal` on a carrier who has not bought it.
 *
 * The three are deliberately different kinds of thing, because they are
 * guarded by different code. A page is stopped by the layout; a route
 * handler runs no layout at all and is stopped only by the session; and the
 * sign-in callback lives outside `(portal)` entirely and is stopped only by
 * `authenticateCustomer`.
 */
async function checkPlanGate(darkOrgId: string) {
  section(`The portal is a paid module — ${DARK} has not bought it`);

  const pages = ["/portal", "/portal/login", "/portal/shipments", "/portal/pickups"];
  for (const path of pages) {
    const response = await hostFetch(DARK_HOST, PORT, path);
    check(
      `${path} does not exist on ${DARK}`,
      response.status === 404,
      response.status === 404 ? "404" : `HTTP ${response.status}`,
    );
  }

  // A route handler. No layout runs for it, so the layout's 404 is not what
  // refuses this one — the session is.
  const template = await hostFetch(DARK_HOST, PORT, "/portal/bulk/template");
  check(
    "the booking template is not served on a carrier without the portal",
    template.status !== 200 || !template.body.includes("Consignee Name"),
    `HTTP ${template.status}`,
  );

  // The sign-in endpoint. `authenticateCustomer` must refuse before it
  // touches `customer_user` at all, which is observable: a refusal that got
  // as far as the lookup writes a `LoginActivity` row, and one that did not
  // writes nothing. The email is generated so the assertion counts only
  // rows this run caused.
  const probeEmail = `verify-portal-${Date.now()}@example.invalid`;
  const jar = new CookieJar();
  const csrfToken = await csrfFor(DARK_HOST, jar);
  await hostFetch(DARK_HOST, PORT, "/api/auth/callback/customer", {
    method: "POST",
    cookie: jar.header(),
    body: new URLSearchParams({
      email: probeEmail,
      password: "not-the-password",
      csrfToken,
      callbackUrl: `http://${DARK_HOST}:${PORT}/portal`,
    }).toString(),
  });

  const recorded = await basePrisma.loginActivity.count({
    where: { orgId: darkOrgId, identifier: `portal:${probeEmail}` },
  });
  check(
    "a portal sign-in attempt is refused before the customer table is read",
    recorded === 0,
    recorded === 0 ? "no attempt recorded" : `${recorded} row(s) written`,
  );
}

/** The same paths on a carrier that did buy it, so a pass is not universal. */
async function checkPlanGatePositiveControl() {
  const login = await hostFetch(HOST, PORT, "/portal/login");
  check(
    `the portal login renders on ${TENANT}, which has the module`,
    login.status === 200 && login.body.includes("Customer sign in"),
    `HTTP ${login.status}`,
  );
}

// ────────────────────────────────────────────────────────────
// 2. Three populations, and none of them is the other
// ────────────────────────────────────────────────────────────

async function checkCrossPopulation(customerJar: CookieJar, staffJar: CookieJar) {
  section("Cross-population — a cookie only opens its own surface");

  for (const path of ["/shipments", "/shipments/bulk", "/pickups", "/dashboard"]) {
    const response = await hostFetch(HOST, PORT, path, {
      cookie: customerJar.header(),
    });
    check(
      `a portal cookie does not open ${path}`,
      bouncedTo(response, "/login") && !bouncedTo(response, "/portal/login"),
      `HTTP ${response.status} ${response.location ?? ""}`,
    );
  }

  for (const path of ["/portal", "/portal/shipments", "/portal/bulk"]) {
    const response = await hostFetch(HOST, PORT, path, { cookie: staffJar.header() });
    check(
      `a staff cookie does not open ${path}`,
      bouncedTo(response, "/portal/login"),
      `HTTP ${response.status} ${response.location ?? ""}`,
    );
  }

  // The route handlers again, because no layout runs for them: a staff
  // cookie must not fetch a customer-side document either.
  const template = await hostFetch(HOST, PORT, "/portal/bulk/template", {
    cookie: staffJar.header(),
  });
  check(
    "a staff cookie does not download the portal booking template",
    template.status === 403,
    `HTTP ${template.status}`,
  );

  const mine = await hostFollow(HOST, PORT, "/portal/bulk/template", customerJar);
  check(
    "but the customer's own cookie does",
    mine.status === 200 && mine.body.includes("Consignee Name"),
    `HTTP ${mine.status}`,
  );
}

// ────────────────────────────────────────────────────────────
// 3. The shipment filters cover every status
// ────────────────────────────────────────────────────────────

/**
 * A chip per group, and a group per chip.
 *
 * The overview counts "in flight" across four of the spine's groups and
 * used to link to one of them, so the number on the card and the length of
 * the list it opened were different questions. `inNetwork` had no chip at
 * all, which put four statuses — the ones a consignment holds for most of
 * the day after it is collected — behind "All" and nowhere else.
 */
async function checkShipmentFilters(jar: CookieJar) {
  section("Shipment filters — every status is reachable, every tile is honest");

  for (const group of Object.keys(PORTAL_GROUPS)) {
    const response = await hostFollow(
      HOST,
      PORT,
      `/portal/shipments?group=${group}`,
      jar,
    );
    check(
      `?group=${group} is accepted`,
      response.status === 200,
      `HTTP ${response.status}`,
    );
  }

  const list = await hostFollow(HOST, PORT, "/portal/shipments", jar);
  for (const group of Object.keys(PORTAL_GROUPS)) {
    check(
      `the list offers a chip for ${group}`,
      list.body.includes(`group=${group}`),
      list.body.includes(`group=${group}`)
        ? ""
        : "counted by the overview, filterable by nobody",
    );
  }

  const bogus = await hostFollow(
    HOST,
    PORT,
    "/portal/shipments?group=not-a-group",
    jar,
  );
  check(
    "an unknown group falls back to the whole list rather than erroring",
    bogus.status === 200,
    `HTTP ${bogus.status}`,
  );

  const overview = await hostFollow(HOST, PORT, "/portal", jar);
  check(
    'the "In flight" tile links to the filter that holds the same number',
    overview.body.includes("group=inFlight"),
    overview.body.includes("group=inFlight")
      ? ""
      : "the tile counts four groups and opens one of them",
  );
  check(
    '"Delivered this month" does not link to a list of every delivery ever',
    !overview.body.includes("group=done"),
  );
}

// ────────────────────────────────────────────────────────────
// 4. Calling off a collection
// ────────────────────────────────────────────────────────────

/** Midnight UTC of the local calendar day — how a `@db.Date` column stores it. */
function storedToday(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0),
  );
}

async function checkPickupCancellation(mine: PortalLogin, theirs: PortalLogin) {
  section("Pickups — raising one, and calling it off");

  const address = await prisma.customerAddress.findFirst({
    where: { customerId: mine.customerId, isActive: true },
    select: { id: true },
  });

  if (!address) {
    check(
      `${mine.customerName} has a saved address to collect from`,
      false,
      "no active address, so the pickup half cannot run",
    );
    return;
  }

  const wanted = storedToday();
  const raised = await createPortalPickup(mine.session, {
    addressId: address.id,
    requestedDate: wanted,
    slot: "ANYTIME",
    expectedPackages: 2,
    goodsDescription: "verify-portal fixture",
    notes: "Gate 4, ask for the security desk",
  });

  check(
    "a collection can be raised from the portal",
    raised.ok,
    raised.ok ? raised.number : raised.error,
  );
  if (!raised.ok) return;

  const stored = await prisma.pickupRequest.findUniqueOrThrow({
    where: { id: raised.id },
    select: {
      requestedDate: true,
      customerId: true,
      branchId: true,
      notes: true,
      status: true,
    },
  });

  // The date the customer asked for, stored the way the column stores one.
  // Local midnight into a `@db.Date` is the mistake this repo has made three
  // times; the assertion is on the instant, not on how it prints.
  check(
    "the requested date is stored at UTC midnight of the day asked for",
    stored.requestedDate.getTime() === wanted.getTime(),
    `${stored.requestedDate.toISOString()} vs ${wanted.toISOString()}`,
  );
  check(
    "the request belongs to the account that raised it",
    stored.customerId === mine.customerId,
  );
  check(
    "the branch was derived, not posted",
    Boolean(stored.branchId),
  );

  // ── The refusal must not confirm the record ──────────────
  const strangersPickup = await cancelPortalPickup(theirs.session, raised.id);
  const inventedId = await cancelPortalPickup(theirs.session, "cl00000000000000000000000");

  check(
    "another customer cannot cancel this collection",
    !strangersPickup.ok,
    strangersPickup.ok ? "LEAK — it was cancelled" : "",
  );
  check(
    "and is told exactly what a made-up id is told",
    !strangersPickup.ok &&
      !inventedId.ok &&
      strangersPickup.error === inventedId.error,
    !strangersPickup.ok && !inventedId.ok
      ? strangersPickup.error === inventedId.error
        ? ""
        : `"${strangersPickup.error}" vs "${inventedId.error}" — the difference confirms the record is real`
      : "",
  );

  // ── The stop leaves the executive's run ──────────────────
  const executive = await prisma.user.findFirst({
    where: { isFieldUser: true, status: "ACTIVE" },
    select: { id: true },
  });

  if (executive) {
    await prisma.pickupRequest.update({
      where: { id: raised.id },
      data: { status: "ASSIGNED" },
    });
    await prisma.pickupAssignment.create({
      data: {
        orgId: mine.session.orgId,
        pickupRequestId: raised.id,
        assignedToId: executive.id,
        status: "ASSIGNED",
      },
    });
  }

  const cancelled = await cancelPortalPickup(mine.session, raised.id);
  check(
    "the customer can call off their own collection",
    cancelled.ok,
    cancelled.ok ? cancelled.number : cancelled.error,
  );

  const after = await prisma.pickupRequest.findUniqueOrThrow({
    where: { id: raised.id },
    select: {
      status: true,
      cancelReason: true,
      cancelledAt: true,
      cancelledById: true,
      notes: true,
      assignments: { select: { supersededAt: true, status: true } },
    },
  });

  check("the request closes as CANCELLED", after.status === "CANCELLED", after.status);
  check(
    "the reason goes in its own column and names the portal login",
    Boolean(after.cancelReason?.includes(mine.session.name)),
    after.cancelReason ?? "no reason recorded",
  );
  check(
    "the branch's own instructions to the executive survive it",
    after.notes === "Gate 4, ask for the security desk",
    after.notes ?? "notes were overwritten",
  );
  check(
    "`cancelledById` stays null — a portal login is not a staff row",
    after.cancelledById === null,
    after.cancelledById ?? "",
  );

  if (executive) {
    const live = after.assignments.filter((a) => a.supersededAt === null);
    check(
      "the live assignment is superseded, so the stop leaves the run",
      live.length === 0 && after.assignments.length > 0,
      `${live.length} assignment(s) still open`,
    );
    check(
      "and is kept rather than deleted, so who held it survives",
      after.assignments.length > 0 &&
        after.assignments.every((a) => a.status === "CANCELLED"),
    );
    check(
      "the executive it was taken from is named in the result",
      cancelled.ok && cancelled.unassigned.includes(executive.id),
    );
  }

  const again = await cancelPortalPickup(mine.session, raised.id);
  check(
    "cancelling it twice is refused, and says so plainly",
    !again.ok && (again.error ?? "").toLowerCase().includes("already cancelled"),
    again.ok ? "it was cancelled twice" : again.error,
  );

  const listed = await listPortalPickups(mine.session);
  check(
    "the cancelled request is still on the customer's own list",
    listed.some((row) => row.id === raised.id && row.status === "CANCELLED"),
  );
}

/**
 * A collection raised behind a consignment, and what the consignment is
 * told when it is called off.
 *
 * `BOOKING_AMENDED`, because there is no `PICKUP_CANCELLED` rule and
 * inventing one is a change to the spine — see the docblock on
 * `src/lib/pickup/cancel.ts`. The consignment must not move.
 */
async function checkShipmentIsTold(mine: PortalLogin) {
  section("The consignment behind a collection is told, and does not move");

  const admin = await loadAdminActor();
  const [service, packageType] = await Promise.all([
    prisma.serviceType.findFirstOrThrow({
      where: { isActive: true },
      orderBy: { code: "asc" },
    }),
    prisma.packageType.findFirstOrThrow({}),
  ]);
  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { code: "asc" },
    select: { id: true },
  });
  const [originCity, destinationCity] = await Promise.all([
    prisma.city.findFirstOrThrow({ orderBy: { code: "asc" } }),
    prisma.city.findFirstOrThrow({ orderBy: { code: "desc" } }),
  ]);

  const booked = await createBooking(
    {
      mode: service.mode,
      serviceTypeId: service.id,
      bookingBranchId: branch.id,
      originBranchId: branch.id,
      destinationBranchId: branch.id,
      consignorId: mine.customerId,
      consignorName: mine.customerName,
      consignorPhone: "9811100031",
      consignorAddress: "verify-portal origin",
      consignorCityId: originCity.id,
      consignorPincode: "122015",
      consigneeName: "Verify Portal Consignee",
      consigneePhone: "9811100032",
      consigneeAddress: "verify-portal destination",
      consigneeCityId: destinationCity.id,
      consigneePincode: "302013",
      packageCount: 1,
      packageTypeId: packageType.id,
      actualWeight: 2,
      goodsDescription: "verify-portal fixture",
      paymentType: "PAID",
      // The whole point: this raises a collection behind the consignment.
      pickupRequired: true,
    },
    admin,
  );

  if (!booked.ok) {
    check("a consignment with a collection behind it can be booked", false, booked.error);
    return;
  }
  check("a consignment with a collection behind it can be booked", true, booked.lrNumber);

  const request = await prisma.pickupRequest.findFirst({
    where: { shipmentId: booked.shipmentId },
    select: { id: true, number: true },
  });

  if (!request) {
    check("the booking raised a collection", false, "no pickup request was created");
    return;
  }
  check("the booking raised a collection", true, request.number);

  const before = await prisma.shipment.findUniqueOrThrow({
    where: { id: booked.shipmentId },
    select: { currentStatus: true },
  });

  const cancelled = await cancelPortalPickup(mine.session, request.id);
  check(
    "the customer calls it off from the portal",
    cancelled.ok,
    cancelled.ok ? "" : cancelled.error,
  );
  check(
    "and the consignment is told",
    cancelled.ok && cancelled.shipmentEvent === "RECORDED",
    cancelled.ok ? cancelled.shipmentEvent : "",
  );

  const event = await prisma.shipmentEvent.findFirst({
    where: { shipmentId: booked.shipmentId, eventType: "BOOKING_AMENDED" },
    orderBy: { recordedAt: "desc" },
    select: { customerUserId: true, resultingStatus: true, remarks: true },
  });

  check(
    "as BOOKING_AMENDED — no invented spine event",
    Boolean(event),
    event ? "" : "nothing was appended",
  );
  check(
    "naming the portal login who did it, not just the service principal",
    event?.customerUserId === mine.customerUserId,
    event?.customerUserId ?? "no customer user on the event",
  );
  check(
    "with the pickup number in the remark, so the log says why nobody is coming",
    Boolean(event?.remarks?.includes(request.number)),
    event?.remarks ?? "",
  );

  const after = await prisma.shipment.findUniqueOrThrow({
    where: { id: booked.shipmentId },
    select: { currentStatus: true },
  });
  check(
    "and the consignment's status does not move",
    after.currentStatus === before.currentStatus,
    `${before.currentStatus} → ${after.currentStatus}`,
  );
}

/**
 * The service principal the portal writes as, and how narrow it is.
 *
 * Two permission sets rather than one wider one: a booking cannot amend,
 * and an amendment cannot book. Neither can sign in.
 */
async function checkServiceActor(mine: PortalLogin) {
  section("The portal's service principal carries one permission at a time");

  const booking = await bookingActorFor(mine.session);
  const amendment = await amendmentActorFor(mine.session);

  check(
    "a portal booking carries shipment.create and nothing else",
    booking.permissions.size === 1 && booking.permissions.has("shipment.create"),
    [...booking.permissions].join(", "),
  );
  check(
    "a portal amendment carries shipment.update and nothing else",
    amendment.permissions.size === 1 && amendment.permissions.has("shipment.update"),
    [...amendment.permissions].join(", "),
  );
  check(
    "neither can book *and* amend",
    !booking.permissions.has("shipment.update") &&
      !amendment.permissions.has("shipment.create"),
  );
  check(
    "and neither carries network scope",
    booking.scope === "OWN" && amendment.scope === "OWN",
    `${booking.scope} / ${amendment.scope}`,
  );

  const row = await prisma.user.findUniqueOrThrow({
    where: { id: booking.id },
    select: { status: true, passwordHash: true, mobile: true },
  });
  check(
    "the principal itself can never sign in",
    row.status === "INACTIVE" && row.passwordHash === null,
    `${row.status}, hash ${row.passwordHash === null ? "null" : "SET"}`,
  );
  check(
    "both actors are the same principal, not two rows",
    booking.id === amendment.id,
  );
}

// ────────────────────────────────────────────────────────────
// 5. Bulk intake — the account is never an input
// ────────────────────────────────────────────────────────────

async function checkBulkOwnership(mine: PortalLogin, theirs: PortalLogin) {
  section("Bulk intake — the account is never taken from the file");

  check(
    "the consignor is the session's account even when the row names another",
    consignorForSession(mine.session, {
      consignorId: theirs.customerId,
      customerCode: "RIVAL",
    }).consignorId === mine.customerId,
  );

  const staged = await createPortalBulkBatch(mine.session, {
    fileName: "verify-portal.csv",
    contentType: "text/csv",
    bytes: Buffer.from(buildTemplateCsv(), "utf8"),
  });

  check(
    "a customer can stage a file",
    staged.ok,
    staged.ok ? staged.batchId : staged.error,
  );
  if (!staged.ok) return null;

  const owner = await prisma.bulkUploadBatch.findUniqueOrThrow({
    where: { id: staged.batchId },
    select: { customerId: true, uploadedByCustomerUserId: true, branchId: true },
  });
  check(
    "the batch is stamped with the account before anything can read it",
    owner.customerId === mine.customerId,
  );
  check(
    "and with the login that uploaded it",
    owner.uploadedByCustomerUserId === mine.customerUserId,
  );

  const asOwner = await getPortalBatch(mine.session, staged.batchId);
  const asStranger = await getPortalBatch(theirs.session, staged.batchId);
  check("the account that uploaded it can open it", asOwner !== null);
  check(
    "another account cannot — it resolves to nothing, not to a refusal",
    asStranger === null,
    asStranger === null ? "" : "LEAK — another customer read the batch",
  );

  return { batchId: staged.batchId, branchId: owner.branchId };
}

/**
 * The one place a consignment's owner is written after it exists.
 *
 * Three properties, and the second is the one that matters: it fills a
 * blank, and it cannot move a consignment that already belongs to somebody.
 */
async function checkStamp(mine: PortalLogin, theirs: PortalLogin) {
  section("The bulk stamp fills a blank and can never move one");

  const admin = await loadAdminActor();
  const [service, packageType] = await Promise.all([
    prisma.serviceType.findFirstOrThrow({ where: { isActive: true }, orderBy: { code: "asc" } }),
    prisma.packageType.findFirstOrThrow({}),
  ]);
  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { code: "asc" },
    select: { id: true },
  });
  const [originCity, destinationCity] = await Promise.all([
    prisma.city.findFirstOrThrow({ orderBy: { code: "asc" } }),
    prisma.city.findFirstOrThrow({ orderBy: { code: "desc" } }),
  ]);

  // A consignment with no consignor — exactly what a counter commit leaves.
  const unowned = await createBooking(
    {
      mode: service.mode,
      serviceTypeId: service.id,
      bookingBranchId: branch.id,
      originBranchId: branch.id,
      destinationBranchId: branch.id,
      consignorName: "Walk-in consignor",
      consignorPhone: "9811100041",
      consignorAddress: "verify-portal counter origin",
      consignorCityId: originCity.id,
      consignorPincode: "122015",
      consigneeName: "Verify Portal Consignee",
      consigneePhone: "9811100042",
      consigneeAddress: "verify-portal counter destination",
      consigneeCityId: destinationCity.id,
      consigneePincode: "302013",
      packageCount: 1,
      packageTypeId: packageType.id,
      actualWeight: 1,
      goodsDescription: "verify-portal stamp fixture",
      paymentType: "PAID",
      pickupRequired: false,
    },
    admin,
  );

  if (!unowned.ok) {
    check("a counter booking with no consignor can be made", false, unowned.error);
    return;
  }

  const blank = await prisma.shipment.findUniqueOrThrow({
    where: { id: unowned.shipmentId },
    select: { consignorId: true, currentStatus: true },
  });
  check(
    "a counter booking really does come out with no consignor",
    blank.consignorId === null,
    blank.consignorId ?? "",
  );

  const filled = await stampBulkConsignor({
    customerId: mine.customerId,
    shipmentIds: [unowned.shipmentId],
  });
  check("the stamp fills the blank", filled === 1, `${filled} stamped`);

  const owned = await prisma.shipment.findUniqueOrThrow({
    where: { id: unowned.shipmentId },
    select: { consignorId: true, currentStatus: true },
  });
  check(
    "and the consignment is now the customer's",
    owned.consignorId === mine.customerId,
  );
  check(
    "attribution is not a state change — the status is untouched",
    owned.currentStatus === blank.currentStatus,
    `${blank.currentStatus} → ${owned.currentStatus}`,
  );

  // The property the whole design rests on.
  const moved = await stampBulkConsignor({
    customerId: theirs.customerId,
    shipmentIds: [unowned.shipmentId],
  });
  const stillMine = await prisma.shipment.findUniqueOrThrow({
    where: { id: unowned.shipmentId },
    select: { consignorId: true },
  });
  check(
    "a second stamp cannot move it to another account",
    moved === 0 && stillMine.consignorId === mine.customerId,
    moved === 0 ? "" : `LEAK — ${moved} consignment(s) changed hands`,
  );

  const nothing = await stampBulkConsignor({ customerId: "", shipmentIds: [unowned.shipmentId] });
  check("and an empty account stamps nothing at all", nothing === 0, `${nothing}`);
}

/**
 * A batch outside a desk's branches, on the ops side.
 *
 * The screen has always checked `coversBranch` before rendering. The
 * assertion here is the screen's; the actions behind it now run the same
 * check on the posted `batchId`, which is what stops a clerk correcting,
 * re-checking, booking from or abandoning another branch's batch without a
 * screen at all.
 */
async function checkOpsBatchScope(ownBatchId: string, farBatchId: string) {
  section("Ops bulk — a batch outside your branches is not yours to open");

  const clerk = await signInStaff(HOST, BRANCH_CLERK_MOBILE, STAFF_PASSWORD);
  check(
    `the branch desk ${BRANCH_CLERK_MOBILE} signs in`,
    clerk.ok,
    clerk.ok ? "" : "check scripts/seed-branch-logins.ts has been run",
  );
  if (!clerk.ok) return;

  // The path matters as much as the status: `/forbidden` answers 200, so a
  // desk that simply lacks `shipment.bulk_upload` would pass a bare status
  // check on both batches and prove nothing about scope.
  const ownPath = `/shipments/bulk/${ownBatchId}`;
  const own = await hostFollow(HOST, PORT, ownPath, clerk.jar);
  check(
    "the desk can open a batch at its own branch",
    own.status === 200 && own.finalPath === ownPath,
    `HTTP ${own.status}${own.finalPath !== ownPath ? ` · landed on ${own.finalPath}` : ""}`,
  );

  const far = await hostFollow(HOST, PORT, `/shipments/bulk/${farBatchId}`, clerk.jar);
  check(
    "and cannot open one at a branch it does not cover",
    far.status === 404,
    far.status === 200
      ? `LEAK — another branch's batch rendered at ${far.finalPath}`
      : `HTTP ${far.status}`,
  );

  const admin = await signInStaff(HOST, ADMIN_MOBILE, STAFF_PASSWORD);
  if (admin.ok) {
    const asAdmin = await hostFollow(HOST, PORT, `/shipments/bulk/${farBatchId}`, admin.jar);
    check(
      "while the network desk can — so the 404 was scope, not a missing batch",
      asAdmin.status === 200,
      `HTTP ${asAdmin.status}`,
    );
  }
}

// ────────────────────────────────────────────────────────────
// Run
// ────────────────────────────────────────────────────────────

async function main() {
  const org = await basePrisma.organization.findFirst({
    where: { OR: [{ subdomain: TENANT }, { slug: TENANT }] },
    select: { id: true, name: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const dark = await basePrisma.organization.findFirst({
    where: { OR: [{ subdomain: DARK }, { slug: DARK }] },
    select: { id: true, name: true },
  });

  if (!org) {
    console.error(`\nNo organisation with subdomain or slug "${TENANT}".\n`);
    process.exit(1);
  }

  console.log(
    `\nCustomer portal and bulk intake — ${org.name} on http://${HOST}:${PORT}\n`,
  );

  const tenant = tenantContextFor(org, "job");
  if (!tenant) {
    console.error(`\nOrganisation "${TENANT}" is closed; refusing to run against it.\n`);
    process.exit(1);
  }

  // ── 1. The plan gate ────────────────────────────────────
  if (dark) {
    await checkPlanGate(dark.id);
  } else {
    console.log(
      `\n  [SKIP] plan gating — no carrier "${DARK}" to ask. Pass --dark <subdomain>\n` +
        "         naming one whose plan does not include the portal.",
    );
  }
  await checkPlanGatePositiveControl();

  // ── The two customers everything else is done as ────────
  const pair = await runWithTenant(tenant, findTwoOwners);
  if (!pair) {
    console.error(
      "\n  This carrier has fewer than two customers with portal owners, so\n" +
        "  nothing below can distinguish a scoped read from an empty one.\n" +
        "  Seed the demo data first: npm run db:seed:demo\n",
    );
    process.exit(1);
  }
  const [mine, theirs] = pair;

  const session = await signInCustomer(HOST, mine.email, PORTAL_PASSWORD);
  section(`Signed in — ${mine.customerName} (${mine.email})`);
  check("the portal login signs in", session.ok, session.ok ? "" : "wrong password?");
  if (!session.ok) {
    console.error(
      `\n  Sign-in failed. The demo password is "${PORTAL_PASSWORD}"; override it\n` +
        "  with PORTAL_DEMO_PASSWORD if this carrier was seeded differently.\n",
    );
    process.exit(1);
  }

  const staff = await signInStaff(HOST, ADMIN_MOBILE, STAFF_PASSWORD);
  check("the network desk signs in", staff.ok);

  // ── 2, 3. Over HTTP, as those two people ────────────────
  await checkCrossPopulation(session.jar, staff.jar);
  await checkShipmentFilters(session.jar);

  // ── 4, 5. The service layer, inside the tenant ──────────
  await runWithTenant(tenant, async () => {
    await checkServiceActor(mine);
    await checkPickupCancellation(mine, theirs);
    await checkShipmentIsTold(mine);
    await checkStamp(mine, theirs);
  });

  const staged = await runWithTenant(tenant, async () => {
    const batch = await checkBulkOwnership(mine, theirs);
    if (!batch) return null;

    // A batch at a branch the customer's own desk does not cover, so the
    // ops-side scope check has something real to refuse.
    const admin = await loadAdminActor();
    const far = await prisma.branch.findFirst({
      where: { isActive: true, deletedAt: null, id: { not: batch.branchId } },
      orderBy: { code: "desc" },
      select: { id: true },
    });
    if (!far) return null;

    const other = await createBulkBatch(
      {
        fileName: "verify-portal-other-branch.csv",
        contentType: "text/csv",
        bytes: Buffer.from(buildTemplateCsv(), "utf8"),
        branchId: far.id,
      },
      admin,
    );
    return other.ok ? { own: batch.batchId, far: other.batchId } : null;
  });

  if (staged) {
    await checkOpsBatchScope(staged.own, staged.far);
  } else {
    console.log("\n  [SKIP] ops batch scope — the fixture batches could not be staged");
  }

  console.log(
    `\n${failures === 0 ? "All good" : "Problems"} — ${passes} passed, ${failures} failed\n`,
  );

  await disconnectDb();
  if (failures > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await disconnectDb();
  process.exit(1);
});
