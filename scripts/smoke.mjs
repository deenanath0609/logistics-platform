/**
 * Phase 1 smoke test — drives the running app over HTTP.
 *
 *   node scripts/smoke.mjs [baseUrl]
 *
 * Checks the Phase 1 acceptance criteria that matter:
 *   · anonymous visitors are sent to the login page
 *   · password sign-in works and lands on the dashboard
 *   · master data renders from the database
 *   · a role without a permission is refused the page, not just the menu link
 */
const BASE = process.argv[2] ?? "http://localhost:3010";

let failures = 0;

function check(label, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Minimal cookie jar: one signed-in identity per instance. */
function jar() {
  const cookies = new Map();
  return {
    header: () =>
      [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb(response) {
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const index = pair.indexOf("=");
        if (index > 0) {
          cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
        }
      }
    },
  };
}

async function get(path, cookieJar, redirect = "manual") {
  const response = await fetch(`${BASE}${path}`, {
    redirect,
    headers: cookieJar ? { cookie: cookieJar.header() } : {},
  });
  cookieJar?.absorb(response);
  return response;
}

async function signIn(mobile, password) {
  const cookieJar = jar();

  const csrfResponse = await get("/api/auth/csrf", cookieJar);
  const { csrfToken } = await csrfResponse.json();

  const body = new URLSearchParams({
    mobile,
    password,
    csrfToken,
    callbackUrl: `${BASE}/dashboard`,
  });

  const response = await fetch(`${BASE}/api/auth/callback/password`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieJar.header(),
    },
    body,
  });
  cookieJar.absorb(response);

  const location = response.headers.get("location") ?? "";
  return { cookieJar, ok: !location.includes("error"), location };
}

console.log(`\nPhase 1 smoke test against ${BASE}\n`);

// ── Anonymous access ────────────────────────────────────────
console.log("Anonymous");
{
  const health = await get("/api/health");
  const body = await health.json();
  check("health endpoint responds", health.status === 200, `status ${body.status}`);
  check("database reachable", body.checks.database.ok === true);

  const login = await get("/login");
  check("login page renders", login.status === 200);

  const dashboard = await get("/dashboard");
  const redirected =
    dashboard.status >= 300 &&
    dashboard.status < 400 &&
    (dashboard.headers.get("location") ?? "").includes("/login");
  check("dashboard redirects anonymous visitors to login", redirected);
}

// ── Super Admin ─────────────────────────────────────────────
console.log("\nSuper Admin (9999999999)");
const admin = await signIn("9999999999", "Admin@123");
check("password sign-in succeeds", admin.ok, admin.location || "no redirect");

if (admin.ok) {
  const dashboard = await get("/dashboard", admin.cookieJar, "follow");
  const html = await dashboard.text();
  check("dashboard renders", dashboard.status === 200);
  check("shows network overview", html.includes("Network overview"));
  check("shows seeded branch count", /Branches\s*&amp;\s*hubs/.test(html));

  const services = await get("/masters/service-types", admin.cookieJar, "follow");
  const servicesHtml = await services.text();
  check("service types page renders", services.status === 200);
  check("shows seeded service type", servicesHtml.includes("PTL-EXP"));
  check("can create (has master.manage)", servicesHtml.includes("New service type"));

  const reasons = await get("/masters/reason-codes", admin.cookieJar, "follow");
  const reasonsHtml = await reasons.text();
  check("reason codes render", reasonsHtml.includes("DF-UNAVAILABLE"));

  const series = await get("/masters/number-series", admin.cookieJar, "follow");
  const seriesHtml = await series.text();
  // Not pinned to 0001: the counter advances as bookings are made, so
  // asserting a fixed sequence would fail the moment the system is used.
  const preview = seriesHtml.match(/CL(\d{8})(\d{4})/);
  const today = new Date();
  const expectedDate =
    `${today.getFullYear()}` +
    `${String(today.getMonth() + 1).padStart(2, "0")}` +
    `${String(today.getDate()).padStart(2, "0")}`;

  check(
    "number series previews the next LR number",
    Boolean(preview) && preview[1] === expectedDate && Number(preview[2]) >= 1,
    preview?.[0] ?? "no preview rendered",
  );

  const users = await get("/admin/users", admin.cookieJar, "follow");
  const usersHtml = await users.text();
  check("users page renders", users.status === 200);
  check("lists seeded staff", usersHtml.includes("9999900003"));

  const roles = await get("/admin/roles", admin.cookieJar, "follow");
  const rolesHtml = await roles.text();
  check("roles page lists system roles", rolesHtml.includes("Branch Manager"));

  const audit = await get("/admin/audit", admin.cookieJar, "follow");
  check("audit page renders", audit.status === 200);
}

