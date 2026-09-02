/**
 * Phase 9 — the tenancy boundary and the operator console, as an attacker
 * would ask about them.
 *
 *   npx tsx scripts/verify-tenancy-console.ts [--base http://localhost:3010]
 *                                             [--a city-logistics] [--b acme]
 *
 * `verify-tenant-isolation.ts` proves one carrier cannot reach another's
 * rows. It says nothing about the *third* population — the platform
 * operator — and that is the population with a door into every carrier.
 * This is the other half:
 *
 *   1. The host is the boundary, in both directions. A carrier's subdomain
 *      cannot serve the console; the console's host cannot serve a carrier.
 *   2. Three cookies, three audiences, three tables. None of them is
 *      accepted anywhere but its own.
 *   3. A refusal must not answer the question it is refusing. "That tenant
 *      exists but you may not have it" is a leak with a 403 on it.
 *   4. Impersonation, driven end to end over HTTP: opened, entered,
 *      announced, bounded, ended — and refused when replayed on a carrier
 *      it was not opened against.
 *   5. What provisioning copies, and what it must never.
 *
 * ── Two things it deliberately does not do ──────────────────────────────
 *
 * It does not assert on how much data is in the database. `verify-reweigh`
 * once compared a `count()` against a `findMany({ take: 6 })` and started
 * reporting a defect the day the table held six rows. Every count below is
 * either zero, one, or a comparison of two numbers read the same way.
 *
 * It does not drive a browser or type a password into a form. Sessions are
 * minted exactly as the application mints them — same secret, same claims,
 * same audience — which is what `smoke-platform.ts` does and for the same
 * reason.
 */
import "dotenv/config";
import { SignJWT } from "jose";
import { basePrisma, disconnectDb } from "../src/lib/prisma-base";
import { runWithTenant } from "../src/lib/tenant/context";
import { parseTenantHost, isPlatformHost, RESERVED_SUBDOMAINS } from "../src/lib/tenant/host";
import { trustedForwardedHost } from "../src/lib/tenant/resolve";
import { capabilitiesFor, platformCan, type PlatformCapability } from "../src/lib/platform/roles";
import { visibleConsoleNav } from "../src/components/platform/nav";
import {
  HANDOFF_AUDIENCE,
  HANDOFF_TTL_SECONDS,
  IMPERSONATION_COOKIE,
  SESSION_AUDIENCE,
  grantIsUsable,
  grantMayWrite,
  impersonationContext,
  readGrantToken,
  signGrantToken,
} from "../src/lib/platform/impersonation-credential";
import {
  endGrant,
  enterUrlFor,
  openGrant,
} from "../src/lib/platform/impersonation";
import {
  copiedNotificationTemplate,
  copiedNumberSeries,
  copiedPincode,
  validateProvisionShape,
  type ProvisionInput,
} from "../src/lib/platform/provisioning";
import { recordAudit } from "../src/server/services/audit";
import { assertObjectKeyBelongsTo, buildObjectKey } from "../src/lib/storage/keys";
import { CookieJar, hostFetch, type HostResponse } from "./host-fetch";
import type { PlatformOperator } from "../src/lib/platform/session";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "true");
}

const BASE = args.get("base") ?? "http://localhost:3010";
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";

const SLUG_A = args.get("a") ?? "city-logistics";
const SLUG_B = args.get("b") ?? "acme-freight";

/** The console is the bare platform domain; `admin.<root>` answers too. */
const CONSOLE_HOST = ROOT;
const CONSOLE_ALIAS = `admin.${ROOT}`;

const OPS_MOBILE = process.env.SMOKE_ADMIN_MOBILE ?? "9999999999";
const OPS_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? "Admin@123";

let failures = 0;
let passes = 0;
/** A probe that could not be run at all. A hole in the evidence, not a pass. */
let skips = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function skip(label: string, why: string) {
  skips += 1;
  console.log(`  [SKIP] ${label} — ${why}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

type Carrier = {
  id: string;
  slug: string;
  name: string;
  subdomain: string;
  host: string;
  status: string;
};

async function carrier(slug: string): Promise<Carrier> {
  const org = await basePrisma.organization.findFirst({
    where: { OR: [{ slug }, { subdomain: slug }] },
    select: { id: true, slug: true, name: true, subdomain: true, status: true },
  });
  if (!org) {
    throw new Error(
      `No organisation matches "${slug}". Provision one:\n` +
        `  npx tsx scripts/provision-tenant.ts --slug ${slug} --name "${slug}" --subdomain ${slug}`,
    );
  }
  return { ...org, host: `${org.subdomain}.${ROOT}` };
}

/**
 * A fixture read *inside* one named carrier.
 *
 * `basePrisma` is unextended, so row-level security is the only thing
 * standing between it and every tenant's rows — and with no `app.org_id`
 * on the session it fails closed and returns nothing at all. A fixture
 * lookup that comes back empty for that reason looks exactly like "the
 * user does not exist", which is how this script quietly skipped its most
 * important section the first time it ran. Same mechanism, and the same
 * transaction-local setting, as `readingTenant()` in `lib/platform/db.ts`.
 */
function insideTenant<T>(orgId: string, fn: (tx: typeof basePrisma) => Promise<T>): Promise<T> {
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, TRUE)`;
    return fn(tx as unknown as typeof basePrisma);
  });
}

