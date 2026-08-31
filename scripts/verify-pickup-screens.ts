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
import { raisePickupRequest } from "../src/lib/pickup/request";
import type { SessionUser } from "../src/lib/auth/session";

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
/** Somebody who runs the pickup desk, rather than the round. */
const OPS_MOBILE = args.get("ops") ?? process.env.SMOKE_ADMIN_MOBILE ?? "9999999999";
const PASSWORD = args.get("password") ?? "Admin@123";

let failures = 0;
let passes = 0;

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

/**
 * Today, as a `date` column stores it.
 *
 * The column keeps the UTC calendar day, so building this from local
 * midnight would file a pickup raised this morning under yesterday at any
 * positive offset — IST is +5:30. `asStoredDate` in `lib/pickup/execute.ts`
 * is the same trick and explains it in full.
 */
function storedToday(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0),
  );
}

/**
 * Enough of a session for the service layer, for seeding only.
 *
 * The screens themselves are driven over HTTP as a signed-in person; this
 * exists solely to put a row on the page for them to find.
 */
async function opsActor(mobile: string): Promise<SessionUser | null> {
  const user = await prisma.user.findFirst({
    where: { mobile },
    include: {
      primaryBranch: { select: { id: true, code: true, name: true } },
      roles: {
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      },
    },
  });
  if (!user) return null;

  const permissions = new Set<string>();
  let widest: SessionUser["scope"] = "OWN";
  const rank: Record<string, number> = { OWN: 0, BRANCH: 1, BRANCH_SET: 2, NETWORK: 3 };

  for (const link of user.roles) {
    for (const rp of link.role.permissions) permissions.add(rp.permission.code);
    const scope = link.role.scope as SessionUser["scope"];
    if ((rank[scope] ?? 0) > (rank[widest] ?? 0)) widest = scope;
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
    scope: widest,
    branchIds: widest === "NETWORK" ? null : user.primaryBranch ? [user.primaryBranch.id] : [],
  };
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

  const jar = await signIn(EXEC_MOBILE, "/pickups/today");

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

  // ── The desk, where a collection is raised by hand ─────────
  //
  // `createPickupRequest` was a dead export: validated, audited, and
  // unreachable, because `/pickups` had no create control. The consignor
  // who telephones could not be served at all. What follows is the proof
  // that there is now a way in, and that it is a permission and not
  // decoration — the executive, who may read the desk, must not see it.
  console.log("\nThe pickup desk");

  const seeded = await runWithTenant(tenant, async () => {
    const actor = await opsActor(OPS_MOBILE);
    if (!actor) return null;

    const branchId = actor.primaryBranch?.id;
    if (!branchId) return null;

    const city = await prisma.city.findFirstOrThrow({
      where: { isActive: true },
      select: { id: true },
    });

    // A stop that is still open, so the row actions are on the page at all.
    const raised = await raisePickupRequest(
      {
        shipmentId: null,
        customerId: null,
        branchId,
        contactName: "Screens Telephoned Consignor",
        phone: "9800000016",
        address: "Shop 11, Old Market",
        cityId: city.id,
        pincode: "122001",
        landmark: null,
        requestedDate: storedToday(),
        slot: "ANYTIME",
        priority: 0,
        expectedPackages: 1,
        expectedWeight: null,
        goodsDescription: "Screen verification — auto-generated",
        notes: "Ask at the counter",
      },
      actor,
    );

    return raised.ok ? raised : null;
  });

  const opsJar = await signIn(OPS_MOBILE, "/pickups");
  const desk = await hostFollow(HOST, PORT, "/pickups", opsJar);

  check(
    "the pickup desk renders for the ops user",
    desk.status === 200 && !desk.finalPath.includes("/login"),
    `HTTP ${desk.status} at ${desk.finalPath}`,
  );
  check(
    "and offers a way to raise a collection by hand",
    desk.body.includes("New pickup"),
    "the create control is on the page",
  );

  if (!seeded) {
    console.log("  [SKIP] could not seed an open pickup at the ops user's branch");
  } else {
    check(
      "a pickup raised by hand reaches the desk",
      desk.body.includes(seeded.number),
      seeded.number,
    );
    check(
      "and can be called off from there",
      desk.body.includes("Cancel this pickup"),
      "the cancel control is on the row",
    );
  }

  // The same page as the executive. They hold `pickup.read` and not
  // `pickup.create`, so the desk renders and the control does not.
  const readOnly = await hostFollow(HOST, PORT, "/pickups", jar);
  check(
    "the executive may read the desk",
    readOnly.status === 200 && !readOnly.finalPath.includes("/login"),
    `HTTP ${readOnly.status} at ${readOnly.finalPath}`,
  );
  check(
    "but is not offered the control — it is a permission, not decoration",
    !readOnly.body.includes("New pickup") &&
      !readOnly.body.includes("Cancel this pickup"),
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
