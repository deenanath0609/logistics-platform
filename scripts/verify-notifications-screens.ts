/**
 * The notification screens, driven over HTTP as the people who read them.
 *
 *   npm run worker                                   # in another terminal
 *   npx tsx scripts/verify-notifications-screens.ts [--base http://localhost:3010]
 *
 * `verify-notifications.ts` proves the pipeline: an event goes in, a row
 * comes out, a replay does not send twice. This proves the other half —
 * that a person can find out what was sent, that they are told the truth
 * about it, and that they cannot see somebody else's.
 *
 * Three questions it exists to settle, all of which were answered wrongly
 * before it was written:
 *
 *  1. **Why is every SMS template off?** It is deliberate — DLT registration
 *     takes one to three weeks per carrier and an unregistered template is
 *     dropped by the operator without a delivery report. That was true and
 *     invisible: nothing on the screen said it, so the only way to learn it
 *     was to read the seed. Asserted here as rendered text.
 *  2. **Does a SENT row mean anything?** Not today. Every adapter in the
 *     tree is either the mock, which succeeds and transmits nothing, or a
 *     provider whose client has not been written, which throws. A send log
 *     of green ticks is the expected state and has to say so on its face.
 *  3. **Who may read it?** The send log carries consignee numbers and the
 *     text of every message. It had no branch scoping at all.
 *
 * Nothing here asserts against a whole-table count. Every check is scoped
 * to one record, reached through the search box, for the reason
 * `verify-reweigh.ts` records: an assertion that depends on how much data
 * the database holds starts failing on a product that is fine.
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
const PASSWORD = args.get("password") ?? "Admin@123";

/** The send log's actual reader: network scope, `master.read`, no manage. */
const SUPPORT_MOBILE = args.get("support") ?? "9999900011";
/** Holds `master.manage`, so the editing controls are theirs. */
const ADMIN_MOBILE = args.get("admin") ?? "9999999999";
/** Hub operators — one branch each, and `master.read` between them. */
const BRANCH_MOBILES = ["9222000003", "9444000003", "9333000003", "9111000003"];
/** A delivery agent holds no `master.read` at all. */
const AGENT_MOBILE = args.get("agent") ?? "9111000006";

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
 * A page, retried briefly.
 *
 * The dev server answers with a shell while it compiles a route, so the
 * first request for a screen nobody has opened yet returns 200 and none of
 * the content. Retrying on a marker the finished page always carries is the
 * difference between a real failure and a cold start.
 */