/** Mirrors `startPlatformSession` — same secret, same claims, same audience. */
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

/** Signs in to a carrier's own app, the way `verify-tenant-isolation` does. */
async function signInAsStaff(host: string): Promise<CookieJar | null> {
  const jar = new CookieJar();
  const csrf = await hostFetch(host, PORT, "/api/auth/csrf", { cookie: jar.header() });
  jar.absorb(csrf);

  let csrfToken: string;
  try {
    csrfToken = (JSON.parse(csrf.body) as { csrfToken: string }).csrfToken;
  } catch {
    return null;
  }

  const response = await hostFetch(host, PORT, "/api/auth/callback/password", {
    method: "POST",
    cookie: jar.header(),
    body: new URLSearchParams({
      mobile: OPS_MOBILE,
      password: OPS_PASSWORD,
      csrfToken,
      callbackUrl: `http://${host}:${PORT}/dashboard`,
    }).toString(),
  });
  jar.absorb(response);

  return (response.location ?? "").includes("error") ? null : jar;
}

/** A page actually rendered, rather than a guard sending us somewhere. */
function rendered(response: HostResponse, needle: string): boolean {
  return response.status === 200 && response.body.includes(needle);
}

// ────────────────────────────────────────────────────────────
// 1 · The host is the boundary, in both directions
// ────────────────────────────────────────────────────────────

/**
 * Every console path, asked for on a carrier's own subdomain.
 *
 * `requirePlatformHost()` sits above the sign-in page rather than beside
 * it, and this is why: a console login form rendered on `acme.<root>` is
 * already a leak whatever it does with the credentials.
 */
const CONSOLE_PATHS = [
  "/platform",
  "/platform/login",
  "/platform/tenants",
  "/platform/tenants/new",
  "/platform/plans",
  "/platform/audit",
  "/platform/impersonation",
  "/platform/password",
];

async function probeHostBoundary(a: Carrier, b: Carrier) {
  section("The host is the boundary");

  for (const path of CONSOLE_PATHS) {
    const response = await hostFetch(a.host, PORT, path);
    check(
      `${a.host} refuses ${path}`,
      response.status === 404,
      response.status === 404 ? "" : `HTTP ${response.status}`,
    );
  }

  // And the refusal must not become a tenant directory. The console's 404
  // is rendered inside the carrier's own root layout, so its own name is
  // expected there; another carrier's is not.
  const leak = await hostFetch(a.host, PORT, "/platform/tenants");
  check(
    `that refusal names no other carrier`,
    !leak.body.includes(b.name) && !leak.body.includes(b.subdomain),
    leak.body.includes(b.name) ? `the body contains "${b.name}"` : "",
  );

  const dashboard = await hostFetch(CONSOLE_HOST, PORT, "/dashboard");
  check(
    `${CONSOLE_HOST} serves no carrier's app`,
    dashboard.status === 404,
    `HTTP ${dashboard.status}`,
  );

  for (const host of [CONSOLE_HOST, CONSOLE_ALIAS]) {
    const response = await hostFetch(host, PORT, "/platform/login");
    check(
      `the console renders on ${host}`,
      rendered(response, "Operator sign in"),
      response.status === 200 ? "" : `HTTP ${response.status}`,
    );
  }

  const unknown = await hostFetch(`nosuchcarrier.${ROOT}`, PORT, "/login");
  check(
    "a host no carrier answers to is a 404, not a default tenant",
    unknown.status === 404,
    `HTTP ${unknown.status}`,
  );
  check(
    "and that 404 does not name a carrier that does exist",
    !unknown.body.includes(a.name) || a.name === "City Logistics",
    "",
  );

  // The regression this must never make again: `X-Forwarded-Host` is
  // honoured only when TRUSTED_PROXY_HOPS says a proxy is in front. With
  // no proxy configured, anyone who can reach the app directly would
  // otherwise name whichever carrier they liked.
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);
  const spoofed = await hostFetch(a.host, PORT, "/login", {
    headers: { "x-forwarded-host": b.host },
  });
  if (hops > 0) {
    skip(
      "a spoofed X-Forwarded-Host cannot move the tenant",
      `TRUSTED_PROXY_HOPS is ${hops}, so the header is trusted here by ` +
        "configuration; this probe only means anything with no proxy in front",
    );
  } else {
    check(
      "a spoofed X-Forwarded-Host cannot move the tenant",
      spoofed.body.includes(a.name) && !spoofed.body.includes(b.name),
      spoofed.body.includes(b.name)
        ? `naming ${b.host} in the header served ${b.name}`
        : "",
    );
  }

  // Which entry of an `X-Forwarded-Host` chain is believed. The leftmost
  // is the one a client can write, so it is never the answer; the chain is
  // counted from the right by the configured hop count, as
  // `deriveClientIp` counts `X-Forwarded-For`.
  check(
    "with no proxy configured, no forwarded host is believed at all",
    trustedForwardedHost(`${b.host}, ${a.host}`, 0) === null,
  );
  check(
    "behind one proxy, the entry that proxy wrote is used — not the one a client prepended",
    trustedForwardedHost(`${b.host}, ${a.host}`, 1) === a.host &&
      trustedForwardedHost(a.host, 1) === a.host,
    trustedForwardedHost(`${b.host}, ${a.host}`, 1) ?? "null",
  );
  check(
    "behind two, a chain too short to have come through them is refused",
    trustedForwardedHost(a.host, 2) === null &&
      trustedForwardedHost(`${b.host}, ${a.host}`, 2) === b.host,
  );

  // The parsing half of the same boundary, without a request.
  check(
    "the bare platform domain resolves to no carrier",
    parseTenantHost(ROOT, ROOT) === null && isPlatformHost(ROOT, ROOT),
  );
  const reserved = [...RESERVED_SUBDOMAINS].filter(
    (label) => parseTenantHost(`${label}.${ROOT}`, ROOT) !== null,
  );
  check(
    "no reserved label can ever resolve to a carrier",
    reserved.length === 0,
    reserved.join(", "),
  );
  check(
    "`admin.<root>` is the console and never a carrier",
    isPlatformHost(CONSOLE_ALIAS, ROOT) && parseTenantHost(CONSOLE_ALIAS, ROOT) === null,
  );
}

