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
import http from "node:http";

/**
 * A carrier's own host, not the bare domain.
 *
 * The bare platform domain is the operator console and serves no carrier at
 * all, so this script has to name a tenant — which brings two traps with it,
 * both of which fail quietly:
 *
 *   · `fetch` cannot reach `city-logistics.localhost`. Resolving `*.localhost`
 *     to the loopback is a browser convention, not a DNS one.
 *   · `fetch(url, { headers: { host } })` looks like the fix and is worse:
 *     `host` is a forbidden header in undici, dropped silently, so the request
 *     goes wherever the URL pointed while the test believes otherwise.
 *
 * So the transport below is `node:http`: the connection goes to the loopback
 * and the `Host` header names the carrier, which is exactly what a browser
 * does and what the tenant resolver reads.
 */
const BASE = process.argv[2] ?? "http://city-logistics.localhost:3010";
const TARGET = new URL(BASE);
const PORT = Number(TARGET.port || 80);
const HOST_HEADER = `${TARGET.hostname}:${PORT}`;

/** A fetch-shaped response, so the checks below did not have to change. */
function shape(res, body) {
  return {
    status: res.statusCode ?? 0,
    headers: {
      get: (name) => res.headers[name.toLowerCase()] ?? null,
      // On `headers`, not on the response — that is where the cookie jar
      // looks, and putting it one level up meant it silently stored nothing.
      getSetCookie: () => res.headers["set-cookie"] ?? [],
    },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function once(path, { method = "GET", cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(String(body)) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path,
        method,
        headers: {
          host: HOST_HEADER,
          ...(cookie ? { cookie } : {}),
          ...(payload
            ? {
                "content-type": "application/x-www-form-urlencoded",
                "content-length": payload.length,
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(shape(res, Buffer.concat(chunks).toString("utf8"))));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

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
  let current = path;

  // `node:http` does not follow redirects, so "follow" is spelled out here —
  // carrying the jar through each hop, which is what makes a sign-in stick.
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await once(current, { cookie: cookieJar?.header() });
    cookieJar?.absorb(response);

    const location = response.headers.get("location");
    if (redirect !== "follow" || !location || response.status < 300 || response.status >= 400) {
      return response;
    }
    current = location.startsWith("http") ? new URL(location).pathname : location;
  }

  throw new Error(`Too many redirects from ${path}`);
}

async function signIn(mobile, password) {
  const cookieJar = jar();

  const csrfResponse = await get("/api/auth/csrf", cookieJar);
  const csrfBody = await csrfResponse.text();

  let csrfToken;
  try {
    ({ csrfToken } = JSON.parse(csrfBody));
  } catch {
    // Without a CSRF token there is no session, and without a session there
    // is nothing left to walk — so this one does stop the run, unlike the
    // health check above.
    console.error(
      `\nThe sign-in endpoint returned HTML, not JSON (HTTP ${csrfResponse.status}).\n` +
        "The dev server is failing to compile /api/auth; check its console.\n",
    );
    process.exit(1);
  }

  const body = new URLSearchParams({
    mobile,
    password,
    csrfToken,
    callbackUrl: `${BASE}/dashboard`,
  });

  const response = await once("/api/auth/callback/password", {
    method: "POST",
    cookie: cookieJar.header(),
    body: body.toString(),
  });
  cookieJar.absorb(response);

  const location = response.headers.get("location") ?? "";
  return { cookieJar, ok: !location.includes("error"), location };
}

console.log(
  `\nOps smoke test — acting as the carrier on ${HOST_HEADER}\n` +
    `  (the bare platform domain is the operator console; see smoke-platform.ts)\n`,
);

// A refused connection is not a failing check, it is a missing server, and
// the difference is worth one line rather than a stack trace.
try {
  await once("/api/health");
} catch (error) {
  if (error.code === "ECONNREFUSED") {
    console.error(
      `Nothing is listening on ${HOST_HEADER}. Start the app first:\n` +
        "  npm run dev:3010\n",
    );
    process.exit(1);
  }
  throw error;
}

// ── Anonymous access ────────────────────────────────────────
console.log("Anonymous");
{
  const health = await get("/api/health");
  const raw = await health.text();

  // A route that cannot compile answers with Next's HTML error page, and
  // parsing that as JSON throws four frames deep in a way that reads like a
  // bug in the test. It is reported as the failure it is and the walk goes
  // on: a broken `/api/health` is one screen's worth of news, and the sixty
  // screens after it are exactly what this script exists to check.
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Left null; the two checks below report it.
  }

  check(
    "health endpoint responds",
    health.status === 200 && body !== null,
    body === null
      ? `HTTP ${health.status} with an HTML body — this route is not compiling. ` +
        "The reason is in the dev server's console."
      : `status ${body.status}`,
  );
  check("database reachable", body?.checks?.database?.ok === true);

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

// ── Every ops screen ────────────────────────────────────────
/**
 * The whole operator surface, one row per route.
 *
 * The second column is the page's own `metadata.title`, which the root
 * layout renders as `<title>{title} · {carrier}</title>`. Asserting on it
 * rather than on body copy is deliberate: it is the one string every page
 * already declares, it changes only when someone renames the screen, and
 * it distinguishes "the page rendered" from "the framework rendered its
 * error boundary with a 200" — which body-text matching does not.
 *
 * Keep this list in step with `find src/app/(ops) -name page.tsx`. A screen
 * missing from here is a screen nobody drives.
 */
const OPS_SCREENS = [
  // Booking and the shipment record
  ["/dashboard", "Dashboard"],
  ["/shipments", "Shipments"],
  ["/shipments/new", "New booking"],
  ["/shipments/bulk", "Bulk booking"],
  ["/customers", "Customers"],
  ["/vendors", "Vendors"],
  ["/pickups", "Pickups"],

  // The dock
  ["/hub", "Branch floor"],
  ["/hub/scan", "Scan console"],
  ["/hub/inbound", "Inbound"],
  ["/hub/weigh", "Weighment"],

  // Line haul
  ["/dispatch/manifests", "Manifests"],
  ["/dispatch/trips", "Trips"],

  // Last mile
  ["/delivery/runs", "Delivery runs"],
  ["/delivery/cod", "COD day end"],

  // Service recovery
  ["/complaints", "Complaints"],
  ["/exceptions", "Exception tower"],

  // Money
  ["/finance", "Finance"],
  ["/finance/invoices", "Invoices"],
  ["/finance/rate-cards", "Rate cards"],
  ["/finance/receivables", "Receivables"],
  ["/finance/settlements", "Driver settlements"],
  ["/finance/profitability", "Profitability"],
  ["/finance/coverage-gaps", "Rate card coverage gaps"],

  // Fleet
  ["/fleet/vehicles", "Vehicles"],
  ["/fleet/drivers", "Drivers"],
  ["/fleet/vehicle-types", "Vehicle types"],
  ["/fleet/expiries", "Document expiries"],
  ["/fleet/field-staff", "Field staff"],

  // Visibility
  ["/tracking", "Live tracking"],
  ["/tracking/geofences", "Geofences"],
  ["/tracking/providers", "Tracking providers"],
  ["/insights", "Insights"],
  ["/reports", "Reports"],

  // Integrations
  ["/integrations", "Integrations"],
  ["/integrations/api-keys", "API keys"],
  ["/integrations/webhooks", "Webhooks"],

  // Notifications
  ["/notifications/templates", "Notification templates"],
  ["/notifications/log", "Notification log"],

  // Master data
  ["/masters/branches", "Branches &amp; hubs"],
  ["/masters/charge-types", "Charge heads"],
  ["/masters/cities", "Cities"],
  ["/masters/number-series", "Number series"],
  ["/masters/package-types", "Package types"],
  ["/masters/pincodes", "Pincodes"],
  ["/masters/pincodes/import", "Import pincodes"],
  ["/masters/reason-codes", "Reason codes"],
  ["/masters/routes", "Routes"],
  ["/masters/service-types", "Service types"],
  ["/masters/sla-policies", "SLA policies"],
  ["/masters/sla-policies/escalations", "Escalation rules"],
  ["/masters/tax-rates", "Tax rates"],
  ["/masters/zones", "Zones"],

  // Administration
  ["/admin/users", "Users"],
  ["/admin/roles", "Roles &amp; permissions"],
  ["/admin/audit", "Audit trail"],
];

/** Every report in the library, run for real against the database. */
const REPORT_KEYS = [
  "booking-register",
  "pickup-performance",
  "dispatch-manifest",
  "in-transit-status",
  "delivery-register",
  "pending-pod",
  "exception-register",
  "hub-dwell",
  "vehicle-utilisation",
  "document-expiry",
  "billing-register",
  "outstanding-ageing",
  "revenue-by-lane",
  "cod-register",
  "trip-expense-register",
  "vendor-payable",
  "customer-shipments",
  "customer-on-time",
  "complaint-register",
  "branch-scorecard",
  "driver-scorecard",
  "agent-scorecard",
];

let screensRendered = 0;
let skipped = 0;

/** `<title>` as the server rendered it, or "" when the page did not get that far. */
function titleOf(html) {
  return (html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? "";
}

/**
 * Ask for one screen and insist it rendered.
 *
 * A 200 alone is not enough — Next serves its error boundary with a 200 in
 * some configurations — so the page's own title has to come back with it.
 * A failure names the path, because the point of this sweep is that the
 * output tells you which of sixty screens broke without a bisect.
 */
async function screen(path, expectTitle, cookieJar) {
  const response = await get(path, cookieJar, "follow");
  const html = await response.text();
  const title = titleOf(html);
  // An empty expectation means "any title of its own" — used for the report
  // runners, whose titles come from the registry rather than from this list.
  const ok =
    response.status === 200 &&
    (expectTitle === "" ? title.length > 0 && !title.startsWith("Report ·") : title.startsWith(expectTitle));

  if (ok) screensRendered += 1;
  check(
    path,
    ok,
    ok ? "" : `HTTP ${response.status}${title ? ` · title "${title}"` : " · no title"}`,
  );
  return ok ? html : null;
}

/**
 * The first id-bearing link on a list page, or null when there is nothing
 * to click. Detail screens cannot be driven without a real record, and the
 * demo data does not cover every module, so "nothing to open" is reported
 * as a SKIP rather than counted as a pass — an empty module that silently
 * passed would be the exact hole this sweep exists to close.
 */
function firstDetailLink(html, prefix) {
  const pattern = new RegExp(
    `href=\\\\?"(${prefix.replace(/\//g, "\\/")}\\/[a-z0-9]{20,})`,
    "i",
  );
  return (html?.match(pattern) ?? [])[1] ?? null;
}

if (admin.ok) {
  console.log(`\nOps screens — ${OPS_SCREENS.length} routes`);
  for (const [path, expectTitle] of OPS_SCREENS) {
    await screen(path, expectTitle, admin.cookieJar);
  }

  // `/notifications` is a redirect stub, not a screen of its own.
  const notifications = await get("/notifications", admin.cookieJar, "follow");
  check(
    "/notifications lands on a real screen",
    notifications.status === 200,
    `HTTP ${notifications.status}`,
  );

  console.log(`\nReports — ${REPORT_KEYS.length} runners`);
  for (const key of REPORT_KEYS) {
    // Every report runs its own SQL. Rendering one is the only thing that
    // proves the query, the column mapping and the formatter agree.
    await screen(`/reports/${key}`, "", admin.cookieJar);
  }

  console.log("\nDetail screens");

  /**
   * Each entry: the list that supplies the id, the prefix its rows link to,
   * and the title the detail page must return.
   */
  const DETAIL_SCREENS = [
    ["/customers", "/customers", "Customer"],
    ["/vendors", "/vendors", "Vendor"],
    ["/fleet/vehicles", "/fleet/vehicles", "Vehicle"],
    ["/fleet/drivers", "/fleet/drivers", "Driver"],
    ["/admin/roles", "/admin/roles", "Role"],
    ["/dispatch/manifests", "/dispatch/manifests", "Manifest"],
    ["/dispatch/trips", "/dispatch/trips", "Trip"],
    ["/delivery/runs", "/delivery/runs", "Delivery run"],
    ["/complaints", "/complaints", "Complaint"],
    ["/exceptions", "/exceptions", "Exception"],
    ["/finance/invoices", "/finance/invoices", "Invoice"],
    ["/finance/rate-cards", "/finance/rate-cards", "Rate card"],
    ["/finance/receivables", "/finance/receivables", "Customer ledger"],
    ["/hub/inbound", "/hub/inbound", "Inbound receipt"],
    ["/integrations/webhooks", "/integrations/webhooks", "Webhook deliveries"],
    ["/shipments/bulk", "/shipments/bulk", "Bulk batch"],
  ];

  for (const [listPath, prefix, expectTitle] of DETAIL_SCREENS) {
    const listResponse = await get(listPath, admin.cookieJar, "follow");
    const link = firstDetailLink(await listResponse.text(), prefix);

    if (!link) {
      skipped += 1;
      console.log(`  [SKIP] ${prefix}/[id] — no record on ${listPath} to open`);
      continue;
    }

    await screen(link, expectTitle, admin.cookieJar);
  }

  // The customer ledger keys on a customer, not on a row of its own list,
  // so it is reached from the customer master instead.
  const customers = await get("/customers", admin.cookieJar, "follow");
  const customerLink = firstDetailLink(await customers.text(), "/customers");
  if (customerLink) {
    await screen(
      `/finance/receivables/${customerLink.split("/").pop()}`,
      "Customer ledger",
      admin.cookieJar,
    );
  }

  // Trip replay and the loading sheet hang off a trip.
  const trips = await get("/dispatch/trips", admin.cookieJar, "follow");
  const tripLink = firstDetailLink(await trips.text(), "/dispatch/trips");
  if (tripLink) {
    const tripId = tripLink.split("/").pop();
    await screen(`/dispatch/trips/${tripId}/loading`, "Loading sheet", admin.cookieJar);
    await screen(`/tracking/trips/${tripId}`, "Trip replay", admin.cookieJar);
  } else {
    skipped += 2;
    console.log("  [SKIP] /dispatch/trips/[id]/loading — no trip to open");
    console.log("  [SKIP] /tracking/trips/[id] — no trip to open");
  }

  // Proof of delivery keys on a delivered shipment, and nothing in the ops
  // navigation links to it — it is reached from a report row or a search.
  // The delivery register is the list of shipments that could have one;
  // `verify-field-cycle.ts` is what puts a POD on one of them.
  const delivered = await get("/reports/delivery-register", admin.cookieJar, "follow");
  const deliveredHtml = await delivered.text();
  const deliveredIds = [
    ...new Set(
      [...deliveredHtml.matchAll(/\/shipments\/([a-z0-9]{20,})/g)].map((m) => m[1]),
    ),
  ].slice(0, 5);

  let podRendered = false;
  for (const shipmentId of deliveredIds) {
    const pod = await get(`/delivery/pod/${shipmentId}`, admin.cookieJar, "follow");
    // A delivered consignment whose POD has not synced yet is a 404 here,
    // which is correct behaviour rather than a broken page — so the walk
    // continues rather than failing on the first one.
    if (pod.status !== 200) continue;

    const html = await pod.text();
    podRendered = true;
    screensRendered += 1;
    check(
      `/delivery/pod/${shipmentId}`,
      titleOf(html).startsWith("Proof of delivery"),
      titleOf(html),
    );
    break;
  }

  if (!podRendered) {
    skipped += 1;
    console.log(
      "  [SKIP] /delivery/pod/[shipmentId] — no delivered consignment carries a " +
        "POD; run scripts/verify-field-cycle.ts first",
    );
  }

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

  // The field-staff roster reads with `user.read`, which this clerk does not
  // hold — the same gate that keeps them out of the user list.
  const roster = await get("/fleet/field-staff", clerk.cookieJar, "manual");
  check(
    "blocked from the field-staff roster",
    roster.status === 307 || roster.status === 403,
    `status ${roster.status}`,
  );
}

// ── Bad credentials ─────────────────────────────────────────
console.log("\nRejected sign-in");
{
  const bad = await signIn("9999999999", "wrong-password");
  check("wrong password is refused", !bad.ok, bad.location);
}

console.log(
  `\n${screensRendered} screen(s) rendered` +
    (skipped > 0 ? `, ${skipped} skipped for want of data` : ""),
);
console.log(
  failures === 0
    ? "PASS — all checks passed.\n"
    : `FAIL — ${failures} check(s) failed.\n`,
);

process.exit(failures === 0 ? 0 : 1);
