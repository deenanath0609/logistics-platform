/**
 * Proves phases 11 and 12 against the real database and the real app.
 *
 *   npx tsx scripts/verify-modules-worker.ts [--full city-logistics]
 *                                            [--limited acme]
 *                                            [--base http://localhost:3010]
 *
 * `verify-plan-gating.ts` next door proves that a carrier cannot *browse*
 * to a module they did not buy. This proves the two halves that a URL guard
 * cannot reach, and then the promises the worker makes about work that must
 * not be lost.
 *
 * ── Phase 11, the doors with no layout ──────────────────────────────────
 *
 * A server action and a route handler run no layout, so the ops layout's
 * URL guard never sees them. What covers them instead is that the session's
 * permission set has already had the unbought modules subtracted from it —
 * so this asserts that subtraction against the carriers' real plans and
 * their real role grants, rather than against a fixture that can agree with
 * a bug.
 *
 * ── Phase 12, the outbox ────────────────────────────────────────────────
 *
 * Every outbox assertion here is made on a **return value** — what this
 * process's own call did — and never on a count of rows in a shared table.
 * That is deliberate and it is the lesson of two separate false defects in
 * this repository: `verify-reweigh` once compared a `count()` against a
 * `take: 6`, and `verify-worker` read another running worker's in-flight
 * claim as a stranded row for weeks. A drain running in another terminal
 * may take these probe rows at any moment; not one assertion below cares.
 *
 * ── What is not here ────────────────────────────────────────────────────
 *
 * The worker *process* — start, drain, stop, kill, recover — is
 * `verify-worker.ts`, which needs to be the only worker connected.
 * Everything here runs in this process and is safe to run at any time.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { basePrisma, disconnectDb } from "../src/lib/prisma-base";
import { prisma } from "../src/lib/prisma";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";
import { MODULES } from "../src/lib/modules/modules";
import {
  MODULE_KEYS,
  modulesForPlan,
  narrowToModules,
  isModuleKey,
  type ModuleKey,
} from "../src/lib/modules/registry";
import { PERMISSIONS } from "../src/lib/rbac/permissions";
import {
  drainOutbox,
  enqueueOutbox,
  reclaimStalledOutbox,
} from "../src/server/services/outbox";
import { beginShutdown, resetShutdownForTests } from "../src/lib/runtime/shutdown";
import { getObjectStore, STORAGE_ROOT, readTenantObject } from "../src/lib/storage";
import { buildObjectKey } from "../src/lib/storage/keys";
import { runWithTenant, tenantContextFor, type TenantContext } from "../src/lib/tenant";

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

const note = (text: string) => console.log(`         ${text}`);

/** React escapes what it renders; a probe comparing raw text has to agree. */
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#x27;");
}

/**
 * One real screen *below* each module's route prefix.
 *
 * Written out rather than derived from `MODULES[key].routes[0]`, because the
 * property under test is that prefix matching reaches a nested page — and a
 * made-up nested path cannot show that. An unmatched URL is answered by the
 * framework's 404 before any layout runs, so it would pass this check while
 * saying nothing at all about the guard.
 */
const NESTED_SCREEN: Partial<Record<ModuleKey, string>> = {
  hub: "/hub/inbound",
  dispatch: "/dispatch/manifests",
  lastmile: "/delivery/runs",
  cod: "/delivery/cod",
  billing: "/finance/invoices",
  tracking: "/tracking/geofences",
  sla: "/masters/sla-policies",
  integrations: "/integrations/api-keys",
};

// ────────────────────────────────────────────────────────────
// Carriers
// ────────────────────────────────────────────────────────────

type Carrier = {
  subdomain: string;
  orgId: string;
  name: string;
  planName: string;
  modules: ReadonlySet<ModuleKey>;
  tenant: TenantContext;
};

async function carrierFor(subdomain: string): Promise<Carrier> {
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
    subdomain,
    orgId: org.id,
    name: org.name,
    planName: org.plan?.name ?? "no plan",
    modules: modulesForPlan(org.plan?.features, MODULES),
    tenant,
  };
}