// ────────────────────────────────────────────────────────────
// 2 · Three populations, three cookies
// ────────────────────────────────────────────────────────────

async function probeSessionPopulations(a: Carrier, operatorId: string) {
  section("An operator is not a carrier user, and a carrier user is not an operator");

  const operator = await operatorCookie(operatorId);

  // The cookie is host-only and path-scoped, so a browser would never send
  // it here at all. Sending it by hand is the point: the refusal has to be
  // in the code, not only in the cookie's attributes.
  const asOperator = await hostFetch(a.host, PORT, "/dashboard", { cookie: operator });
  check(
    "the operator's own cookie, carried to a carrier's host, signs nobody in",
    asOperator.status !== 200,
    `HTTP ${asOperator.status}${asOperator.location ? ` → ${asOperator.location}` : ""}`,
  );

  // The nastier version: the operator's subject inside the *tenant's*
  // cookie name. `getCurrentUser()` refuses a `platform:` subject rather
  // than looking it up, so this must resolve to nobody rather than to a
  // user whose id happens not to exist.
  const smuggled = await hostFetch(a.host, PORT, "/dashboard", {
    cookie: `authjs.session-token=${operator.split("=")[1]}`,
  });
  check(
    "an operator subject smuggled into the tenant cookie signs nobody in",
    smuggled.status !== 200,
    `HTTP ${smuggled.status}`,
  );

  const jar = await signInAsStaff(a.host);
  if (!jar) {
    skip(
      "a signed-in carrier user cannot reach the console",
      `could not sign in as ${OPS_MOBILE} on ${a.host}`,
    );
  } else {
    const control = await hostFetch(a.host, PORT, "/dashboard", { cookie: jar.header() });
    check(
      `control: ${OPS_MOBILE} is signed in on ${a.host}`,
      control.status === 200,
      `HTTP ${control.status}`,
    );

    for (const host of [CONSOLE_HOST, CONSOLE_ALIAS]) {
      const response = await hostFetch(host, PORT, "/platform", { cookie: jar.header() });
      const refused =
        response.status !== 200 ||
        !response.body.includes("Operator console");
      check(
        `a carrier's staff cookie opens nothing on ${host}`,
        refused,
        refused ? "" : "the console rendered",
      );
    }
  }
}

// ────────────────────────────────────────────────────────────
// 3 · A refusal that answers the question is not a refusal
// ────────────────────────────────────────────────────────────

async function probeRefusalsSayNothing(a: Carrier, b: Carrier) {
  section("Refusals tell a stranger nothing");

  // A tenant that exists and one that does not must be refused identically
  // to somebody who is not signed in. Anything else turns the console into
  // a way to ask "is Acme a customer of yours?".
  //
  // Carrier B is the one probed, not A: the console runs on the platform's
  // own domain and renders the *product's* name in its chrome, which on
  // this deployment is also the first carrier's name. Asking about the
  // other one is the only way the question is really being asked.
  const real = await hostFetch(CONSOLE_HOST, PORT, `/platform/tenants/${b.id}`);
  const fake = await hostFetch(CONSOLE_HOST, PORT, "/platform/tenants/cl0000000000000000000000");
  check(
    "signed out, a real tenant id and an invented one are refused the same way",
    real.status === fake.status &&
      (real.location ?? "").split("?")[0] === (fake.location ?? "").split("?")[0],
    `real ${real.status} → ${real.location ?? "-"}, invented ${fake.status} → ${fake.location ?? "-"}`,
  );
  check(
    "and neither answer names the tenant",
    !real.body.includes(b.name) && !real.body.includes(b.subdomain),
    real.body.includes(b.name) ? `the body contains "${b.name}"` : "",
  );

  // The same question of the other dynamic console page. `generateMetadata`
  // runs before the page's own guard, so an unguarded read there lands in
  // the `<head>` of the refusal itself.
  const plan = await basePrisma.tenantPlan.findFirst({ select: { id: true, name: true } });
  if (plan) {
    const planPage = await hostFetch(CONSOLE_HOST, PORT, `/platform/plans/${plan.id}`);
    check(
      "nor does the refusal on a plan name the plan",
      !planPage.body.includes(plan.name),
      planPage.body.includes(plan.name) ? `the body contains "${plan.name}"` : "",
    );
  } else {
    skip("nor does the refusal on a plan name the plan", "no plan exists on this database");
  }

  // The hand-off route is the one place a stranger can arrive with a
  // credential. Every failure — forged, expired, ended, wrong carrier —
  // must look the same.
  const forged = await hostFetch(a.host, PORT, "/impersonation/enter?t=not-a-token");
  const missing = await hostFetch(a.host, PORT, "/impersonation/enter");
  check(
    "a forged hand-off token and a missing one are refused identically",
    forged.status === 404 && missing.status === 404 && forged.body === missing.body,
    `${forged.status} / ${missing.status}`,
  );
  check(
    "and neither sets a cookie",
    forged.setCookie.length === 0 && missing.setCookie.length === 0,
  );
}

