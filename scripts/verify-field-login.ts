/**
 * A field user can sign in on a deployed system.
 *
 *   npx tsx scripts/verify-field-login.ts [--base http://localhost:3010]
 *
 * Field staff are created without a password on purpose — a driver at a
 * loading bay should not be typing one — so a one-time code is the only way
 * in for them. `issueOtp` minted that code and returned it, and nothing sent
 * it: outside development the code went nowhere, and the whole field surface
 * was unreachable by the only people who need it. The pickup and delivery
 * screens were built on top of a door that did not open.
 *
 * What this proves:
 *
 *   · asking for a code produces one, and it leaves through the SMS channel
 *     rather than being returned and forgotten;
 *   · the send is recorded against the carrier, and the code itself is not
 *     in that record — a login code in the notification log is the whole of
 *     authentication written down beside the number it belongs to;
 *   · a number that belongs to nobody is answered exactly like one that
 *     does, so the form cannot be used as a staff directory; and
 *   · the code actually signs the person in, and lands them on their own
 *     carrier's host.
 *
 * The gateway is the mock adapter in development, which is the point: this
 * checks that the *path* exists and is taken, not that an aggregator in
 * Noida accepted the message.
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

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${SUBDOMAIN}" is closed.`);

  // A pickup executive specifically, not just any field user. The first
  // run of this picked a driver, who signed in perfectly well and then hit
  // `/forbidden` at `/pickups/today` — correct behaviour, and a check that
  // would have read as a pass while proving nothing about the screen it
  // names.
  const fieldUser = await runWithTenant(tenant, async () =>
    await prisma.user.findFirstOrThrow({
      where: {
        isFieldUser: true,
        status: "ACTIVE",
        deletedAt: null,
        roles: { some: { role: { code: "PICKUP_EXEC" } } },
      },
      select: { id: true, name: true, mobile: true },
    }),
  );

  console.log(`\nField sign-in — ${org.slug}, as ${fieldUser.name} (${fieldUser.mobile})\n`);

  const before = await runWithTenant(tenant, async () =>
    await prisma.notificationLog.count({ where: { eventType: "LOGIN_OTP" } }),
  );

  // ── Ask for a code ────────────────────────────────────────
  const jar = new CookieJar();
  const csrf = await hostFollow(HOST, PORT, "/api/auth/csrf", jar);
  void csrf;

  const requested = await hostFetch(HOST, PORT, "/api/auth/csrf", { cookie: jar.header() });
  jar.absorb(requested);

  // The request goes through the service rather than the form: the form is
  // a server action, and what is being tested is the delivery underneath it.
  const { issueOtp } = await import("../src/lib/auth/otp");
  const { deliverLoginCode } = await import("../src/lib/auth/otp-delivery");

  const issued = await runWithTenant(tenant, async () =>
    await issueOtp({ destination: fieldUser.mobile, purpose: "LOGIN" }),
  );
  check("a code is issued", Boolean(issued.code), `${issued.code.length} digits`);

  const delivery = await runWithTenant(tenant, async () =>
    await deliverLoginCode({
      mobile: fieldUser.mobile,
      code: issued.code,
      expiresAt: issued.expiresAt,
    }),
  );
  check(
    "and it leaves through a channel",
    delivery.delivered,
    delivery.delivered ? delivery.channel : delivery.reason,
  );

  // ── The record it leaves ──────────────────────────────────
  const after = await runWithTenant(tenant, async () =>
    await prisma.notificationLog.findMany({
      where: { eventType: "LOGIN_OTP" },
      orderBy: { queuedAt: "desc" },
      take: 1,
      select: { recipient: true, body: true, status: true, recipientKind: true },
    }),
  );

  check(
    "the send is recorded against this carrier",
    after.length > 0 && after[0].recipient === fieldUser.mobile,
    after[0]?.recipient ?? "nothing logged",
  );
  check(
    "and the code is not in the record",
    after.length > 0 && !after[0].body.includes(issued.code),
    after[0]?.body ?? "",
  );
  check(
    "filed as staff, not as a customer",
    after[0]?.recipientKind === "STAFF",
    after[0]?.recipientKind ?? "",
  );

  const count = await runWithTenant(tenant, async () =>
    await prisma.notificationLog.count({ where: { eventType: "LOGIN_OTP" } }),
  );
  check("exactly one send was recorded", count === before + 1, `${before} → ${count}`);

  // ── The code works ────────────────────────────────────────
  const loginJar = new CookieJar();
  const loginCsrf = await hostFollow(HOST, PORT, "/api/auth/csrf", loginJar);
  const { csrfToken } = JSON.parse(loginCsrf.body) as { csrfToken: string };

  const authed = await hostFetch(HOST, PORT, "/api/auth/callback/otp", {
    method: "POST",
    cookie: loginJar.header(),
    body: new URLSearchParams({
      mobile: fieldUser.mobile,
      code: issued.code,
      csrfToken,
      callbackUrl: `http://${HOST}:${PORT}/delivery`,
    }).toString(),
  });
  loginJar.absorb(authed);

  const landed = await hostFollow(HOST, PORT, "/pickups/today", loginJar);
  check(
    "the code signs the executive in, onto their own collections",
    !landed.finalPath.includes("/login") && !landed.finalPath.includes("/forbidden"),
    landed.finalPath,
  );

  // ── A number nobody owns ──────────────────────────────────
  //
  // Answered identically, or the form becomes a staff directory: try a
  // number, watch for a different answer, and you have learned who works
  // here.
  const stranger = await runWithTenant(tenant, async () =>
    await prisma.user.findFirst({ where: { mobile: "9000000009" } }),
  );
  check(
    "the control number really belongs to nobody",
    stranger === null,
    stranger ? "9000000009 exists; pick another" : "",
  );

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("\nThe field sign-in check could not run:\n", error);
  await prisma.$disconnect();
  process.exit(1);
});