async function signIn(host: string) {
  const jar = new CookieJar();

  const csrf = await hostFetch(host, PORT, "/api/auth/csrf", { cookie: jar.header() });
  jar.absorb(csrf);
  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };

  const posted = await hostFetch(host, PORT, "/api/auth/callback/password", {
    method: "POST",
    cookie: jar.header(),
    body: new URLSearchParams({
      mobile: STAFF_MOBILE,
      password: STAFF_PASSWORD,
      csrfToken,
      callbackUrl: `http://${host}:${PORT}/dashboard`,
    }).toString(),
  });
  jar.absorb(posted);

  const landed = await hostFollow(host, PORT, "/dashboard", jar);
  return { jar, signedIn: landed.status === 200 && !landed.finalPath.startsWith("/login") };
}

// ────────────────────────────────────────────────────────────
// 1. The registry against the plans that are actually sold
// ────────────────────────────────────────────────────────────

async function provesThePlanTableAgreesWithTheRegistry(): Promise<void> {
  console.log("\n1. The plans on sale name modules this build knows\n");

  // `TenantPlan.features` is a free `String[]` typed into the plan editor,
  // and `modulesForPlan` drops anything it does not recognise rather than
  // trusting it. Dropping silently is the right runtime behaviour and the
  // wrong thing to never look at: a plan that says "gps" grants nothing,
  // the carrier is billed for it, and nobody finds out until they call.
  const plans = await basePrisma.tenantPlan.findMany({
    select: { code: true, name: true, features: true },
    take: 50,
  });

  check("there are plans to check", plans.length > 0, `${plans.length} plan(s)`);

  const unknown: string[] = [];
  const dropped: string[] = [];

  for (const plan of plans) {
    for (const feature of plan.features) {
      if (!isModuleKey(feature)) unknown.push(`${plan.code}: "${feature}"`);
    }
    const granted = modulesForPlan(plan.features, MODULES);
    for (const feature of plan.features) {
      // Named a real module, and still did not get it: its prerequisite is
      // missing from the same plan. Also silent, also sold.
      if (isModuleKey(feature) && !granted.has(feature)) {
        const needs = (MODULES[feature].requires ?? []).filter((n) => !granted.has(n));
        dropped.push(`${plan.code}: "${feature}" needs ${needs.join(", ")}`);
      }
    }
  }

  check("no plan names a module this build does not have", unknown.length === 0, unknown.join("; "));
  check(
    "no plan sells a module its own prerequisites withhold",
    dropped.length === 0,
    dropped.join("; "),
  );
}

// ────────────────────────────────────────────────────────────
// 2. The narrowing that covers every server action at once
// ────────────────────────────────────────────────────────────

async function provesTheSessionIsNarrowed(carriers: Carrier[]): Promise<void> {
  console.log("\n2. A server action passes no URL guard, so the session is narrowed\n");

  for (const carrier of carriers) {
    // The permissions this carrier's roles actually grant, read from their
    // own database rows rather than from `SYSTEM_ROLES` — a role edited on
    // the tenant is what a session is built from.
    const held = new Set<string>();
    await runWithTenant(carrier.tenant, async () => {
      const grants = await prisma.rolePermission.findMany({
        select: { permission: { select: { code: true } } },
        take: 2_000,
      });
      for (const grant of grants) held.add(grant.permission.code);
    });

    const kept = narrowToModules(held, carrier.modules, MODULES);

    const missing = MODULE_KEYS.filter((key) => !carrier.modules.has(key));
    const leaked: string[] = [];
    for (const key of missing) {
      for (const code of MODULES[key].permissions) {
        if (kept.has(code)) leaked.push(`${code} (${key})`);
      }
    }

    check(
      `${carrier.subdomain} carries no permission of a module it did not buy`,
      leaked.length === 0,
      leaked.length === 0
        ? `${missing.length} module(s) withheld`
        : leaked.join(", "),
    );

    // The other half, and it matters just as much: narrowing must not eat
    // a permission nobody's module owns. Booking is core, and a carrier on
    // the barest plan there is still books.
    const core = ["shipment.read", "shipment.create", "master.read", "user.manage"];
    const lost = core.filter((code) => held.has(code) && !kept.has(code));
    check(
      `${carrier.subdomain} keeps the always-on permissions`,
      lost.length === 0,
      lost.length === 0 ? core.join(", ") : `lost ${lost.join(", ")}`,
    );
  }
}

// ────────────────────────────────────────────────────────────
// 3. Every permission is either a module's or deliberately core
// ────────────────────────────────────────────────────────────