// ────────────────────────────────────────────────────────────
// 4 · What each operator role may do
// ────────────────────────────────────────────────────────────

function probeCapabilityMatrix() {
  section("The operator capability matrix");

  const mustHold: Array<[string, PlatformCapability, boolean]> = [
    ["OWNER", "tenant.lifecycle", true],
    ["OWNER", "impersonate", true],
    ["SUPPORT", "impersonate", true],
    ["SUPPORT", "tenant.write", false],
    ["SUPPORT", "tenant.lifecycle", false],
    ["SUPPORT", "plan.write", false],
    ["BILLING", "impersonate", false],
    // Not a billing question who suspended whom, or which support session
    // was opened against which carrier.
    ["BILLING", "audit.read", false],
    ["VIEWER", "impersonate", false],
    ["VIEWER", "tenant.write", false],
    ["VIEWER", "onboarding.write", false],
  ];

  const wrong = mustHold.filter(
    ([role, capability, expected]) =>
      platformCan(role as never, capability) !== expected,
  );
  check(
    "each role holds exactly the capabilities it is meant to",
    wrong.length === 0,
    wrong.map(([r, c, e]) => `${r} ${e ? "should" : "must not"} hold ${c}`).join("; "),
  );

  // Hiding is presentation, not protection — but a link a role can never
  // open is still a bug, and the two halves must agree.
  for (const role of ["VIEWER", "BILLING"] as const) {
    const shown = visibleConsoleNav(capabilitiesFor(role)).map((item) => item.href);
    check(
      `the console nav offers ${role} no door it would be refused at`,
      !shown.includes("/platform/impersonation") &&
        (role !== "BILLING" || !shown.includes("/platform/audit")),
      shown.join(" "),
    );
  }
}

// ────────────────────────────────────────────────────────────
// 5 · Provisioning: the shape of a carrier's world, never its business
// ────────────────────────────────────────────────────────────

/**
 * Tables whose contents are operational or commercial. A copied one is
 * somebody else's prices billed to somebody else's customer, or another
 * company's hub routing this one's deliveries.
 */
const MUST_NEVER_COPY = [
  "Customer",
  "CustomerAddress",
  "CustomerContact",
  "CustomerUser",
  "RateCard",
  "RateCardVersion",
  "RateRule",
  "Vehicle",
  "Driver",
  "Shipment",
  "Invoice",
  "ApiKey",
  "TenantCredential",
  "Route",
  "ChargeRule",
];