async function page(
  jar: CookieJar,
  path: string,
  marker: string,
  attempts = 6,
): Promise<{ status: number; body: string; finalPath: string }> {
  let last = { status: 0, body: "", finalPath: path };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await hostFollow(HOST, PORT, path, jar);
    last = {
      status: response.status,
      body: response.body,
      finalPath: response.finalPath,
    };
    if (response.body.includes(marker)) return last;
    // A redirect away from the route is an answer, not a cold start.
    if (response.finalPath !== path && !response.finalPath.startsWith(path)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  return last;
}

/**
 * `1–4 of 4` — the counter the list is headed by.
 *
 * The comments have to come out first. React server-renders
 * `{from}–{to} of {total}` as four text nodes separated by `<!-- -->`
 * markers, so a regex over the raw HTML matches nothing and every check
 * built on it quietly turns into "there was no counter" — which is exactly
 * what a missing counter looks like.
 */
function paginationTotal(body: string): number | null {
  const match = body.replaceAll("<!-- -->", "").match(/\d+–\d+ of (\d+)/);
  return match ? Number(match[1]) : null;
}

/** How many log rows the page actually drew, counted by their LR link. */
function renderedRows(body: string, lrNumber: string): number {
  return body.split(`>${lrNumber}<`).length - 1;
}

type Probe = {
  logId: string;
  lrNumber: string;
  recipient: string;
  branchIds: string[];
};

async function main() {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${SUBDOMAIN}" is closed.`);

  console.log(`\nNotification screens — ${org.slug}, over ${BASE} as ${HOST}\n`);

  // ── What the database says, so the screens can be held to it ──
  const facts = await runWithTenant(tenant, async () => {
    const templateTotal = await prisma.notificationTemplate.count();
    const smsTotal = await prisma.notificationTemplate.count({
      where: { channel: "SMS" },
    });
    const smsInactive = await prisma.notificationTemplate.count({
      where: { channel: "SMS", isActive: false },
    });
    const smsWithDlt = await prisma.notificationTemplate.count({
      where: { channel: "SMS", dltTemplateId: { not: null } },
    });
    const activeTotal = await prisma.notificationTemplate.count({
      where: { isActive: true },
    });
    const activeSms = await prisma.notificationTemplate.count({
      where: { isActive: true, channel: "SMS" },
    });

    // One row with a shipment behind it, for the scoping and masking
    // checks. Selected by id so every assertion below is about this row
    // and not about the size of the table.
    const row = await prisma.notificationLog.findFirst({
      where: { shipmentId: { not: null }, recipient: { not: "" } },
      orderBy: { queuedAt: "desc" },
      select: {
        id: true,
        recipient: true,
        branchId: true,
        shipment: {
          select: {
            lrNumber: true,
            bookingBranchId: true,
            originBranchId: true,
            destinationBranchId: true,
            currentBranchId: true,
          },
        },
      },
    });

    const probe: Probe | null =
      row && row.shipment
        ? {
            logId: row.id,
            lrNumber: row.shipment.lrNumber,
            recipient: row.recipient,
            branchIds: [
              row.branchId,
              row.shipment.bookingBranchId,
              row.shipment.originBranchId,
              row.shipment.destinationBranchId,
              row.shipment.currentBranchId,
            ].filter((id): id is string => Boolean(id)),
          }
        : null;

    // How many rows this LR has in total, which is what the counter on a
    // search for it must say.
    const forProbe = probe
      ? await prisma.notificationLog.count({
          where: { shipment: { lrNumber: probe.lrNumber } },
        })
      : 0;

    // The newest redacted delivery code, if the pipeline check has run.
    const otp = await prisma.notificationLog.findFirst({
      where: { eventType: "notification.delivery_otp" },
      orderBy: { queuedAt: "desc" },
      select: { body: true, shipment: { select: { lrNumber: true } } },
    });

    // Branch users, so the scoping check can pick one that cannot see the
    // probe rather than assuming which branch it landed at.
    const staff = await prisma.user.findMany({
      where: { mobile: { in: BRANCH_MOBILES } },
      select: {
        mobile: true,
        name: true,
        primaryBranch: { select: { id: true, code: true } },
      },
    });

    return { templateTotal, smsTotal, smsInactive, smsWithDlt, activeTotal, activeSms, probe, forProbe, otp, staff };
  });

  // ────────────────────────────────────────────────────────────
  // The person whose job this is
  // ────────────────────────────────────────────────────────────
  console.log("Customer support — the desk that answers 'I never got it'");

  const support = await signIn(SUPPORT_MOBILE, "/notifications/log");

  const entry = await hostFollow(HOST, PORT, "/notifications", support);
  check(
    "/notifications lands somewhere real rather than 404ing",
    entry.status === 200 && entry.finalPath === "/notifications/templates",
    `HTTP ${entry.status} at ${entry.finalPath}`,
  );

  const log = await page(support, "/notifications/log", "Send log");
  check(
    "the send log renders",
    log.status === 200 && !log.finalPath.includes("/login"),
    `HTTP ${log.status} at ${log.finalPath}`,
  );
  check(
    "notifications is core, not an upsell",
    !log.finalPath.includes("/not-on-plan"),
    log.finalPath,
  );
  check(
    "and there is a way from it to the templates",
    log.body.includes("/notifications/templates"),
  );

  const templates = await page(support, "/notifications/templates", "Templates");
  check(
    "the templates screen renders",
    templates.status === 200 && !templates.finalPath.includes("/login"),
    `HTTP ${templates.status} at ${templates.finalPath}`,
  );
  check(
    "and there is a way from it to the send log",
    templates.body.includes("/notifications/log"),
  );

  // ────────────────────────────────────────────────────────────
  // Why every SMS template is switched off — question A
  // ────────────────────────────────────────────────────────────
  console.log("\nWhy the SMS half of the matrix is off");

  check(
    "the SMS templates really are inactive",
    facts.smsTotal > 0 && facts.smsInactive === facts.smsTotal,
    `${facts.smsInactive} of ${facts.smsTotal} inactive`,
  );
  check(
    "not one of them has a DLT id, which is the reason",
    facts.smsWithDlt === 0,
    `${facts.smsWithDlt} registered`,
  );
  check(
    "no SMS template is active without one",
    facts.activeSms === 0,
    `${facts.activeSms} active SMS`,
  );
  // The split is exactly channel-shaped — every non-SMS template on, every
  // SMS one off — which is what makes it a rule somebody wrote rather than
  // a scatter of individual decisions nobody can now account for.
  check(
    "the on/off split follows the channel and nothing else",
    facts.activeTotal === facts.templateTotal - facts.smsTotal,
    `${facts.activeTotal} active of ${facts.templateTotal}, ${facts.smsTotal} SMS`,
  );
  check(
    "the screen says so, in as many words",
    templates.body.includes("pending DLT registration"),
    "the reason is on the page, not inferred from a boolean",
  );
  check(
    "and gives the count it is talking about",
    templates.body.includes(`${facts.smsInactive} SMS template`),
    `${facts.smsInactive} SMS templates`,
  );
  check(
    "and names the registration lead time",
    templates.body.includes("one to three weeks"),
  );
  check(
    "and says whether the carrier has a sender header at all",
    templates.body.includes("Sender header for"),
  );
  check(
    "and lists which templates are waiting",
    templates.body.includes("DELIVERY_OTP") &&
      templates.body.includes("BOOKING_CREATED"),
  );
  check(
    "an unregistered SMS template is marked on its own row",
    templates.body.includes("Not registered"),
  );

  // Every trigger a template sits on must be one the editor knows about.
  // `shipment.reweighed` was not: the two seeded reweigh templates had a
  // trigger missing from the dropdown and variables missing from the
  // catalogue, so the screen printed the raw event name, the editor
  // refused to save them, and the `<select>` would have silently moved
  // them onto "Booking created" if it had.
  check(
    "the reweigh trigger is in the matrix, not printed raw",
    templates.body.includes("Reweighed at the hub"),
    "EVENT_LABEL covers shipment.reweighed",
  );

  // ────────────────────────────────────────────────────────────
  // Whether SENT means anything — question B
  // ────────────────────────────────────────────────────────────
  console.log("\nWhat is actually behind the channels");

  check(
    "the send log warns that no gateway is connected",
    log.body.includes("No gateway is connected for"),
    "the banner is on the page",
  );
  check(
    "and names EMAIL as one of them, which is where the active templates are",
    log.body.includes("No gateway is connected for") && log.body.includes("EMAIL"),
  );
  check(
    "a row the mock wrote is marked simulated, not left reading SENT",
    log.body.includes("simulated"),
  );
  check(
    "the templates screen warns before somebody activates another one",
    templates.body.includes("no gateway behind"),
  );

  // ────────────────────────────────────────────────────────────
  // Privacy
  // ────────────────────────────────────────────────────────────
  console.log("\nWhat the log gives away");

  if (!facts.probe) {
    console.log("  [SKIP] no notification row with a shipment behind it to check");
  } else {
    const probe = facts.probe;
    const found = await page(
      support,
      `/notifications/log?q=${encodeURIComponent(probe.lrNumber)}`,
      "Send log",
    );

    check(
      "a support agent can find one consignment's messages by LR",
      found.body.includes(probe.lrNumber),
      probe.lrNumber,
    );
    check(
      "the recipient is masked on the page",
      !found.body.includes(probe.recipient),
      `${probe.recipient} does not appear verbatim`,
    );

    // The counter that heads the list has to agree with the list. A
    // `count()` of one thing above a `findMany` of another is the defect
    // `verify-reweigh.ts` was written after.
    const total = paginationTotal(found.body);
    const drawn = renderedRows(found.body, probe.lrNumber);
    if (total === null) {
      check(
        "the counter agrees with the list it heads",
        drawn === facts.forProbe,
        `${drawn} drawn, ${facts.forProbe} in the database (single page, no counter)`,
      );
    } else {
      check(
        "the counter agrees with the list it heads",
        total === facts.forProbe && drawn === Math.min(total, 40),
        `counter ${total}, drawn ${drawn}, database ${facts.forProbe}`,
      );
    }
  }

  if (!facts.otp) {
    console.log("  [SKIP] no delivery-OTP row yet — run verify-notifications.ts first");
  } else {
    check(
      "a delivery code is not stored in the send log",
      // An LR number carries a long digit run of its own, so the test is
      // for a free-standing code rather than for digits.
      !/\d{4,8}/.test(facts.otp.body) && facts.otp.body.includes("••••"),
      facts.otp.body.slice(0, 70),
    );

    if (facts.otp.shipment) {
      const otpPage = await page(
        support,
        `/notifications/log?q=${encodeURIComponent(facts.otp.shipment.lrNumber)}`,
        "Send log",
      );
      check(
        "and the screen shows the redaction rather than the code",
        otpPage.body.includes("••••"),
        facts.otp.shipment.lrNumber,
      );
    }
  }

  // ────────────────────────────────────────────────────────────
  // Who may read it
  // ────────────────────────────────────────────────────────────
  console.log("\nRefusals");

  const admin = await signIn(ADMIN_MOBILE, "/notifications/templates");
  const editable = await page(admin, "/notifications/templates", "Templates");
  check(
    "an admin holding master.manage is offered the editing controls",
    editable.body.includes("New template"),
  );
  check(
    "customer support, who may read and not manage, is not",
    !templates.body.includes("New template"),
    "the control is a permission, not decoration",
  );

  const agent = await signIn(AGENT_MOBILE, "/notifications/log");
  const refused = await hostFollow(HOST, PORT, "/notifications/log", agent);
  check(
    "a delivery agent, who holds no master.read, is refused the send log",
    refused.status === 403 ||
      refused.finalPath.includes("/forbidden") ||
      refused.finalPath.includes("/denied") ||
      refused.finalPath.includes("/login"),
    `HTTP ${refused.status} at ${refused.finalPath}`,
  );
  check(
    "and is not shown a customer's message on the way",
    !refused.body.includes("Send log") ||
      refused.finalPath.includes("/denied") ||
      refused.finalPath.includes("/login"),
  );

  // ── Branch scoping ──────────────────────────────────────────
  //
  // The send log carries the text of every message and the number it went
  // to. It had no branch filter, so a hub operator at one end of the
  // network could page through the whole of it. Proved on one record: a
  // branch user whose branch is none of that consignment's may not find it
  // by its own LR number, which is the narrowest possible way to look.
  if (!facts.probe) {
    console.log("  [SKIP] no probe row, so branch scoping cannot be shown on one record");
  } else {
    const probe = facts.probe;
    const outsider = facts.staff.find(
      (person) =>
        person.primaryBranch && !probe.branchIds.includes(person.primaryBranch.id),
    );

    if (!outsider) {
      console.log(
        "  [SKIP] every seeded branch user covers this consignment; no outsider to test with",
      );
    } else {
      const jar = await signIn(outsider.mobile, "/notifications/log");
      const theirs = await page(jar, "/notifications/log", "Send log");

      check(
        `${outsider.primaryBranch?.code} may read the send log at all`,
        theirs.status === 200 && !theirs.finalPath.includes("/login"),
        `HTTP ${theirs.status} at ${theirs.finalPath}`,
      );

      const searched = await page(
        jar,
        `/notifications/log?q=${encodeURIComponent(probe.lrNumber)}`,
        "Send log",
      );
      // Counted as rendered rows, not as a substring of the page: the
      // search box echoes whatever was typed into it, so an LR that is
      // nowhere in the results is still in the HTML.
      check(
        "but not another branch's consignment, even searching for it by LR",
        renderedRows(searched.body, probe.lrNumber) === 0,
        `${outsider.primaryBranch?.code} draws ${renderedRows(searched.body, probe.lrNumber)} row(s) for ${probe.lrNumber}`,
      );
      check(
        "and the counter does not advertise rows they cannot open",
        paginationTotal(searched.body) === null,
        "an empty result, not a counter over hidden rows",
      );
    }

    // The other half of the same claim: scoping that hides everything from
    // everybody is not scoping, it is an outage.
    const insider = facts.staff.find(
      (person) =>
        person.primaryBranch && probe.branchIds.includes(person.primaryBranch.id),
    );

    if (!insider) {
      console.log(
        "  [SKIP] no seeded branch user covers this consignment, so the positive case cannot be shown",
      );
    } else {
      const jar = await signIn(insider.mobile, "/notifications/log");
      const searched = await page(
        jar,
        `/notifications/log?q=${encodeURIComponent(probe.lrNumber)}`,
        "Send log",
      );
      check(
        `${insider.primaryBranch?.code}, which handles it, still can`,
        renderedRows(searched.body, probe.lrNumber) > 0,
        probe.lrNumber,
      );
    }
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nThe notification screen check could not run:\n", error);
  process.exit(1);
});
