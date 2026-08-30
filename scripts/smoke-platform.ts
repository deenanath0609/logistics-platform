/**
 * Drives the operator console as a signed-in operator and asserts that
 * every screen actually renders.
 *
 *   npx tsx scripts/smoke-platform.ts [baseUrl]
 *
 * The routes behind the sign-in guard were, until this existed, only ever
 * checked by asking for them signed *out* and seeing a redirect. That
 * proves the guard runs and nothing else — a page that throws on render
 * looks identical from outside. This mints the console's own session cookie
 * the same way the sign-in action does, then asks for each page and fails
 * on anything that is not a 200 carrying the content it should.
 *
 * It mints rather than posting the sign-in form on purpose: the point is to
 * exercise the pages, and a smoke test that needs a password in an argument
 * is a smoke test nobody runs.
 */
import "dotenv/config";
import { SignJWT } from "jose";
import { basePrisma, disconnectDb } from "../src/lib/prisma-base";
import { hostFetch } from "./host-fetch";

const BASE = process.argv[2] ?? "http://localhost:3010";

const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
/** The console is the bare platform domain; carriers are subdomains of it. */
const CONSOLE_HOST = ROOT;
const CARRIER_HOST = `city-logistics.${ROOT}`;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};

/** Mirrors `startPlatformSession` — same claims, same secret, same audience. */
async function operatorCookie(adminId: string): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set.");

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`platform:${adminId}`)
    .setIssuer("city-logistics")
    .setAudience("platform-console")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret));

  return `platform_session=${token}`;
}

/** Each page, and a string that only appears when it truly rendered. */
const PAGES: Array<[path: string, expect: string]> = [
  ["/platform", "Tenants"],
  ["/platform/tenants", "Tenants"],
  ["/platform/tenants/new", "New tenant"],
  ["/platform/plans", "Plans"],
  ["/platform/audit", "Audit"],
  ["/platform/impersonation", "Impersonation"],
];

async function main() {
  console.log(`\nOperator console — http://${CONSOLE_HOST}:${PORT}\n`);

  const admin = await basePrisma.platformAdmin.findFirst({
    where: { isActive: true, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, role: true },
  });

  if (!admin) {
    console.error(
      "  No operator account exists. Create one first:\n" +
        "    npm run platform:admin -- --email you@example.com --name \"You\"\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`  acting as ${admin.email} (${admin.role})\n`);
  const cookie = await operatorCookie(admin.id);

  for (const [path, expect] of PAGES) {
    const response = await hostFetch(CONSOLE_HOST, PORT, path, { cookie });

    if (response.status !== 200) {
      // A redirect here means the session was rejected; anything else means
      // the page itself fell over. Both are failures, and saying which one
      // saves the next person a bisect.
      check(
        path,
        false,
        response.status >= 300 && response.status < 400
          ? `redirected to ${response.location} — the session was refused`
          : `HTTP ${response.status}`,
      );
      continue;
    }

    const { body } = response;
    check(path, body.includes(expect), body.includes(expect) ? "" : `no "${expect}" in the page`);
  }

  // The tenant detail page is the one with real work on it, so it is worth
  // reaching with a real id rather than trusting the list page alone.
  const org = await basePrisma.organization.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });

  if (org) {
    const response = await hostFetch(CONSOLE_HOST, PORT, `/platform/tenants/${org.id}`, { cookie });
    const body = response.status === 200 ? response.body : "";
    check(
      `/platform/tenants/[orgId] renders ${org.name}`,
      response.status === 200 && body.includes(org.name),
      response.status === 200 ? "" : `HTTP ${response.status}`,
    );
  }

  // The other half of the boundary: the same cookie on a carrier's host must
  // buy nothing at all.
  const leaked = await hostFetch(CARRIER_HOST, PORT, "/platform/tenants", { cookie });
  check(
    "the console is refused on a carrier's own host",
    leaked.status === 404,
    `HTTP ${leaked.status}`,
  );

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${PAGES.length + 2} screen(s) checked, ${failures} broken.\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