function probeProvisioningRules() {
  section("Provisioning copies masters and nothing else");

  // The pincode carries the geography and drops the branch that serves it:
  // `servingBranchId` names one of the *template's* branches, and the
  // template's branch network is not copied.
  const pin = copiedPincode(
    {
      code: "110001",
      cityId: "old-city",
      areaName: "CP",
      latitude: null,
      longitude: null,
      isServiceable: true,
      isOda: false,
      servingBranchId: "template-branch",
    },
    "new-org",
    "new-city",
  );
  check(
    "a copied pincode does not carry the template's serving branch",
    pin.servingBranchId === null && pin.cityId === "new-city" && pin.orgId === "new-org",
    JSON.stringify({ servingBranchId: pin.servingBranchId, cityId: pin.cityId }),
  );

  // A number series is copied as a shape, never as a position: the first
  // consignment note a new carrier prints must not carry a number the
  // template has already printed on a document a customer keeps.
  const lr = copiedNumberSeries(
    {
      document: "LR",
      pattern: "{PREFIX}{YY}{SEQ}",
      prefix: "OLD",
      padding: 6,
      resetPolicy: "FINANCIAL_YEAR",
      currentValue: 4821,
      periodKey: "2026",
      isActive: true,
    },
    "new-org",
    "NEW",
  );
  check(
    "a copied LR series starts at zero, under the new carrier's own prefix",
    lr.currentValue === 0 && lr.periodKey === null && lr.prefix === "NEW" && lr.branchId === null,
    JSON.stringify({ currentValue: lr.currentValue, prefix: lr.prefix, periodKey: lr.periodKey }),
  );

  // A DLT registration belongs to one company and takes weeks to obtain.
  // An inherited id is rejected at the gateway, and a gateway rejection
  // looks exactly like a successful queue from inside the app.
  const sms = copiedNotificationTemplate(
    {
      code: "DELIVERY_OTP",
      channel: "SMS",
      eventType: "delivery.otp",
      name: "Delivery OTP",
      language: "en",
      subject: null,
      body: "Your OTP is {otp}",
      variables: ["otp"],
      recipientKind: "CONSIGNEE",
      dltTemplateId: "1207160000000000000",
      dltSenderId: "TMPLTE",
      isActive: true,
    },
    "new-org",
  );
  check(
    "a copied SMS template arrives inactive with no DLT registration on it",
    sms.dltTemplateId === null && sms.dltSenderId === null && sms.isActive === false,
    JSON.stringify({ dlt: sms.dltTemplateId, sender: sms.dltSenderId, active: sms.isActive }),
  );

  const email = copiedNotificationTemplate(
    {
      code: "INVOICE_READY",
      channel: "EMAIL",
      eventType: "invoice.ready",
      name: "Invoice",
      language: "en",
      subject: "Your invoice",
      body: "…",
      variables: [],
      recipientKind: "CONSIGNOR",
      isActive: true,
    },
    "new-org",
  );
  check(
    "an email template, which has no such registration, is copied live",
    email.isActive === true,
  );

  // The subdomain rules a carrier is held to, at the one place a new one
  // is named.
  const base: ProvisionInput = {
    name: "Probe",
    legalName: null,
    slug: "probe-carrier",
    subdomain: "probe-carrier",
    lrPrefix: "PC",
    planId: null,
    templateOrgId: "t",
    branch: {
      code: "HO",
      name: "Head office",
      city: "Delhi",
      address: "1 Road",
      pincode: "110001",
      phone: null,
    },
    owner: { name: "Owner", mobile: "9000000000", email: null },
  };
  check("a well-formed carrier passes validation", validateProvisionShape(base) === null);

  const grabs = ["admin", "platform", "api", "www"].filter(
    (label) => validateProvisionShape({ ...base, subdomain: label, slug: label }) === null,
  );
  check(
    "no carrier can be provisioned onto a reserved label",
    grabs.length === 0,
    grabs.join(", "),
  );
  check(
    "nor onto a two-letter subdomain",
    validateProvisionShape({ ...base, subdomain: "ab", slug: "ab" }) !== null,
  );
}

/**
 * The historical evidence, from the audit rows provisioning writes itself.
 *
 * `tenant.provision` records the row counts it copied, table by table. That
 * makes every provisioning that has ever happened on this database its own
 * assertion — without depending on how many of them there are, or on
 * anything a tenant has done since.
 */
async function probeProvisioningHistory() {
  const rows = await basePrisma.platformAuditLog.findMany({
    where: { action: "tenant.provision" },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { id: true, targetOrgSlug: true, after: true },
  });

  if (rows.length === 0) {
    skip(
      "no provisioning has copied anything operational or commercial",
      "no tenant.provision row exists on this database to check",
    );
    return;
  }

  const offences: string[] = [];
  for (const row of rows) {
    const after = row.after as { copied?: Record<string, number> } | null;
    const copied = after?.copied ?? {};
    for (const table of MUST_NEVER_COPY) {
      if ((copied[table] ?? 0) > 0) {
        offences.push(`${row.targetOrgSlug}: ${copied[table]} × ${table}`);
      }
    }
    // Exactly one of each, built from the form rather than copied: the
    // head office and the first owner.
    if (copied.Branch !== undefined && copied.Branch !== 1) {
      offences.push(`${row.targetOrgSlug}: ${copied.Branch} branches`);
    }
    if (copied.User !== undefined && copied.User !== 1) {
      offences.push(`${row.targetOrgSlug}: ${copied.User} users`);
    }
  }

  check(
    `no provisioning has copied anything operational or commercial (${rows.length} checked)`,
    offences.length === 0,
    offences.join("; "),
  );
}

// ────────────────────────────────────────────────────────────
// 6 · Impersonation, end to end
// ────────────────────────────────────────────────────────────

/** The credential rules, without a database or a request. */
function probeGrantRules(orgA: string, orgB: string) {
  section("What a support grant is worth on its own");

  const live = {
    id: "g1",
    orgId: orgA,
    platformAdminId: "admin",
    asUserId: "u1",
    allowWrites: true,
    expiresAt: new Date(Date.now() + 60_000),
    endedAt: null,
  };

  check(
    "a grant opened against one carrier is worthless on another's host",
    grantIsUsable(live, orgA) && !grantIsUsable(live, orgB),
  );
  check(
    "an ended grant is worthless on its own host",
    !grantIsUsable({ ...live, endedAt: new Date() }, orgA),
  );
  check(
    "an expired grant is worthless on its own host",
    !grantIsUsable({ ...live, expiresAt: new Date(Date.now() - 1) }, orgA),
  );

  // `allowWrites` is necessary and not sufficient: a write has to be
  // attributable, and the only actor an impersonated write can name is the
  // tenant user the grant adopted.
  check(
    "a tenant-wide grant is read-only however the box was ticked",
    grantMayWrite({ allowWrites: true, asUserId: "u1" }) &&
      !grantMayWrite({ allowWrites: true, asUserId: null }),
  );

  const org = { id: orgA, slug: "a", subdomain: "a", status: "ACTIVE" as const };
  check(
    "a grant against another carrier produces no context at all — not a downgraded one",
    impersonationContext({ ...org, id: orgB }, live) === null,
  );
  check(
    "a suspended carrier stays read-only even for a grant that asked to write",
    impersonationContext({ ...org, status: "SUSPENDED" }, live)?.readOnly === true,
  );
  check(
    "a closed carrier admits no support session at all",
    impersonationContext({ ...org, status: "CLOSED" }, live) === null,
  );
}

