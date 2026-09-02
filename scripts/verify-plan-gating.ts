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
 * Four defences are tested separately, because they are four separate
 * things and any one of them can rot without the others noticing:
 *
 *   1. the route refuses a typed URL,
 *   2. the navigation does not draw the link,
 *   3. the session does not carry the module's permissions,
 *   4. a door that runs no layout — a server action, a route handler — is
 *      refused too.
 *
 * The fourth is the one this suite was missing, and it is the one that has
 * actually been wrong three times: `trip.dispatch` reached from tracking,
 * `master.read` from SLA policies, and the partner API answering on a plan
 * that does not include it. A URL guard lives in a layout, and none of those
 * three renders one.
 *
 * Hiding a link is presentation. Presentation is not access control.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { basePrisma, disconnectDb } from "../src/lib/prisma-base";
import { generateApiKey } from "../src/lib/webhooks/api-key";
import { runWithTenant, tenantContextFor } from "../src/lib/tenant";
import { prisma } from "../src/lib/prisma";
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
    select: {
      id: true,
      slug: true,
      name: true,
      subdomain: true,
      customDomain: true,
      status: true,
      plan: { select: { name: true, features: true } },
    },
  });
  if (!org) throw new Error(`No carrier at "${subdomain}".`);

  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Carrier "${subdomain}" is closed.`);

  return {
    orgId: org.id,
    subdomain,
    tenant,
    name: org.name,
    planName: org.plan?.name ?? "no plan",
    modules: modulesForPlan(org.plan?.features ?? [], MODULES),
  };
}

/**
 * The fourth defence, and the one the other three cannot stand in for.
 *
 * Every probe above this asks the app for a *page*, and a page is rendered
 * inside `(ops)/layout.tsx`, where the URL guard lives. A server action and
 * a route handler run no layout at all: they are addressed directly, they
 * answer directly, and the guard never sees them. What covers them is that
 * the actor's permission set has already had the unbought modules
 * subtracted — and until this was written, nothing here proved that a real
 * request over real HTTP was answered that way.
 *
 * The partner API is used as the probe because it is the one such door that
 * can be knocked on from a script without knowing a build-time action id.
 * It is also the one that was wrong: `withApiKey` built its actor straight
 * from the key owner's role grants, so a plan could close every screen in
 * the product and not the API.
 *
 * A key is minted and deleted here, the way `smoke-api.ts` does it. The LR
 * number asked for does not exist on purpose: what is being read is *which
 * refusal comes back*, and a carrier who bought the module has to get as far
 * as "no such consignment" for the comparison to mean anything.
 */
async function provesADoorWithNoLayout(
  full: Awaited<ReturnType<typeof planFor>>,
  limited: Awaited<ReturnType<typeof planFor>>,
  fullHost: string,
  limitedHost: string,
): Promise<void> {
  if (!full.modules.has("integrations") || limited.modules.has("integrations")) {
    return; // Nothing to compare: both carriers answer the same way.
  }

  console.log("\nA door no layout guards: the partner API");

  const issued: Array<{ tenant: ReturnType<typeof tenantContextFor>; id: string }> = [];

  try {
    for (const carrier of [full, limited]) {
      const host = carrier === full ? fullHost : limitedHost;

      // Tenant-scoped, not `basePrisma`: `app_user` carries an RLS policy,
      // and the base client has no tenant for it to satisfy. Reading it
      // without a context returns nothing at all — which reads exactly like
      // "this carrier has no staff" and is not that.
      const owner = await runWithTenant(carrier.tenant, async () =>
        prisma.user.findFirst({
          where: { mobile: STAFF_MOBILE, status: "ACTIVE" },
          select: { id: true },
        }),
      );
      if (!owner) {
        check(`${carrier.subdomain} has a user to own an API key`, false, STAFF_MOBILE);
        continue;
      }

      // `generateApiKey` is the only place the plaintext exists, here and in
      // production alike, so the key has to be minted rather than read back.
      const generated = generateApiKey();
      const row = await runWithTenant(carrier.tenant, async () =>
        prisma.apiKey.create({
          data: {
            orgId: carrier.orgId,
            name: `plan-gating probe ${randomUUID().slice(0, 8)}`,
            keyHash: generated.keyHash,
            keyPrefix: generated.keyPrefix,
            scopes: ["shipment.read"],
            ipAllowlist: [],
            createdById: owner.id,
          },
          select: { id: true },
        }),
      );
      issued.push({ tenant: carrier.tenant, id: row.id });

      const response = await hostFetch(host, PORT, "/api/v1/shipments/CL000000000000", {
        headers: { "x-api-key": generated.key },
      });
      const code = (() => {
        try {
          return (JSON.parse(response.body).error as { code?: string })?.code ?? "";
        } catch {
          return "";
        }
      })();

      if (carrier === full) {
        check(
          `${FULL} reaches the partner API with a valid key`,
          response.status === 404 && code === "not_found",
          `HTTP ${response.status} ${code || "(no code)"}`,
        );
      } else {
        check(
          `${LIMITED} is refused the partner API, and told it is the plan`,
          response.status === 403 && code === "not_on_plan",
          `HTTP ${response.status} ${code || "(no code)"}`,
        );
      }
    }
  } finally {
    for (const key of issued) {
      if (!key.tenant) continue;
      await runWithTenant(key.tenant, async () => {
        await prisma.apiKey.delete({ where: { id: key.id } });
      }).catch(() => undefined);
    }
  }
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

  await provesADoorWithNoLayout(full, limited, fullHost, limitedHost);

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
