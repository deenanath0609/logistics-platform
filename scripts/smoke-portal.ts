/**
 * Drives the customer portal as a real signed-in customer.
 *
 *   npx tsx scripts/smoke-portal.ts [tenant-subdomain] [--base http://localhost:3010]
 *
 * The portal had no coverage of any kind before this: not a unit test that
 * rendered a page, not a script that signed in. That matters more here than
 * elsewhere, because the portal's entire security story is one projection —
 * `customerShipmentFilter` and `customerOwnedFilter` in
 * `src/lib/portal/visibility.ts` — and a projection is exactly the kind of
 * thing that keeps working in unit tests while a page quietly queries around
 * it.
 *
 * So this does two jobs, in this order:
 *
 *   · every portal screen is asked for and must render, and
 *   · a second customer, under the same carrier, is signed in and asked for
 *     the first customer's records by id. Every one of those must come back
 *     404 — not 403, which would confirm the record exists.
 *
 * The portal's own booking form is exercised as far as rendering only: a
 * smoke test that books on every run leaves the demo tenant dirtier every
 * day, and `verify-spine.ts` already proves booking works.
 *
 * The one thing it does write is a consignment for each of the two
 * customers, and only when they have none. Without one on each side the
 * isolation checks have nothing to ask for, and a script that reports PASS
 * because both customers can see nothing is worse than no script at all.
 * The seeded demo consignments carry no consignor, so on a fresh database
 * that is every run of the first one.
 *
 * Transport is `node:http` by way of `host-fetch.ts` rather than `fetch`,
 * for the reason documented there: the portal is served on a carrier's own
 * subdomain, `*.localhost` is not real DNS, and undici drops a forged `host`
 * header without a word.
 */
import "dotenv/config";
import { prisma, basePrisma } from "../src/lib/prisma";
import { disconnectDb } from "../src/lib/prisma-base";
import { runWithTenant, tenantContextFor } from "../src/lib/tenant";
import { createBooking } from "../src/lib/shipment/booking";
import type { SessionUser } from "../src/lib/auth/session";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const SUBDOMAIN = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--base")
  ?? "city-logistics";
const BASE = flag("base") ?? process.env.APP_URL ?? "http://localhost:3010";
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
const HOST = `${SUBDOMAIN}.${ROOT}`;

let failures = 0;
let passes = 0;
let screens = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

const get = (path: string, jar: CookieJar) => hostFollow(HOST, PORT, path, jar);

/** `<title>`, which the root layout renders as `{page} · {carrier}`. */
const titleOf = (body: string) => (body.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? "";

/**
 * Sign in through the Auth.js credentials callback rather than the login
 * form.
 *
 * The form is a `useActionState` server action, which a script cannot post
 * to without reconstructing Next's action protocol. The callback underneath
 * it is ordinary HTTP and is the same code path the action calls, so this
 * exercises `authenticateCustomer` and the real session cookie while
 * skipping only the React plumbing.
 */
async function signInAsCustomer(email: string, password: string) {
  const jar = new CookieJar();

  const csrf = await hostFetch(HOST, PORT, "/api/auth/csrf", { cookie: jar.header() });
  jar.absorb(csrf);
  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };

  const response = await hostFetch(HOST, PORT, "/api/auth/callback/customer", {
    method: "POST",
    cookie: jar.header(),
    body: new URLSearchParams({
      email,
      password,
      csrfToken,
      callbackUrl: `http://${HOST}:${PORT}/portal`,
    }).toString(),
  });
  jar.absorb(response);

  const location = response.location ?? "";
  return { jar, ok: !location.includes("error"), location };
}

/** Ask for one screen and insist the page itself, not an error, came back. */
async function screen(path: string, expectTitle: string, expectText: string, jar: CookieJar) {
  const response = await get(path, jar);
  const title = titleOf(response.body);
  const rendered = response.status === 200 && title.startsWith(expectTitle);
  const carried = rendered && response.body.includes(expectText);

  if (carried) screens += 1;
  check(
    path,
    carried,
    carried
      ? ""
      : rendered
        ? `rendered but "${expectText}" is missing`
        : `HTTP ${response.status}${title ? ` · title "${title}"` : ""}${
            response.finalPath !== path ? ` · landed on ${response.finalPath}` : ""
          }`,
  );
  return response;
}

