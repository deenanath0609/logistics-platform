/**
 * Proves each carrier's positions are pulled from that carrier's own
 * telematics account, against the real database.
 *
 *   npx tsx scripts/verify-gps-tenancy.ts [--a city-logistics] [--b acme-freight]
 *
 * The push half of the pipeline has identified a sender per carrier since
 * the webhook route learned to resolve a tenant from whichever configured
 * secret verifies the body. The pull half read `GPS_PROVIDER` out of the
 * environment and polled every organisation through one vendor account —
 * one bill, one rate limit, and one revoked key that empties every live map
 * at once. `resolvePollProviders` ended that; this script is what proves it
 * on real rows rather than on mocks.
 *
 * `resolve.test.ts` covers the same rules with a mocked client, which is
 * where the edge cases belong. What a unit test cannot do is run the query
 * through the tenant extension and RLS underneath it, and that is exactly
 * the layer a leak would live in.
 *
 * Everything it creates, it removes. A provider row is configuration rather
 * than a record of something that happened, so unlike `verify-spine.ts` and
 * `verify-field-cycle.ts` there is no evidence to preserve — and leaving a
 * fake vendor attached to a carrier would be worse than untidy, because the
 * next poll would try to reach it.
 */
import "dotenv/config";
import { prisma, basePrisma } from "../src/lib/prisma";
import { disconnectDb } from "../src/lib/prisma-base";
import { runWithTenant, tenantContextFor, type TenantContext } from "../src/lib/tenant";
import { resolvePollProviders, isDue } from "../src/lib/tracking/providers/resolve";
import { pollOnce } from "../src/lib/tracking/runtime";
import { trackedDeviceIds } from "../src/lib/tracking/ingest";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "true");
}
const SLUG_A = args.get("a") ?? "city-logistics";
const SLUG_B = args.get("b") ?? "acme-freight";

/** Codes this script owns. Anything it finds under them is restored after. */
const MOCK_CODE = "mock";
const BOGUS_CODE = "verify-gps-tenancy-absent-vendor";

let failures = 0;
let passes = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Something that could not be exercised here, said out loud.
 *
 * A skip is not a pass. A fleet with no device ids on file cannot be polled
 * by anybody, and reporting that as green would be exactly the padded claim
 * this project has been caught making before.
 */
function skip(label: string, why: string) {
  skipped += 1;
  console.log(`  [SKIP] ${label} — ${why}`);
}

// ────────────────────────────────────────────────────────────
// Tenants
// ────────────────────────────────────────────────────────────

