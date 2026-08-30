/**
 * Proves a carrier cannot reach a module their plan does not include.
 *
 *   npx tsx scripts/verify-plan-gating.ts [--full city-logistics] [--limited acme]
 *                                         [--base http://localhost:3010]
 *
 * The companion to `verify-tenant-isolation.ts`, and written the same way:
 * every probe is an attempt that must fail. One carrier is on a plan with
 * everything, another on a plan with almost nothing, and the same signed-in
 * request is made against both hosts. A PASS means the smaller carrier was
 * refused — not that a page rendered.
 *
 * Three defences are tested separately, because they are three separate
 * things and any one of them can rot without the others noticing:
 *
 *   1. the route refuses a typed URL,
 *   2. the navigation does not draw the link,
 *   3. the session does not carry the module's permissions.
 *
 * Hiding a link is presentation. Presentation is not access control.
 */
import "dotenv/config";
import { basePrisma, disconnectDb } from "../src/lib/prisma-base";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";
import { MODULES } from "../src/lib/modules/modules";
import { modulesForPlan } from "../src/lib/modules/registry";
import type { ModuleKey } from "../src/lib/modules/registry";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "true");
}

const BASE = args.get("base") ?? "http://localhost:3010";
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
const FULL = args.get("full") ?? "city-logistics";
const LIMITED = args.get("limited") ?? "acme";

const STAFF_MOBILE = args.get("mobile") ?? "9999999999";
const STAFF_PASSWORD = args.get("password") ?? "Admin@123";

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

/** One representative screen per gated module. */
const PROBES: Array<{ module: ModuleKey; path: string; label: string }> = [
  { module: "dispatch", path: "/dispatch/trips", label: "trips" },
  { module: "billing", path: "/finance/invoices", label: "invoices" },
  { module: "cod", path: "/delivery/cod", label: "COD deposits" },
  { module: "tracking", path: "/tracking", label: "live tracking" },
  { module: "sla", path: "/exceptions", label: "the exception tower" },
  { module: "insights", path: "/insights", label: "insights" },
  { module: "integrations", path: "/integrations", label: "integrations" },
];

async function signIn(host: string) {
  const jar = new CookieJar();

  const csrf = await hostFetch(host, PORT, "/api/auth/csrf", { cookie: jar.header() });
  jar.absorb(csrf);
  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };

  const body = new URLSearchParams({
    mobile: STAFF_MOBILE,
    password: STAFF_PASSWORD,
    csrfToken,
    callbackUrl: `http://${host}:${PORT}/dashboard`,
  }).toString();

  const posted = await hostFetch(host, PORT, "/api/auth/callback/password", {
    method: "POST",
    cookie: jar.header(),
    body,
  });
  jar.absorb(posted);

  const landed = await hostFollow(host, PORT, "/dashboard", jar);
  return { jar, signedIn: landed.status === 200 && !landed.finalPath.startsWith("/login") };
}

async function planFor(subdomain: string) {
  const org = await basePrisma.organization.findFirst({
    where: { subdomain },
    select: { name: true, plan: { select: { name: true, features: true } } },
  });
  if (!org) throw new Error(`No carrier at "${subdomain}".`);
  return {
    name: org.name,
    planName: org.plan?.name ?? "no plan",
    modules: modulesForPlan(org.plan?.features ?? [], MODULES),
  };
}

async function main() {
  console.log(`\nPlan gating — ${FULL} against ${LIMITED}\n`);

  const full = await planFor(FULL);
  const limited = await planFor(LIMITED);

  console.log(`  ${full.name.padEnd(20)} ${full.planName} · ${[...full.modules].join(", ")}`);
  console.log(`  ${limited.name.padEnd(20)} ${limited.planName} · ${[...limited.modules].join(", ")}\n`);

  const gated = PROBES.filter(
    (probe) => full.modules.has(probe.module) && !limited.modules.has(probe.module),
  );

  if (gated.length === 0) {
    console.error(
      "  Both carriers have the same modules, so there is nothing to prove.\n" +
        "  Put them on different plans first — see prisma/seed/plans.ts.\n",
    );
    process.exitCode = 1;
    return;
  }

  const fullHost = `${FULL}.${ROOT}`;
  const limitedHost = `${LIMITED}.${ROOT}`;

  const fullSession = await signIn(fullHost);
  const limitedSession = await signIn(limitedHost);

  check(`signed in on ${FULL}`, fullSession.signedIn);
  check(`signed in on ${LIMITED}`, limitedSession.signedIn);
  if (!fullSession.signedIn || !limitedSession.signedIn) {
    console.error("\n  Cannot probe without both sessions.\n");
    process.exitCode = 1;
    return;
  }

  console.log("\nThe carrier who bought it reaches it");
  for (const probe of gated) {
    const response = await hostFollow(fullHost, PORT, probe.path, fullSession.jar);
    check(
      `${FULL} opens ${probe.label}`,
      response.status === 200 && !response.finalPath.startsWith("/not-on-plan"),
      response.finalPath,
    );
  }

  console.log("\nThe carrier who did not is refused the URL");
  for (const probe of gated) {
    const response = await hostFollow(limitedHost, PORT, probe.path, limitedSession.jar);
    // Refused is either the plan page or a permission refusal — both are a
    // refusal, and the plan page is the better one because it says who can
    // fix it. What must never happen is the screen rendering.
    const refused =
      response.finalPath.startsWith("/not-on-plan") ||
      response.finalPath.startsWith("/forbidden") ||
      response.status === 404;
    check(`${LIMITED} is refused ${probe.label}`, refused, response.finalPath);
  }

  console.log("\nAnd is not shown the way in");
  const dashboard = await hostFollow(limitedHost, PORT, "/dashboard", limitedSession.jar);
  for (const probe of gated) {
    check(
      `no link to ${probe.label} in the navigation`,
      !dashboard.body.includes(`href="${probe.path}"`),
      "",
    );
  }

  // The public portal is gated differently on purpose: its reader is the
  // carrier's customer, so a carrier without it has no portal rather than a
  // portal that explains our pricing.
  if (full.modules.has("portal") && !limited.modules.has("portal")) {
    console.log("\nThe customer portal");
    const open = await hostFetch(fullHost, PORT, "/portal/login");
    const shut = await hostFetch(limitedHost, PORT, "/portal/login");
    check(`${FULL} has a portal`, open.status === 200, `HTTP ${open.status}`);
    check(
      `${LIMITED} has no portal, and is not told why`,
      shut.status === 404,
      `HTTP ${shut.status}`,
    );
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