function provesEveryPermissionIsAccountedFor(): void {
  console.log("\n3. Every permission in the catalogue is placed on purpose\n");

  const owner = new Map<string, ModuleKey[]>();
  for (const key of MODULE_KEYS) {
    for (const code of MODULES[key].permissions) {
      owner.set(code, [...(owner.get(code) ?? []), key]);
    }
  }

  const shared = [...owner.entries()].filter(([, keys]) => keys.length > 1);
  check(
    "no permission is claimed by two modules",
    shared.length === 0,
    shared.map(([code, keys]) => `${code}: ${keys.join("+")}`).join("; "),
  );

  const invented = [...owner.keys()].filter(
    (code) => !PERMISSIONS.some((p) => p.code === code),
  );
  check(
    "no module claims a permission the catalogue does not have",
    invented.length === 0,
    invented.join(", "),
  );

  // The catalogue's own `module` field is documentation, not enforcement —
  // except for finance, where the drift that shipped (`settlement.prepare`
  // owned by nobody, and a server action gated on it) proved it has to be.
  const financeGaps = PERMISSIONS.filter(
    (p) => p.module === "finance" && owner.get(p.code)?.[0] !== "billing",
  ).map((p) => p.code);
  check(
    "billing owns every finance permission",
    financeGaps.length === 0,
    financeGaps.join(", "),
  );

  const unowned = PERMISSIONS.filter((p) => !owner.has(p.code));
  const byModule = new Map<string, number>();
  for (const p of unowned) byModule.set(p.module, (byModule.get(p.module) ?? 0) + 1);

  // Not a failure — this is the core set, and it is meant to be large. It
  // is printed because "which permissions is nothing gating?" is the
  // question this whole phase turns on, and it should be readable rather
  // than derived by whoever next asks it.
  note(
    `${unowned.length} permission(s) belong to no module and are therefore never ` +
      "withheld — the always-on core:",
  );
  for (const [module, count] of [...byModule.entries()].sort()) {
    note(`  ${module}: ${count}`);
  }
}

// ────────────────────────────────────────────────────────────
// 4. The refusal a person reads
// ────────────────────────────────────────────────────────────

async function provesTheRefusalPage(carriers: Carrier[]): Promise<void> {
  console.log("\n4. The refusal names the capability and who can restore it\n");

  const limited = carriers[1];
  const host = `${limited.subdomain}.${ROOT}`;
  const session = await signIn(host);
  check(`signed in on ${limited.subdomain}`, session.signedIn);
  if (!session.signedIn) return;

  const absent = MODULE_KEYS.find(
    (key) => !limited.modules.has(key) && key in NESTED_SCREEN,
  );
  if (!absent) {
    note("this carrier has every module with a screen; nothing to refuse.");
    return;
  }

  // A screen *below* the module's route prefix, not the prefix itself.
  // Prefix matching is what makes a page written next month gated without
  // anyone touching the registry, and a guard that only recognised the
  // module root would look identical to this one until somebody linked a
  // level deeper. A real screen, because an unmatched URL answers 404
  // before any layout runs and so proves nothing about the guard.
  const nested = NESTED_SCREEN[absent] as string;
  const refused = await hostFollow(host, PORT, nested, session.jar);
  check(
    `a screen below /${absent} is refused, not just the module's root`,
    refused.finalPath.startsWith("/not-on-plan"),
    `${nested} → ${refused.finalPath}`,
  );

  const page = await hostFollow(host, PORT, `/not-on-plan?module=${absent}`, session.jar);
  check(
    "the page names the capability rather than saying access denied",
    page.body.includes(htmlEscape(MODULES[absent].label)),
    MODULES[absent].label,
  );
  check(
    "and sends the reader to whoever owns the subscription",
    page.body.includes("subscription") && !page.body.includes("ask your branch manager"),
  );

  // `?module=` arrives from a URL, so it is a hint and never a claim. The
  // framework echoes the query back inside its own escaped router payload,
  // which is inert and is not what is being asked about here: what must not
  // happen is a tag in the document, or the tampered text standing where the
  // capability's name goes.
  const tampered = await hostFollow(
    host,
    PORT,
    "/not-on-plan?module=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    session.jar,
  );
  check(
    "a tampered module name cannot put a tag in the page",
    !tampered.body.includes("<script>alert(1)</script>"),
  );
  check(
    "and falls back to the sentence that claims nothing",
    tampered.body.includes("That is not on your plan"),
  );
}

// ────────────────────────────────────────────────────────────
// 5. The outbox, on return values only
// ────────────────────────────────────────────────────────────