/** The first link on a page matching a prefix, so ids come from the UI. */
function firstLink(body: string, prefix: string): string | null {
  const pattern = new RegExp(`href=\\\\?"(${prefix.replace(/\//g, "\\/")}\\/[a-z0-9]{20,})`, "i");
  return (body.match(pattern) ?? [])[1] ?? null;
}

/**
 * A record belonging to somebody else must be indistinguishable from one
 * that does not exist. 404 is the pass; 200 is a leak and 403 is a smaller
 * leak — it confirms the id is real.
 */
async function mustNotSee(label: string, path: string, jar: CookieJar) {
  const response = await get(path, jar);
  const ok = response.status === 404;
  check(
    label,
    ok,
    ok
      ? "404"
      : response.status === 200
        ? "LEAK — the page rendered another customer's record"
        : `HTTP ${response.status} — expected 404 so the id's existence is not confirmed`,
  );
}

type PortalLogin = { email: string; customerId: string; customerName: string };

/**
 * Two portal logins under this carrier belonging to different customers.
 *
 * Read from the database rather than hard-coded, so the script survives a
 * reseed. It goes through the tenant-scoped client rather than `basePrisma`
 * because row-level security hides `customer_user` from an unscoped
 * connection — `basePrisma` returns an empty array rather than an error,
 * which reads exactly like an unseeded tenant.
 *
 * Picking the fixtures is setup; everything under test goes over HTTP.
 */
async function findTwoCustomers(): Promise<[PortalLogin, PortalLogin] | null> {
  const users = await prisma.customerUser.findMany({
    where: { deletedAt: null, isActive: true, role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: {
      email: true,
      customerId: true,
      customer: { select: { name: true } },
    },
  });

  const seen = new Set<string>();
  const distinct: PortalLogin[] = [];
  for (const user of users) {
    if (seen.has(user.customerId)) continue;
    seen.add(user.customerId);
    distinct.push({
      email: user.email,
      customerId: user.customerId,
      customerName: user.customer.name,
    });
  }

  return distinct.length >= 2 ? [distinct[0], distinct[1]] : null;
}

/**
 * Make sure this customer has at least one consignment to its name.
 *
 * The portal lists shipments by `consignorId`, and the demo seed books
 * without one, so on a fresh database no customer can see anything at all.
 * That state makes every isolation check pass for the wrong reason.
 *
 * Booked through `createBooking` with the admin as actor, exactly as the
 * counter staff would when a known customer walks in. Left behind, like
 * `verify-spine.ts` leaves its own.
 */
async function ensureConsignment(login: PortalLogin): Promise<boolean> {
  const existing = await prisma.shipment.count({
    where: { consignorId: login.customerId, deletedAt: null },
  });
  if (existing > 0) return false;

  const admin = await loadAdminActor();
  const [service, packageType] = await Promise.all([
    prisma.serviceType.findFirstOrThrow({
      where: { isActive: true, mode: "PTL" },
      orderBy: { code: "asc" },
    }),
    prisma.packageType.findFirstOrThrow({}),
  ]);
  const [origin, destination] = await prisma.branch.findMany({
    where: { isActive: true },
    orderBy: { code: "asc" },
    take: 2,
    select: { id: true },
  });
  const [originCity, destinationCity] = await Promise.all([
    prisma.city.findFirstOrThrow({ orderBy: { code: "asc" } }),
    prisma.city.findFirstOrThrow({ orderBy: { code: "desc" } }),
  ]);

  const result = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: service.id,
      bookingBranchId: origin.id,
      originBranchId: origin.id,
      destinationBranchId: (destination ?? origin).id,

      consignorId: login.customerId,
      consignorName: login.customerName,
      consignorPhone: "9811100021",
      consignorAddress: "Portal smoke test origin",
      consignorCityId: originCity.id,
      consignorPincode: "122015",

      consigneeName: "Portal Smoke Consignee",
      consigneePhone: "9811100022",
      consigneeAddress: "Portal smoke test destination",
      consigneeCityId: destinationCity.id,
      consigneePincode: "302013",

      packageCount: 1,
      packageTypeId: packageType.id,
      actualWeight: 3,
      goodsDescription: `Portal smoke test for ${login.customerName}`,
      paymentType: "PAID",
      pickupRequired: false,
    },
    admin,
  );

  if (!result.ok) {
    throw new Error(`Could not book a consignment for ${login.customerName}: ${result.error}`);
  }
  return true;
}