async function probeImpersonation(a: Carrier, b: Carrier, actor: PlatformOperator) {
  section("A support session, opened and walked into");

  // One open grant per operator is a rule of the service, so anything left
  // over from a previous run has to go first — and is said out loud, since
  // in a real deployment that row is somebody inside a customer.
  const stale = await basePrisma.impersonationGrant.updateMany({
    where: { platformAdminId: actor.id, endedAt: null, expiresAt: { gt: new Date() } },
    data: { endedAt: new Date(), endedBy: actor.id },
  });
  if (stale.count > 0) {
    console.log(`  [note] ended ${stale.count} grant(s) left open by an earlier run`);
  }

  // The staff member whose view the session adopts: the network admin, who
  // holds the widest set this carrier hands out — so anything withheld
  // below is withheld from the strongest identity available.
  const adopted = await insideTenant(a.id, (tx) =>
    tx.user.findFirst({
      where: { orgId: a.id, mobile: OPS_MOBILE, deletedAt: null },
      select: { id: true, name: true },
    }),
  );
  if (!adopted) {
    skip("the whole support-session flow", `no user ${OPS_MOBILE} in ${a.slug}`);
    return;
  }

  // ── Refusals before anything is opened ──────────────────────────────
  const short = await openGrant(
    { orgId: a.id, reason: "oops", minutes: 30, allowWrites: false, asUserId: null },
    actor,
  );
  check("a grant with no real reason is refused", !short.ok, short.ok ? "" : short.error);

  const long = await openGrant(
    {
      orgId: a.id,
      reason: "TICKET-1 the customer reports a missing consignment",
      minutes: 24 * 60,
      allowWrites: false,
      asUserId: null,
    },
    actor,
  );
  check("a grant longer than the ceiling is refused", !long.ok);

  // The cross-tenant one that matters: adopting a user of another carrier
  // would be a cross-tenant grant wearing exactly the right shape.
  const foreign = await insideTenant(b.id, (tx) =>
    tx.user.findFirst({
      where: { orgId: b.id, deletedAt: null },
      select: { id: true },
    }),
  );
  if (foreign) {
    const wrongUser = await openGrant(
      {
        orgId: a.id,
        reason: `TICKET-2 adopting a user of ${b.slug} inside ${a.slug}`,
        minutes: 15,
        allowWrites: true,
        asUserId: foreign.id,
      },
      actor,
    );
    check(
      "a grant cannot adopt a user belonging to a different carrier",
      !wrongUser.ok,
      wrongUser.ok ? "the grant was opened" : wrongUser.error,
    );
  } else {
    skip("a grant cannot adopt a user belonging to a different carrier", `${b.slug} has no users`);
  }

  // ── The real one ────────────────────────────────────────────────────
  const opened = await openGrant(
    {
      orgId: a.id,
      reason: "VERIFY-TENANCY-CONSOLE probing the support-session boundary",
      minutes: 15,
      allowWrites: true,
      asUserId: adopted.id,
    },
    actor,
  );
  if (!opened.ok) {
    check("a well-formed grant is opened", false, opened.error);
    return;
  }
  check("a well-formed grant is opened", true, `expires ${opened.data.expiresAt.toISOString()}`);

  const second = await openGrant(
    {
      orgId: b.id,
      reason: "VERIFY-TENANCY-CONSOLE a second session while one is open",
      minutes: 15,
      allowWrites: false,
      asUserId: null,
    },
    actor,
  );
  check(
    "the same operator cannot hold two open sessions at once",
    !second.ok,
    second.ok ? "a second grant was opened" : second.error,
  );

  try {
    // The hand-off token is minted here rather than through `enterUrlFor`,
    // which builds an absolute URL from `next/headers` and therefore
    // cannot run outside a request. Same function, same audience, same
    // one-minute life as the console's own link.
    const token = await signGrantToken(opened.data, HANDOFF_AUDIENCE, HANDOFF_TTL_SECONDS);
    if (!token) {
      check("a hand-off token can be minted for an open grant", false);
      return;
    }
    check(
      "the hand-off token names a grant and no identity",
      (await readGrantToken(token, HANDOFF_AUDIENCE)) === opened.data.id,
    );
    check(
      "and does not verify as a session token",
      (await readGrantToken(token, SESSION_AUDIENCE)) === null,
    );

    // Replayed on the wrong carrier's host, before it is spent on the right
    // one. A link minted for A and presented on B must land on a 404 —
    // never on a downgraded session inside B.
    const wrongHost = await hostFetch(
      b.host,
      PORT,
      `/impersonation/enter?t=${encodeURIComponent(token)}`,
    );
    check(
      `the hand-off link is refused on ${b.host}, which it was not opened against`,
      wrongHost.status === 404 && wrongHost.setCookie.length === 0,
      `HTTP ${wrongHost.status}, ${wrongHost.setCookie.length} cookie(s)`,
    );

    // Spent on the right one.
    const entered = await hostFetch(
      a.host,
      PORT,
      `/impersonation/enter?t=${encodeURIComponent(token)}`,
    );
    const cookieLine = entered.setCookie.find((c) => c.startsWith(`${IMPERSONATION_COOKIE}=`));
    check(
      `the hand-off link is spent on ${a.host} for the session cookie`,
      entered.status >= 300 &&
        entered.status < 400 &&
        (entered.location ?? "").includes("/dashboard") &&
        Boolean(cookieLine),
      `HTTP ${entered.status} → ${entered.location ?? "-"}`,
    );
    if (!cookieLine) return;

    check(
      "the session cookie is host-only and reaches every page of this carrier",
      !/;\s*domain=/i.test(cookieLine) &&
        /;\s*path=\/(;|$)/i.test(cookieLine) &&
        /httponly/i.test(cookieLine),
      cookieLine.split(";").slice(1).join(";").trim(),
    );

    const cookie = cookieLine.split(";")[0];

    // ── Inside the carrier's app ──────────────────────────────────────
    const dashboard = await hostFetch(a.host, PORT, "/dashboard", { cookie });
    check(
      "the carrier's app opens for the support session",
      dashboard.status === 200,
      `HTTP ${dashboard.status}`,
    );
    check(
      "and every page of it carries the banner, naming the operator and the reason",
      dashboard.body.includes("Support session") &&
        dashboard.body.includes(actor.name) &&
        dashboard.body.includes("VERIFY-TENANCY-CONSOLE"),
      "",
    );
    check(
      "the banner says the session may write, because this one may",
      dashboard.body.includes("with write access"),
    );
    check(
      "and offers a way out that needs no JavaScript",
      dashboard.body.includes('action="/impersonation/exit"'),
    );

    const anotherPage = await hostFetch(a.host, PORT, "/shipments", { cookie });
    check(
      "the banner is on a second page too, not only the one landed on",
      anotherPage.status !== 200 || anotherPage.body.includes("Support session"),
      `HTTP ${anotherPage.status}`,
    );

    // ── What the session may and may not do ───────────────────────────
    //
    // Everything a support session can do is bounded by the grant — it
    // expires, it is announced, it is marked in the carrier's trail. These
    // three are not, because what they produce outlives the grant: a user,
    // a role grant, an API key.
    const staffJar = await signInAsStaff(a.host);
    const identityPaths: Array<[string, string]> = [
      ["/integrations", "apikey.manage"],
      ["/integrations/api-keys", "apikey.manage"],
    ];

    for (const [path, code] of identityPaths) {
      const asSupport = await hostFetch(a.host, PORT, path, { cookie });
      const refused =
        asSupport.status !== 200 || (asSupport.location ?? "").includes("forbidden");
      check(
        `a support session is refused ${path} (${code})`,
        refused,
        refused ? "" : "it rendered",
      );

      if (staffJar) {
        const asStaff = await hostFetch(a.host, PORT, path, { cookie: staffJar.header() });
        check(
          `control: the same person's own login opens ${path}`,
          asStaff.status === 200,
          `HTTP ${asStaff.status}`,
        );
      }
    }

    const users = await hostFetch(a.host, PORT, "/admin/users", { cookie });
    check(
      "but an ordinary read the adopted user holds still works",
      users.status === 200,
      `HTTP ${users.status}`,
    );

    // ── The carrier can see that it happened ──────────────────────────
    //
    // `AuditLog.userId` is a foreign key into this carrier's own staff
    // table, so an impersonated write can only ever name the adopted user.
    // Without the grant id beside it the trail reads as that person's own
    // work, and the only record of the truth is in a table no tenant can
    // read. Written through the real `recordAudit`, inside the same
    // context `resolveTenant()` hands it during a support session.
    const probeId = `verify-tenancy-console-${Date.now()}`;
    await runWithTenant(
      {
        orgId: a.id,
        slug: a.slug,
        subdomain: a.subdomain,
        status: "ACTIVE",
        source: "impersonation",
        readOnly: false,
        impersonation: { grantId: opened.data.id, platformAdminId: actor.id },
      },
      async () => {
        await recordAudit({
          user: null,
          action: "UPDATE",
          entity: "VerifyTenancyConsole",
          entityId: probeId,
          after: { probe: "impersonated write marking" },
        });
      },
    );

    const marked = await insideTenant(a.id, (tx) =>
      tx.auditLog.findFirst({
        where: { entityId: probeId },
        select: { impersonationGrantId: true },
      }),
    );
    check(
      "a change made during the session is marked in the carrier's own audit trail",
      marked?.impersonationGrantId === opened.data.id,
      marked
        ? `grant on the row: ${marked.impersonationGrantId ?? "none"}`
        : "no audit row was written at all",
    );

    // ── Ending it ─────────────────────────────────────────────────────
    const exit = await hostFetch(a.host, PORT, "/impersonation/exit", {
      method: "POST",
      cookie,
      body: "",
    });
    check(
      "the banner's own button ends the session and returns to the console",
      exit.status === 303 && (exit.location ?? "").includes("/platform/impersonation"),
      `HTTP ${exit.status} → ${exit.location ?? "-"}`,
    );

    const row = await basePrisma.impersonationGrant.findUnique({
      where: { id: opened.data.id },
      select: { endedAt: true },
    });
    check(
      "the grant itself is ended, not merely this browser's cookie",
      row?.endedAt !== null && row?.endedAt !== undefined,
      row?.endedAt ? row.endedAt.toISOString() : "still open",
    );

    // The cookie is still a perfectly valid token. It is the row that
    // decides, on every single request, whether a session exists.
    const afterEnd = await hostFetch(a.host, PORT, "/dashboard", { cookie });
    check(
      "the same cookie, replayed after the grant ended, opens nothing",
      afterEnd.status !== 200 || !afterEnd.body.includes("Support session"),
      `HTTP ${afterEnd.status}`,
    );
  } finally {
    // Whatever happened above, nothing is left open into a customer.
    await basePrisma.impersonationGrant.updateMany({
      where: { platformAdminId: actor.id, endedAt: null },
      data: { endedAt: new Date(), endedBy: actor.id },
    });
  }
}