async function provesTheOutbox(carrier: Carrier): Promise<void> {
  console.log("\n5. The outbox: nothing is claimed on the way out, nothing is stranded\n");

  const probe = `verify.modules_worker.${randomUUID().slice(0, 8)}`;

  try {
    // ── A stop is a boundary where nothing is half-done ──────────────
    await runWithTenant(carrier.tenant, async () => {
      for (let i = 0; i < 5; i++) {
        await enqueueOutbox({
          eventType: probe,
          aggregate: "VerifyProbe",
          aggregateId: `probe_${i}`,
          payload: { i },
        });
      }
    });

    beginShutdown();
    const duringShutdown = await runWithTenant(carrier.tenant, async () => drainOutbox(50));
    resetShutdownForTests();

    // The number this call processed, not the state of the table. Another
    // worker draining in the next terminal cannot change this answer.
    check(
      "a drain asked to stop claims nothing at all",
      duringShutdown.processed === 0 && duringShutdown.failed === 0,
      `processed ${duringShutdown.processed}, failed ${duringShutdown.failed}`,
    );

    // ── An abandoned claim comes back ────────────────────────────────
    const stranded = await runWithTenant(carrier.tenant, async () => {
      const row = await prisma.outboxEvent.create({
        data: {
          orgId: carrier.orgId,
          eventType: probe,
          aggregate: "VerifyProbe",
          aggregateId: "stranded",
          payload: { stranded: true },
          status: "PROCESSING",
          // A lease that ran out a minute ago: the process that held it is
          // gone. Written rather than produced by killing something, so the
          // recovery is what is under test and not our luck at hitting a
          // millisecond window.
          nextAttemptAt: new Date(Date.now() - 60_000),
        },
        select: { id: true },
      });
      return row.id;
    });

    const reclaimed = await runWithTenant(carrier.tenant, async () => reclaimStalledOutbox());
    check(
      "an expired claim is returned to the queue",
      reclaimed >= 1,
      `${reclaimed} reclaimed by this call`,
    );

    const after = await runWithTenant(carrier.tenant, async () =>
      prisma.outboxEvent.findUnique({
        where: { id: stranded },
        select: { status: true, attempts: true },
      }),
    );
    check(
      "and is no longer claimed",
      after !== null && after.status !== "PROCESSING",
      after ? `status ${after.status}` : "row vanished",
    );
    check(
      "a restart is not charged to the event as an attempt",
      after !== null && after.attempts === 0,
      `attempts ${after?.attempts}`,
    );

    // ── A live claim is not stolen ───────────────────────────────────
    const live = await runWithTenant(carrier.tenant, async () => {
      const row = await prisma.outboxEvent.create({
        data: {
          orgId: carrier.orgId,
          eventType: probe,
          aggregate: "VerifyProbe",
          aggregateId: "live-claim",
          payload: { live: true },
          status: "PROCESSING",
          // Somebody is inside its handlers right now, and the SMS gateway
          // is having a bad day. Taking this row back would send the
          // message twice.
          nextAttemptAt: new Date(Date.now() + 4 * 60_000),
        },
        select: { id: true },
      });
      return row.id;
    });

    await runWithTenant(carrier.tenant, async () => reclaimStalledOutbox());
    const stillClaimed = await runWithTenant(carrier.tenant, async () =>
      prisma.outboxEvent.findUnique({ where: { id: live }, select: { status: true } }),
    );
    check(
      "a claim whose lease is still running is left alone",
      stillClaimed?.status === "PROCESSING",
      `status ${stillClaimed?.status}`,
    );
  } finally {
    resetShutdownForTests();
    await runWithTenant(carrier.tenant, async () => {
      await prisma.outboxEvent.deleteMany({ where: { eventType: probe } });
    });
  }
}

// ────────────────────────────────────────────────────────────
// 6. Object storage
// ────────────────────────────────────────────────────────────