async function tenantFor(slug: string): Promise<TenantContext> {
  // `basePrisma`: this is the query that decides which tenant to act as, so
  // it cannot itself run inside one.
  const org = await basePrisma.organization.findFirst({
    where: { OR: [{ slug }, { subdomain: slug }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });

  if (!org) {
    throw new Error(
      `No organisation "${slug}". Provision one first:\n` +
        `  npx tsx scripts/provision-tenant.ts --slug ${slug} --name "${slug}" --subdomain ${slug}`,
    );
  }

  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${slug}" is closed and yields no context.`);
  return tenant;
}

// ────────────────────────────────────────────────────────────
// Fixtures, and putting them back
// ────────────────────────────────────────────────────────────

type Snapshot = {
  tenant: TenantContext;
  code: string;
  before: Record<string, unknown> | null;
};

const snapshots: Snapshot[] = [];

/**
 * Writes a provider row, remembering whatever was there first.
 *
 * Every read and write here goes through the tenant client inside
 * `runWithTenant`, not `basePrisma`. Row-level security is on and the app
 * role owns nothing, so a write with no tenant on the session is refused by
 * Postgres itself — which is the layer this script exists to exercise, and
 * reaching around it with a privileged connection would prove nothing.
 *
 * A developer's own `mock` row is a perfectly ordinary thing to find, and a
 * verification script that quietly overwrote it would be one nobody runs
 * twice.
 */
async function putProvider(
  tenant: TenantContext,
  code: string,
  data: Record<string, unknown>,
): Promise<void> {
  await runWithTenant(tenant, async () => {
    const before = await prisma.trackingProviderConfig.findFirst({ where: { code } });
    snapshots.push({
      tenant,
      code,
      before: before ? (before as unknown as Record<string, unknown>) : null,
    });

    if (before) {
      await prisma.trackingProviderConfig.update({
        where: { id: before.id },
        data: { ...data, lastError: null },
      });
      return;
    }

    // `orgId` is stamped by the extension; naming it here would say the
    // same thing twice and invite the two to disagree.
    await prisma.trackingProviderConfig.create({
      data: { code, name: `Verification ${code}`, ...data } as never,
    });
  });
}

async function restoreAll(): Promise<void> {
  // Reversed, so a code touched twice ends as it started.
  for (const snapshot of [...snapshots].reverse()) {
    await runWithTenant(snapshot.tenant, async () => {
      if (snapshot.before) {
        const {
          id,
          orgId: _orgId,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          ...rest
        } = snapshot.before as { id: string } & Record<string, unknown>;

        await prisma.trackingProviderConfig.update({ where: { id }, data: rest });
        return;
      }

      await prisma.trackingProviderConfig.deleteMany({ where: { code: snapshot.code } });
    });
  }
}

// ────────────────────────────────────────────────────────────

async function main() {
  const a = await tenantFor(SLUG_A);
  const b = await tenantFor(SLUG_B);

  console.log(
    `\nGPS provider tenancy — "${a.slug}" and "${b.slug}"\n` +
      "  Each carrier's fixes must come from that carrier's own vendor account.\n",
  );

  // ── Each carrier polls their own vendor ───────────────────
  console.log("Whose account");

  await putProvider(a, MOCK_CODE, {
    mode: "poll",
    isActive: true,
    baseUrl: "https://vendor-a.example",
    apiKey: "key-for-a",
    webhookSecret: null,
    pollIntervalSeconds: 30,
    lastPolledAt: null,
  });

  await putProvider(b, MOCK_CODE, {
    mode: "poll",
    isActive: true,
    baseUrl: "https://vendor-b.example",
    apiKey: "key-for-b",
    webhookSecret: null,
    pollIntervalSeconds: 30,
    lastPolledAt: null,
  });

  const resolvedA = await runWithTenant(a, () => resolvePollProviders());
  const resolvedB = await runWithTenant(b, () => resolvePollProviders());

  check(
    `${a.slug} polls its own account`,
    resolvedA.length === 1 &&
      resolvedA[0].source === "config" &&
      resolvedA[0].credentials.apiKey === "key-for-a",
    `${resolvedA.length} provider(s), source ${resolvedA[0]?.source}`,
  );

  check(
    `${b.slug} polls its own account`,
    resolvedB.length === 1 &&
      resolvedB[0].source === "config" &&
      resolvedB[0].credentials.apiKey === "key-for-b",
    `${resolvedB.length} provider(s), source ${resolvedB[0]?.source}`,
  );

  // The probe that would have caught the bug this work fixes: not "A got
  // something sensible" but "B's key is nowhere in A's answer".
  check(
    "neither carrier's key appears in the other's resolution",
    !JSON.stringify(resolvedA).includes("key-for-b") &&
      !JSON.stringify(resolvedB).includes("key-for-a"),
  );

  // ── What is not polled ────────────────────────────────────
  console.log("\nWhat is not pulled");

  await putProvider(a, MOCK_CODE, { mode: "webhook", isActive: true });
  const pushOnly = await runWithTenant(a, () => resolvePollProviders());
  check(
    "a vendor that pushes is not also polled",
    pushOnly.every((entry) => entry.source !== "config"),
    `resolved to ${pushOnly[0]?.source}`,
  );

  await putProvider(a, MOCK_CODE, { mode: "poll", isActive: false });
  const disabled = await runWithTenant(a, () => resolvePollProviders());
  check(
    "a disabled vendor is not polled",
    disabled.every((entry) => entry.source !== "config"),
    `resolved to ${disabled[0]?.source}`,
  );

  check(
    "with no row of their own, the carrier still has somewhere to poll",
    disabled.length === 1 &&
      (disabled[0].source === "credential" || disabled[0].source === "environment") &&
      Boolean(disabled[0].code),
    `${disabled[0]?.source} → ${disabled[0]?.code}`,
  );

  // ── The interval each carrier asked for ───────────────────
  console.log("\nEach carrier's own interval");

  await putProvider(a, MOCK_CODE, {
    mode: "poll",
    isActive: true,
    apiKey: "key-for-a",
    pollIntervalSeconds: 3600,
    lastPolledAt: new Date(),
  });

  const justPolled = await runWithTenant(a, () => resolvePollProviders());
  check(
    "a vendor polled a moment ago is not due again",
    justPolled.length === 1 && !isDue(justPolled[0]),
    `interval ${justPolled[0]?.pollIntervalSeconds}s`,
  );

  const devices = await runWithTenant(a, () => trackedDeviceIds());

  if (devices.length === 0) {
    skip(
      "an unforced pass skips a vendor that is not due",
      `${a.slug} has no vehicle with a GPS device id, so nothing can be polled`,
    );
    skip("a forced pass ignores the interval", "same reason");
    skip("one vendor's failure does not stop another's", "same reason");
  } else {
    const unforced = await runWithTenant(a, () => pollOnce());
    check(
      "an unforced pass skips a vendor that is not due",
      unforced.skipped === 1 && unforced.providers === 0,
      `${unforced.providers} polled, ${unforced.skipped} skipped`,
    );

    const forced = await runWithTenant(a, () => pollOnce({ force: true }));
    check(
      "a forced pass ignores the interval",
      forced.providers === 1 && forced.skipped === 0 && forced.failures.length === 0,
      `${forced.providers} polled, ${forced.failures.length} failure(s)`,
    );

    // Awaited *inside* the callback. A Prisma promise is lazy: returning it
    // unawaited runs the query after `runWithTenant` has already exited, and
    // the extension then refuses it for having no tenant.
    const stamped = await runWithTenant(a, async () =>
      await prisma.trackingProviderConfig.findFirst({
        where: { code: MOCK_CODE },
        select: { lastPolledAt: true, lastError: true },
      }),
    );
    check(
      "a successful poll is recorded on the carrier's own row",
      Boolean(stamped?.lastPolledAt) && stamped?.lastError === null,
      stamped?.lastError ?? "",
    );

    // ── One vendor down, the other still polled ─────────────
    console.log("\nOne vendor down");

    await putProvider(a, BOGUS_CODE, {
      mode: "poll",
      isActive: true,
      apiKey: "key-for-a",
      pollIntervalSeconds: 30,
      lastPolledAt: null,
    });

    const mixed = await runWithTenant(a, () => pollOnce({ force: true }));
    check(
      "one vendor's failure does not stop another's",
      mixed.providers === 1 && mixed.failures.length === 1,
      `${mixed.providers} polled, ${mixed.failures.length} failure(s)`,
    );
    check(
      "the failure names the vendor and the reason",
      mixed.failures[0]?.code === BOGUS_CODE &&
        mixed.failures[0]?.message.includes(BOGUS_CODE),
      mixed.failures[0]?.message ?? "no message",
    );

    const noted = await runWithTenant(a, async () =>
      await prisma.trackingProviderConfig.findFirst({
        where: { code: BOGUS_CODE },
        select: { lastPolledAt: true, lastError: true },
      }),
    );
    check(
      "a vendor that failed is not stamped as contacted",
      noted?.lastPolledAt === null && Boolean(noted?.lastError),
      noted?.lastError?.slice(0, 60) ?? "no error recorded",
    );
  }

  // ── B is untouched by any of it ───────────────────────────
  console.log("\nThe other carrier");

  const bAfter = await runWithTenant(b, async () =>
    await prisma.trackingProviderConfig.findFirst({
      where: { code: MOCK_CODE },
      select: { lastPolledAt: true, apiKey: true },
    }),
  );
  check(
    `${b.slug} was never polled by ${a.slug}'s pass`,
    bAfter?.lastPolledAt === null && bAfter?.apiKey === "key-for-b",
  );
}

main()
  .then(async () => {
    await restoreAll();
    console.log(
      `\n${passes} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ""}.\n`,
    );
    await disconnectDb();
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch(async (error) => {
    console.error("\nverify-gps-tenancy failed to run:\n", error);
    // Restore even on the way out. A half-written fixture is a fake vendor
    // attached to a real carrier, and the next poll would try to reach it.
    await restoreAll().catch(() => undefined);
    await disconnectDb();
    process.exit(1);
  });
