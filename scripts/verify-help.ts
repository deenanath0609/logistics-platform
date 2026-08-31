/**
 * Help, in all three applications, reachable by the narrowest login.
 *
 *   npx tsx scripts/verify-help.ts [--base http://localhost:3010]
 *
 * The point of a help screen is that it is there when somebody is stuck, so
 * the property worth pinning is not that it renders — it is that nothing
 * gates it. A carrier on the barest plan, a clerk with four permissions and
 * a portal member who cannot book still get it, or it is not help.
 *
 * The operator console is signed into with a minted session rather than a
 * password, the way `smoke-platform.ts` does: there is no console password
 * in this repo and there should not be one.
 */
import "dotenv/config";
import { SignJWT } from "jose";
import { basePrisma } from "../src/lib/prisma";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "true");
}

const BASE = args.get("base") ?? "http://localhost:3010";
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
const CARRIER = `${args.get("tenant") ?? "city-logistics"}.${ROOT}`;
const CONSOLE = ROOT;

/** The narrowest office login in the seed: a booking clerk at one branch. */
const CLERK = args.get("mobile") ?? "9999900003";
const PASSWORD = args.get("password") ?? "Admin@123";
const PORTAL_USER = args.get("portal") ?? "vikram@acme.test";
const PORTAL_PASSWORD = args.get("portal-password") ?? "Portal@123";

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function staffSession(): Promise<CookieJar> {
  const jar = new CookieJar();
  const csrf = await hostFollow(CARRIER, PORT, "/api/auth/csrf", jar);
  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };

  const response = await hostFetch(CARRIER, PORT, "/api/auth/callback/password", {
    method: "POST",
    cookie: jar.header(),
    body: new URLSearchParams({
      mobile: CLERK,
      password: PASSWORD,
      csrfToken,
      callbackUrl: `http://${CARRIER}:${PORT}/dashboard`,
    }).toString(),
  });
  jar.absorb(response);
  return jar;
}

/** Mirrors `startPlatformSession` — same claims, same secret, same audience. */
async function operatorCookie(): Promise<string> {
  const admin = await basePrisma.platformAdmin.findFirstOrThrow({
    where: { isActive: true, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`platform:${admin.id}`)
    .setIssuer("city-logistics")
    .setAudience("platform-console")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET ?? ""));

  return `platform_session=${token}`;
}

async function main() {
  console.log(`\nHelp — ${CARRIER} and ${CONSOLE}\n`);

  // ── The office ────────────────────────────────────────────
  const staff = await staffSession();

  const dashboard = await hostFollow(CARRIER, PORT, "/dashboard", staff);
  check(
    `${CLERK} is signed in`,
    !dashboard.finalPath.includes("/login"),
    dashboard.finalPath,
  );

  check(
    "the sidebar offers Help to a booking clerk",
    dashboard.body.includes("/help"),
    "no /help link in the rendered nav",
  );

  const staffHelp = await hostFollow(CARRIER, PORT, "/help", staff);
  check(
    "the staff Help screen renders",
    staffHelp.status === 200 && !staffHelp.finalPath.includes("/login"),
    `HTTP ${staffHelp.status} at ${staffHelp.finalPath}`,
  );
  check(
    "and is not behind a plan",
    !staffHelp.finalPath.includes("/not-on-plan"),
    staffHelp.finalPath,
  );
  check(
    "it explains the journey rather than listing links",
    staffHelp.body.includes("Pickup") && staffHelp.body.includes("Delivered"),
  );

  // ── The customer ──────────────────────────────────────────
  //
  // A MEMBER rather than the account owner: the narrowest portal login
  // there is, and the one most likely to be told a screen is not for them.
  const portal = new CookieJar();
  const portalCsrf = await hostFetch(CARRIER, PORT, "/api/auth/csrf", {
    cookie: portal.header(),
  });
  portal.absorb(portalCsrf);
  const { csrfToken: portalToken } = JSON.parse(portalCsrf.body) as { csrfToken: string };

  const portalAuth = await hostFetch(CARRIER, PORT, "/api/auth/callback/customer", {
    method: "POST",
    cookie: portal.header(),
    body: new URLSearchParams({
      email: PORTAL_USER,
      password: PORTAL_PASSWORD,
      csrfToken: portalToken,
      callbackUrl: `http://${CARRIER}:${PORT}/portal`,
    }).toString(),
  });
  portal.absorb(portalAuth);

  const portalHome = await hostFollow(CARRIER, PORT, "/portal", portal);
  check(
    `${PORTAL_USER} is signed in to the portal`,
    !portalHome.finalPath.includes("/portal/login"),
    portalHome.finalPath,
  );

  const portalHelp = await hostFollow(CARRIER, PORT, "/portal/help", portal);
  check(
    "the portal Help screen renders for a member",
    portalHelp.status === 200 && !portalHelp.finalPath.includes("/portal/login"),
    `HTTP ${portalHelp.status} at ${portalHelp.finalPath}`,
  );
  check(
    "and speaks the customer's language, not the trade's",
    !portalHelp.body.includes("Manifested") && !portalHelp.body.includes("manifest"),
    "internal vocabulary leaked into the customer help",
  );

  // ── The operator ──────────────────────────────────────────
  const consoleHelp = await hostFetch(CONSOLE, PORT, "/platform/help", {
    cookie: await operatorCookie(),
  });
  check(
    "the operator Help screen renders",
    consoleHelp.status === 200,
    `HTTP ${consoleHelp.status}`,
  );
  check(
    "and describes what a plan grants",
    consoleHelp.body.includes("Hub") || consoleHelp.body.includes("module"),
  );

  // The console is not served on a carrier's host, and its help is not an
  // exception to that.
  const leaked = await hostFetch(CARRIER, PORT, "/platform/help", {
    cookie: await operatorCookie(),
  });
  check(
    "the operator Help is refused on a carrier's host",
    leaked.status === 404,
    `HTTP ${leaked.status}`,
  );

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nThe help check could not run:\n", error);
  process.exit(1);
});