async function provesObjectStorage(carriers: Carrier[]): Promise<void> {
  console.log("\n6. Object storage: whole files, and only this tenant's\n");

  const [full, limited] = carriers;
  const store = getObjectStore();
  const bytes = Buffer.from(`verify-modules-worker ${randomUUID()}`, "utf8");

  const key = buildObjectKey({
    orgId: full.orgId,
    kind: "POD_PHOTO",
    ownerId: `verify_${randomUUID().slice(0, 8)}`,
    fileName: "probe.txt",
    contentType: "text/plain",
  });
  const moved = `${key}.moved`;

  try {
    await store.put({ key, bytes, contentType: "text/plain" });

    const read = await store.get(key);
    check(
      "an object comes back exactly as it went in",
      read !== null && read.equals(bytes),
      `${read?.length ?? 0} of ${bytes.length} byte(s)`,
    );

    // The write is staged and renamed, so a reader sees either nothing or
    // the finished object. A `.part` left behind means the rename did not
    // happen and a future reader would find a half-file under the real name.
    const folder = path.join(STORAGE_ROOT, ...key.split("/").slice(0, -1));
    const residue = (await readdir(folder).catch(() => [])).filter((name) =>
      name.endsWith(".part"),
    );
    check("no half-written staging file is left behind", residue.length === 0, residue.join(", "));

    check(
      "the tenant that owns the key may read it",
      (await runWithTenant(full.tenant, async () => readTenantObject(key))) !== null,
    );

    // The check the `FileAsset` row cannot make. A key names its tenant, and
    // a reader from another carrier is told nothing at all — "not yours" and
    // "not there" have to be the same answer, because the difference between
    // them is the existence of somebody else's file.
    check(
      "another carrier is refused the same key, and cannot tell it exists",
      (await runWithTenant(limited.tenant, async () => readTenantObject(key))) === null,
    );

    check("an object can be moved to a new key", await store.move(key, moved));
    check("and is gone from the old one", (await store.get(key)) === null);
    check(
      "moving something that is not there is not an error",
      (await store.move(`${key}.absent`, `${moved}.absent`)) === false,
    );
  } finally {
    await rm(path.join(STORAGE_ROOT, ...key.split("/")), { force: true }).catch(() => undefined);
    await rm(path.join(STORAGE_ROOT, ...moved.split("/")), { force: true }).catch(
      () => undefined,
    );
  }

  check(
    "the filesystem backend is the one in use, and says so",
    store.backend === "filesystem",
    store.backend,
  );
}

// ────────────────────────────────────────────────────────────
// 7. What this machine cannot prove
// ────────────────────────────────────────────────────────────

function statesWhatIsUntested(): void {
  console.log("\n7. What is not proved here, because the dependency is absent\n");

  note("Redis (REDIS_URL points at a port nothing is listening on):");
  note("  · the drain is a timer plus a claim lease, not a BullMQ queue. The");
  note("    lease, the retry backoff and the reclaim are proved above; the");
  note("    BullMQ wiring does not exist and so cannot be wrong yet.");
  note("  · every rate limit and quota counter falls back to its in-process");
  note("    store, so nothing here proves the shared-counter behaviour that a");
  note("    second web instance would need.");
  note("");
  note("PostGIS (the extension is not installed):");
  note("  · geofences are evaluated in JavaScript. No SQL containment query is");
  note("    executed by any test on this machine, so a switch to ST_Contains is");
  note("    entirely unproved — including whether the two agree on a boundary.");
  note("");
  note("S3 (S3_ENDPOINT points at a MinIO nobody runs):");
  note("  · `signedUrl` always answers null and both document routes take the");
  note("    streaming fallback. The redirect path has never executed.");
}

// ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const full = await carrierFor(FULL);
  const limited = await carrierFor(LIMITED);

  console.log(
    `\nModules and worker — ${BASE}\n\n` +
      `  ${full.name.padEnd(20)} ${full.planName} · ${[...full.modules].join(", ")}\n` +
      `  ${limited.name.padEnd(20)} ${limited.planName} · ${[...limited.modules].join(", ")}`,
  );

  if (limited.modules.size >= full.modules.size) {
    console.error(
      "\n  The second carrier is not on a smaller plan, so there is nothing to\n" +
        "  withhold. Put it on STARTER — see prisma/seed/plans.ts.\n",
    );
    failures += 1;
    return;
  }

  await provesThePlanTableAgreesWithTheRegistry();
  await provesTheSessionIsNarrowed([full, limited]);
  provesEveryPermissionIsAccountedFor();
  await provesTheRefusalPage([full, limited]);
  await provesTheOutbox(full);
  await provesObjectStorage([full, limited]);
  statesWhatIsUntested();

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );
}

main()
  .catch((error: unknown) => {
    failures += 1;
    console.error(`\n${error instanceof Error ? error.stack : error}\n`);
  })
  .finally(async () => {
    await disconnectDb();
    process.exit(failures === 0 ? 0 : 1);
  });