/**
 * Entering somebody else's grant.
 *
 * Ending another operator's session is a safety valve and is open to
 * anyone with the capability. Entering it is not: a grant names one
 * operator and one reason, and the audit trail is only worth reading if
 * the person inside the tenant is the person the row names.
 */
async function probeGrantOwnership(a: Carrier, actor: PlatformOperator) {
  const other = await basePrisma.platformAdmin.findFirst({
    where: { id: { not: actor.id }, isActive: true, deletedAt: null },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!other) {
    skip(
      "an operator cannot enter another operator's session",
      "only one operator account exists on this database",
    );
    return;
  }

  await basePrisma.impersonationGrant.updateMany({
    where: { platformAdminId: other.id, endedAt: null },
    data: { endedAt: new Date(), endedBy: other.id },
  });

  const theirs = await openGrant(
    {
      orgId: a.id,
      reason: "VERIFY-TENANCY-CONSOLE another operator's session",
      minutes: 10,
      allowWrites: false,
      asUserId: null,
    },
    { id: other.id, name: other.name, email: other.email, role: other.role, mustChangePassword: false },
  );
  if (!theirs.ok) {
    skip("an operator cannot enter another operator's session", theirs.error);
    return;
  }

  try {
    const attempt = await enterUrlFor(theirs.data.id, actor);
    check(
      "an operator cannot enter another operator's session",
      !attempt.ok,
      attempt.ok ? "a hand-off link was issued" : attempt.error,
    );

    const ended = await endGrant(theirs.data.id, actor);
    check(
      "but may end it, which is the safe direction",
      ended.ok,
      ended.ok ? "" : ended.error,
    );
  } finally {
    await basePrisma.impersonationGrant.updateMany({
      where: { platformAdminId: other.id, endedAt: null },
      data: { endedAt: new Date(), endedBy: other.id },
    });
  }
}

// ────────────────────────────────────────────────────────────
// 7 · Object keys carry the tenant
// ────────────────────────────────────────────────────────────

function probeObjectKeys(a: Carrier, b: Carrier) {
  section("Stored objects are partitioned by tenant");

  const key = buildObjectKey({
    orgId: a.id,
    kind: "POD_PHOTO",
    ownerId: "shipment-1",
    fileName: "../../etc/passwd",
    contentType: "image/jpeg",
  });
  check(
    "a new key begins with the tenant and carries nothing of the filename",
    key.startsWith(`${a.id}/`) && !key.includes("..") && key.endsWith(".jpg"),
    key,
  );

  let refused = false;
  try {
    assertObjectKeyBelongsTo(b.id, key);
  } catch {
    refused = true;
  }
  check("and cannot be read by the other carrier", refused);
}

// ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nPhase 9 — tenancy and the operator console — ${BASE}\n`);

  const [a, b] = await Promise.all([carrier(SLUG_A), carrier(SLUG_B)]);
  if (a.id === b.id) {
    throw new Error("Both carriers resolve to the same organisation; there is nothing to prove.");
  }
  console.log(`  carrier A  ${a.slug} → ${a.host}`);
  console.log(`  carrier B  ${b.slug} → ${b.host}`);
  console.log(`  console    ${CONSOLE_HOST} (and ${CONSOLE_ALIAS})`);

  const admin = await basePrisma.platformAdmin.findFirst({
    where: { isActive: true, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!admin) {
    throw new Error(
      "No operator account exists. Create one first:\n" +
        '  npm run platform:admin -- --email you@example.com --name "You"',
    );
  }
  console.log(`  operator   ${admin.email} (${admin.role})`);

  const actor: PlatformOperator = { ...admin, mustChangePassword: false };

  await probeHostBoundary(a, b);
  await probeSessionPopulations(a, admin.id);
  await probeRefusalsSayNothing(a, b);
  probeCapabilityMatrix();
  probeProvisioningRules();
  await probeProvisioningHistory();
  probeGrantRules(a.id, b.id);
  await probeImpersonation(a, b, actor);
  await probeGrantOwnership(a, actor);
  probeObjectKeys(a, b);

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed` +
      (skips > 0 ? `, ${skips} could not be run` : "") +
      ".\n",
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.stack ?? error.message : error}\n`);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