/** The admin session the fixture booking is made under. */
async function loadAdminActor(): Promise<SessionUser> {
  const user = await prisma.user.findFirstOrThrow({
    where: { mobile: process.env.SMOKE_ADMIN_MOBILE ?? "9999999999" },
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
    roles: user.roles.map((r) => ({ code: r.role.code, name: r.role.name, scope: r.role.scope })),
    permissions,
    scope: "NETWORK",
    branchIds: null,
  };
}

async function main() {
  const org = await basePrisma.organization.findFirst({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: {
      id: true,
      name: true,
      slug: true,
      subdomain: true,
      customDomain: true,
      status: true,
    },
  });

  if (!org) {
    console.error(`\nNo organisation with subdomain or slug "${SUBDOMAIN}".\n`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nCustomer portal — acting as a customer of ${org.name} ` +
      `(${org.slug}) on http://${HOST}:${PORT}\n`,
  );

  const tenant = tenantContextFor(org, "job");
  if (!tenant) {
    console.error(`\nOrganisation "${SUBDOMAIN}" is closed; refusing to run against it.\n`);
    process.exitCode = 1;
    return;
  }

  const pair = await runWithTenant(tenant, findTwoCustomers);
  if (!pair) {
    console.error(
      "  This tenant has fewer than two customers with portal owners, so the\n" +
        "  isolation half of this script cannot run. Seed the demo data first:\n" +
        "    npm run db:seed:demo\n",
    );
    process.exitCode = 1;
    return;
  }

  const [mine, theirs] = pair;
  const password = process.env.PORTAL_DEMO_PASSWORD ?? "Portal@123";

  // Both sides need something of their own before "you cannot see theirs"
  // means anything.
  const booked = await runWithTenant(tenant, async () => {
    const first = await ensureConsignment(mine);
    const second = await ensureConsignment(theirs);
    return [first, second].filter(Boolean).length;
  });
  if (booked > 0) {
    console.log(
      `  booked ${booked} fixture consignment(s) so both accounts have ` +
        "something to see, and something to be refused\n",
    );
  }

  // ── Anonymous ───────────────────────────────────────────────
  console.log("Anonymous");
  {
    const jar = new CookieJar();

    const login = await hostFetch(HOST, PORT, "/portal/login");
    check(
      "the login page renders",
      login.status === 200 && login.body.includes("Customer sign in"),
      `HTTP ${login.status}`,
    );

    const guarded = await hostFetch(HOST, PORT, "/portal/shipments", { cookie: jar.header() });
    const bounced =
      guarded.status >= 300 &&
      guarded.status < 400 &&
      (guarded.location ?? "").includes("/portal/login");
    check(
      "an anonymous visitor is sent to the portal login",
      bounced,
      `HTTP ${guarded.status} ${guarded.location ?? ""}`,
    );

    // The portal is a tenant surface. On the bare platform domain — the
    // operator console — it must not exist at all.
    const console404 = await hostFetch(ROOT, PORT, "/portal/login");
    check(
      "the portal does not exist on the platform domain",
      console404.status === 404,
      `HTTP ${console404.status}`,
    );
  }

  // ── Signed in ───────────────────────────────────────────────
  console.log(`\n${mine.customerName} (${mine.email})`);
  const session = await signInAsCustomer(mine.email, password);
  check("password sign-in succeeds", session.ok, session.location || "no redirect");

  if (!session.ok) {
    console.error(
      `\n  Sign-in failed. The demo password is "${password}"; override it with\n` +
        "  PORTAL_DEMO_PASSWORD if this tenant was seeded differently.\n",
    );
    process.exitCode = 1;
    return;
  }

  const jar = session.jar;

  console.log("\nPortal screens");
  await screen("/portal", "Overview", "Latest shipments", jar);
  const list = await screen("/portal/shipments", "Shipments", "Every consignment booked under", jar);
  await screen("/portal/pickups", "Pickups", "Ask us to collect", jar);
  await screen("/portal/addresses", "Saved addresses", "Your collection and delivery points", jar);
  await screen("/portal/invoices", "Invoices", "Billing for", jar);
  await screen("/portal/complaints", "Complaints", "and where each one stands", jar);
  await screen("/portal/complaints/new", "Raise a complaint", "It goes straight to the branch", jar);
  await screen("/portal/book", "Book a shipment", "The collection address is one of your own", jar);
  await screen("/portal/bulk", "Bulk upload", "still books the other hundred", jar);
  await screen("/portal/users", "People", "Everyone here sees this account's shipments", jar);

  // ── The customer's own records ──────────────────────────────
  console.log("\nOwn records");

  const shipmentLink = firstLink(list.body, "/portal/shipments");
  let shipmentPath: string | null = null;
  let podPath: string | null = null;

  if (!shipmentLink) {
    check(
      "the shipment list shows at least one consignment",
      false,
      `${mine.customerName} has no shipments, so the detail and POD screens ` +
        "cannot be driven. Run scripts/verify-spine.ts, or seed demo data.",
    );
  } else {
    shipmentPath = shipmentLink;
    check("the shipment list shows at least one consignment", true, shipmentLink);

    await screen(shipmentLink, "Shipment", "Chargeable weight", jar);

    // The POD screen exists only once a consignment has been delivered, so
    // its absence is reported rather than counted either way.
    podPath = `${shipmentLink}/pod`;
    const pod = await get(podPath, jar);
    if (pod.status === 200) {
      screens += 1;
      check(podPath, pod.body.includes("Delivered to"), "");
    } else {
      console.log(
        `  [SKIP] ${podPath} — HTTP ${pod.status}; this consignment has no POD yet`,
      );
    }
  }

  const complaints = await get("/portal/complaints", jar);
  const complaintLink = firstLink(complaints.body, "/portal/complaints");
  if (complaintLink && !complaintLink.endsWith("/new")) {
    await screen(complaintLink, "Complaint", "All complaints", jar);
  } else {
    console.log("  [SKIP] /portal/complaints/[id] — nothing raised on this account");
  }

  const batches = await get("/portal/bulk", jar);
  const batchLink = firstLink(batches.body, "/portal/bulk");
  if (batchLink) {
    await screen(batchLink, "Bulk batch", "All files", jar);
  } else {
    console.log("  [SKIP] /portal/bulk/[batchId] — nothing uploaded on this account");
  }

  // The invoice document is a route handler, not a page: it either streams
  // the PDF or refuses. Both are worth knowing.
  const invoices = await get("/portal/invoices", jar);
  const invoiceLink = firstLink(invoices.body, "/portal/invoices");
  if (invoiceLink) {
    const document = await get(`${invoiceLink}`, jar);
    check(
      "the invoice document is served or cleanly refused",
      document.status === 200 || document.status === 404,
      `HTTP ${document.status}`,
    );
  } else {
    console.log("  [SKIP] /portal/invoices/[id]/document — no invoice on this account");
  }

  // ── The isolation half ──────────────────────────────────────
  console.log(`\nA second customer — ${theirs.customerName} (${theirs.email})`);
  const other = await signInAsCustomer(theirs.email, password);
  check("the second customer signs in", other.ok, other.location || "no redirect");

  if (other.ok) {
    const otherJar = other.jar;

    const otherList = await get("/portal/shipments", otherJar);
    check(
      "their shipment list renders",
      otherList.status === 200,
      `HTTP ${otherList.status}`,
    );
    check(
      "their list is headed with their own account, not the first customer's",
      otherList.body.includes(theirs.customerName) &&
        !otherList.body.includes(mine.customerName),
      otherList.body.includes(mine.customerName)
        ? `LEAK — "${mine.customerName}" appears on ${theirs.customerName}'s list`
        : "",
    );

    // Every id-addressed portal route, asked for with somebody else's id.
    if (shipmentPath) {
      await mustNotSee(
        "cannot open the other customer's shipment",
        shipmentPath,
        otherJar,
      );
      await mustNotSee(
        "cannot open the other customer's POD",
        `${shipmentPath}/pod`,
        otherJar,
      );
    }
    if (complaintLink && !complaintLink.endsWith("/new")) {
      await mustNotSee(
        "cannot open the other customer's complaint",
        complaintLink,
        otherJar,
      );
    }
    if (batchLink) {
      await mustNotSee(
        "cannot open the other customer's bulk batch",
        batchLink,
        otherJar,
      );
    }
    if (invoiceLink) {
      const document = await get(invoiceLink, otherJar);
      check(
        "cannot download the other customer's invoice",
        document.status === 404 || document.status === 403,
        `HTTP ${document.status}`,
      );
    }

    // Cross-check the other way, so a pass cannot come from the second
    // customer simply seeing nothing at all.
    const theirOwn = await get("/portal/shipments", otherJar);
    const theirLink = firstLink(theirOwn.body, "/portal/shipments");
    if (theirLink) {
      const own = await get(theirLink, otherJar);
      check(
        "but can open their own shipment",
        own.status === 200,
        `HTTP ${own.status}`,
      );
    } else {
      console.log(
        `  [SKIP] ${theirs.customerName} has no shipments, so the positive ` +
          "control on the isolation checks could not run",
      );
    }
  }

  // ── A staff cookie is not a portal cookie ───────────────────
  console.log("\nCross-surface");
  {
    const staff = new CookieJar();
    const csrf = await hostFetch(HOST, PORT, "/api/auth/csrf", { cookie: staff.header() });
    staff.absorb(csrf);
    const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };

    const signedIn = await hostFetch(HOST, PORT, "/api/auth/callback/password", {
      method: "POST",
      cookie: staff.header(),
      body: new URLSearchParams({
        mobile: process.env.SMOKE_ADMIN_MOBILE ?? "9999999999",
        password: process.env.SMOKE_ADMIN_PASSWORD ?? "Admin@123",
        csrfToken,
        callbackUrl: `http://${HOST}:${PORT}/dashboard`,
      }).toString(),
    });
    staff.absorb(signedIn);

    // The subject prefix is what separates the two surfaces; a staff token
    // presented at the portal has to read as signed out.
    const atPortal = await hostFetch(HOST, PORT, "/portal/shipments", {
      cookie: staff.header(),
    });
    const refused =
      atPortal.status >= 300 &&
      atPortal.status < 400 &&
      (atPortal.location ?? "").includes("/portal/login");
    check(
      "a staff session does not open the customer portal",
      refused,
      `HTTP ${atPortal.status} ${atPortal.location ?? ""}`,
    );

    // And the reverse.
    const atOps = await hostFetch(HOST, PORT, "/shipments", { cookie: jar.header() });
    const bounced =
      atOps.status >= 300 &&
      atOps.status < 400 &&
      (atOps.location ?? "").includes("/login");
    check(
      "a customer session does not open the ops app",
      bounced,
      `HTTP ${atOps.status} ${atOps.location ?? ""}`,
    );
  }

  console.log(`\n${screens} portal screen(s) rendered · ${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "PASS\n" : "FAIL\n");
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`\nSmoke test crashed: ${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
