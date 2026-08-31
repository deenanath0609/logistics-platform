/**
 * The pickup executive's screens, driven over HTTP as the executive.
 *
 *   npx tsx scripts/verify-pickup-screens.ts [--base http://localhost:3010]
 *
 * `verify-pickup-cycle.ts` proves the services; this proves a person can
 * reach them. The two are separate on purpose — the cycle passed for a while
 * before any screen existed, which is exactly the state the pickup module
 * was already in and the reason this file is here.
 */
import "dotenv/config";
import { basePrisma, prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor } from "../src/lib/tenant";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "true");
}

const BASE = args.get("base") ?? "http://localhost:3010";
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
const SUBDOMAIN = args.get("tenant") ?? "city-logistics";
const HOST = `${SUBDOMAIN}.${ROOT}`;

const EXEC_MOBILE = args.get("mobile") ?? "9999900007";
const PASSWORD = args.get("password") ?? "Admin@123";

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function signIn(): Promise<CookieJar> {
  const jar = new CookieJar();

  const csrf = await hostFollow(HOST, PORT, "/api/auth/csrf", jar);
  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };

  const response = await hostFetch(HOST, PORT, "/api/auth/callback/password", {
    method: "POST",
    cookie: jar.header(),
    body: new URLSearchParams({
      mobile: EXEC_MOBILE,
      password: PASSWORD,
      csrfToken,
      callbackUrl: `${BASE}/pickups/today`,
    }).toString(),
  });
  jar.absorb(response);

  return jar;
}

async function main() {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${SUBDOMAIN}" is closed.`);

  const open = await runWithTenant(tenant, async () =>
    await prisma.pickupAssignment.findFirst({
      where: { supersededAt: null, status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
      orderBy: { assignedAt: "desc" },
      select: {
        id: true,
        request: { select: { number: true, contactName: true } },
      },
    }),
  );

  console.log(`\nPickup screens — ${org.slug}, as ${EXEC_MOBILE}\n`);

  const jar = await signIn();

  const list = await hostFollow(HOST, PORT, "/pickups/today", jar);
  check(
    "the executive's collections list renders",
    list.status === 200 && !list.finalPath.includes("/login"),
    `HTTP ${list.status} at ${list.finalPath}`,
  );

  if (!open) {
    console.log("  [SKIP] no open pickup is assigned, so there is no stop to open");
  } else {
    check(
      "the assigned stop is on it",
      list.body.includes(open.request.contactName),
      open.request.contactName,
    );

    const task = await hostFollow(HOST, PORT, `/pickups/task/${open.id}`, jar);
    check(
      "the stop opens",
      task.status === 200 && task.body.includes(open.request.number),
      `${open.request.number} — HTTP ${task.status}`,
    );
    check(
      "and offers both outcomes",
      task.body.includes("Collected") && task.body.includes("Could not collect"),
    );
    check(
      "with the reasons a failure needs",
      task.body.includes("Premises closed") || task.body.includes("Address not found"),
      "pickup-failure reason codes are rendered",
    );
  }

  // The screen is core, not an upsell: a carrier on the smallest plan still
  // collects freight, so it must not be gated away.
  const gated = await hostFollow(HOST, PORT, "/pickups/today", jar);
  check(
    "it is not behind a plan",
    !gated.finalPath.includes("/not-on-plan"),
    gated.finalPath,
  );

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nThe pickup screen check could not run:\n", error);
  process.exit(1);
});