// ── Phase 2–4 modules ───────────────────────────────────────
if (admin.ok) {
  console.log("\nOperational modules");

  const pages = [
    ["/shipments", "Shipments"],
    ["/shipments/new", "New booking"],
    ["/customers", "Customers"],
    ["/pickups", "Pickups"],
    ["/hub", null],
    ["/hub/scan", null],
    ["/hub/inbound", null],
    ["/dispatch/manifests", null],
    ["/dispatch/trips", null],
    ["/delivery/runs", null],
    ["/delivery/cod", null],
    ["/fleet/vehicles", null],
    ["/fleet/drivers", null],
    ["/fleet/vehicle-types", null],
    ["/fleet/expiries", null],
  ];

  for (const [path, expectText] of pages) {
    const response = await get(path, admin.cookieJar, "follow");
    const html = await response.text();
    const ok =
      response.status === 200 &&
      (expectText === null || html.includes(expectText));
    check(`${path} renders`, ok, `status ${response.status}`);
  }

  // The seeded shipments from verify-spine give the detail pages something
  // real to render rather than an empty state.
  const list = await get("/shipments", admin.cookieJar, "follow");
  const listHtml = await list.text();
  const lrMatch = listHtml.match(/CL\d{12}/);
  check("shipment list shows a booked consignment", Boolean(lrMatch), lrMatch?.[0]);

  const idMatch = listHtml.match(/\/shipments\/([a-z0-9]{20,})/);
  if (idMatch) {
    const detail = await get(`/shipments/${idMatch[1]}`, admin.cookieJar, "follow");
    const detailHtml = await detail.text();
    check("shipment detail renders", detail.status === 200);
    check(
      "chain of custody timeline is present",
      detailHtml.includes("Chain of custody"),
    );
    check(
      "timeline shows real events",
      detailHtml.includes("Booking created") || detailHtml.includes("Delivered"),
    );

    const print = await get(
      `/shipments/${idMatch[1]}/print`,
      admin.cookieJar,
      "follow",
    );
    const printHtml = await print.text();
    check("consignment note renders", print.status === 200);
    check("label carries the package barcode", /CL\d{12}-01/.test(printHtml));
  }
}

// ── Booking Executive: narrower role ────────────────────────
console.log("\nBooking Executive (9999900003)");
const clerk = await signIn("9999900003", "Admin@123");
check("password sign-in succeeds", clerk.ok, clerk.location || "no redirect");

if (clerk.ok) {
  const dashboard = await get("/dashboard", clerk.cookieJar, "follow");
  check("dashboard renders", dashboard.status === 200);

  const services = await get("/masters/service-types", clerk.cookieJar, "follow");
  const servicesHtml = await services.text();
  check("can read masters", services.status === 200 && servicesHtml.includes("PTL-EXP"));
  check(
    "cannot create masters (no master.manage)",
    !servicesHtml.includes("New service type"),
  );

  const users = await get("/admin/users", clerk.cookieJar, "manual");
  const location = users.headers.get("location") ?? "";
  const blocked =
    (users.status >= 300 && users.status < 400 && location.includes("/forbidden")) ||
    users.status === 403;
  check("blocked from users page (no user.read)", blocked, `status ${users.status} ${location}`);

  const nav = await get("/dashboard", clerk.cookieJar, "follow");
  const navHtml = await nav.text();
  check("navigation hides Administration group", !navHtml.includes("Audit trail"));
  check("navigation hides the dock console", !navHtml.includes("Scan console"));
  check("navigation hides Fleet", !navHtml.includes("Document expiries"));

  // A booking clerk has no business on the dock or in the fleet office.
  for (const path of ["/hub/scan", "/fleet/vehicles", "/dispatch/manifests"]) {
    const response = await get(path, clerk.cookieJar, "manual");
    const location = response.headers.get("location") ?? "";
    const blocked =
      (response.status >= 300 &&
        response.status < 400 &&
        location.includes("/forbidden")) ||
      response.status === 403;
    check(`blocked from ${path}`, blocked, `status ${response.status}`);
  }

  const canBook = await get("/shipments/new", clerk.cookieJar, "follow");
  check("but can still reach the booking screen", canBook.status === 200);
}

// ── Bad credentials ─────────────────────────────────────────
console.log("\nRejected sign-in");
{
  const bad = await signIn("9999999999", "wrong-password");
  check("wrong password is refused", !bad.ok, bad.location);
}

console.log(
  failures === 0
    ? "\nAll checks passed.\n"
    : `\n${failures} check(s) failed.\n`,
);

process.exit(failures === 0 ? 0 : 1);
