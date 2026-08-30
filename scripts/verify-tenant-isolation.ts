/**
 * The adversarial suite. Proves tenant A cannot reach tenant B's data.
 *
 *   npx tsx scripts/verify-tenant-isolation.ts [--a city-logistics] [--b acme-freight]
 *                                              [--base http://localhost:3010]
 *
 * ADR 001 names this the non-negotiable acceptance test, and it is written
 * in the spirit of `verify-tracking-privacy.ts`: it tries to break the thing
 * rather than confirming it works. Every probe below is an attack that would
 * succeed if the isolation layer were missing, so a PASS means the attempt
 * was refused — not that a query returned something sensible.
 *
 * It reads fixtures with `basePrisma`, which is unfiltered on purpose: the
 * test has to know a real id belonging to B before it can try to reach it
 * from inside A. Everything being *tested* goes through the application
 * client.
 *
 * If tenant B does not exist yet:
 *   npx tsx scripts/provision-tenant.ts --slug acme-freight --name "Acme Freight" --subdomain acme
 */
import "dotenv/config";
import { prisma, basePrisma } from "../src/lib/prisma";
import { disconnectDb } from "../src/lib/prisma-base";
import { runWithTenant, tenantContextFor } from "../src/lib/tenant";
import { TENANT_SCOPED_MODELS } from "../src/lib/tenant/scoped-models.generated";
import { objectKeyOrgId } from "../src/lib/storage/keys";
import { CookieJar, hostFetch, type HostResponse } from "./host-fetch";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "true");
}
const SLUG_A = args.get("a") ?? "city-logistics";
const SLUG_B = args.get("b") ?? "acme-freight";
const BASE = args.get("base");

const ROOT_DOMAIN = process.env.APP_ROOT_DOMAIN ?? "localhost";
const PORT = BASE ? Number(new URL(BASE).port || 80) : 0;
const hostFor = (subdomain: string) => `${subdomain}.${ROOT_DOMAIN}`;

/** The demo credentials the other smoke scripts use. */
const OPS_MOBILE = process.env.SMOKE_ADMIN_MOBILE ?? "9999999999";
const OPS_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? "Admin@123";
const PORTAL_PASSWORD = process.env.PORTAL_DEMO_PASSWORD ?? "Portal@123";

let failures = 0;
let passes = 0;
/** Probes that could not be run at all. Counted, so they are not mistaken
 * for passes in the summary — a skip is a hole in the evidence. */
let skips = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

/** A probe that must be refused. Returning anything at all is the failure. */
async function mustBeEmpty(label: string, run: () => Promise<unknown>) {
  try {
    const result = await run();
    const empty =
      result === null ||
      result === undefined ||
      result === 0 ||
      (Array.isArray(result) && result.length === 0);
    check(label, empty, empty ? "" : `returned ${JSON.stringify(result).slice(0, 120)}`);
  } catch (error) {
    // A throw is also a refusal — `findUniqueOrThrow` and the write paths
    // refuse loudly rather than quietly.
    check(label, true, `refused (${(error as Error).name})`);
  }
}

/** A probe that must throw. Succeeding quietly is the failure. */
async function mustThrow(label: string, run: () => Promise<unknown>) {
  try {
    await run();
    check(label, false, "the operation was allowed");
  } catch (error) {
    check(label, true, (error as Error).name);
  }
}

type Fixture = {
  orgId: string;
  slug: string;
  subdomain: string;
  shipmentId: string | null;
  lrNumber: string | null;
  customerId: string | null;
  userId: string | null;
  invoiceId: string | null;
  roleId: string | null;
  vehicleId: string | null;
  fileAssetId: string | null;
  deliveryTaskId: string | null;
  pincodeCode: string | null;
  serviceTypeCode: string | null;
  /** Every stored object this tenant owns, for the key-shape probe. */
  objectKeys: { id: string; objectKey: string }[];
  /** POD photographs, paired with the consignment whose URL serves them. */
  podAssets: { shipmentId: string; assetId: string; objectKey: string }[];
  /** An invoice with a rendered PDF, which the portal route hands out. */
  invoiceWithDocumentId: string | null;
  /** A portal login, for probing the portal route as a signed-in customer. */
  portalEmail: string | null;
};

async function loadFixture(subdomainOrSlug: string): Promise<Fixture> {
  const org = await basePrisma.organization.findFirst({
    where: { OR: [{ slug: subdomainOrSlug }, { subdomain: subdomainOrSlug }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  if (!org) {
    throw new Error(
      `No organisation matches "${subdomainOrSlug}". Provision it first:\n` +
        `  npx tsx scripts/provision-tenant.ts --slug ${subdomainOrSlug} --name "${subdomainOrSlug}" --subdomain ${subdomainOrSlug}`,
    );
  }

  const orgId = org.id;

  // The fixtures are read with the unextended client on purpose — the test
  // has to know a real id belonging to B before it can try to reach it from
  // inside A. But with row-level security on, "unextended" is not the same
  // as "unfiltered": the application role has no tenant on its session, so
  // every one of these reads would come back empty and the suite would pass
  // by asking nothing. Naming the tenant here is what keeps the probes real.
  const {
    shipment,
    customer,
    user,
    invoice,
    role,
    vehicle,
    asset,
    task,
    pincode,
    serviceType,
    objectKeys,
    pods,
    invoiceWithDocument,
    portalUser,
  } = await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, TRUE)`;
    const [
      shipment,
      customer,
      user,
      invoice,
      role,
      vehicle,
      asset,
      task,
      pincode,
      serviceType,
      objectKeys,
      pods,
      invoiceWithDocument,
      portalUser,
    ] = await Promise.all([
      tx.shipment.findFirst({ where: { orgId }, select: { id: true, lrNumber: true } }),
      tx.customer.findFirst({ where: { orgId }, select: { id: true } }),
      tx.user.findFirst({ where: { orgId }, select: { id: true } }),
      tx.invoice.findFirst({ where: { orgId }, select: { id: true } }),
      tx.role.findFirst({ where: { orgId }, select: { id: true } }),
      tx.vehicle.findFirst({ where: { orgId }, select: { id: true } }),
      tx.fileAsset.findFirst({ where: { orgId }, select: { id: true } }),
      tx.deliveryTask.findFirst({ where: { orgId }, select: { id: true } }),
      tx.pincode.findFirst({ where: { orgId }, select: { code: true } }),
      tx.serviceType.findFirst({ where: { orgId }, select: { code: true } }),
      tx.fileAsset.findMany({
        where: { orgId, deletedAt: null },
        select: { id: true, objectKey: true },
        take: 500,
      }),
      tx.pod.findMany({
        where: { orgId, photoAssetId: { not: null } },
        select: { shipmentId: true, photoAssetId: true },
        take: 5,
      }),
      tx.invoice.findFirst({
        where: { orgId, documentAssetId: { not: null } },
        select: { id: true },
      }),
      tx.customerUser.findFirst({
        where: { orgId, isActive: true, deletedAt: null },
        select: { email: true },
      }),
    ]);
    return {
      shipment,
      customer,
      user,
      invoice,
      role,
      vehicle,
      asset,
      task,
      pincode,
      serviceType,
      objectKeys,
      pods,
      invoiceWithDocument,
      portalUser,
    };
  });

  // The POD route serves an asset under the consignment that owns it, so a
  // probe needs both halves and the key the bytes actually sit at.
  const keyById = new Map(objectKeys.map((row) => [row.id, row.objectKey]));
  const podAssets = pods.flatMap((pod) => {
    const objectKey = pod.photoAssetId ? keyById.get(pod.photoAssetId) : undefined;
    return objectKey && pod.photoAssetId
      ? [{ shipmentId: pod.shipmentId, assetId: pod.photoAssetId, objectKey }]
      : [];
  });

  return {
    objectKeys,
    podAssets,
    invoiceWithDocumentId: invoiceWithDocument?.id ?? null,
    portalEmail: portalUser?.email ?? null,
    orgId,
    slug: org.slug,
    subdomain: org.subdomain,
    shipmentId: shipment?.id ?? null,
    lrNumber: shipment?.lrNumber ?? null,
    customerId: customer?.id ?? null,
    userId: user?.id ?? null,
    invoiceId: invoice?.id ?? null,
    roleId: role?.id ?? null,
    vehicleId: vehicle?.id ?? null,
    fileAssetId: asset?.id ?? null,
    deliveryTaskId: task?.id ?? null,
    pincodeCode: pincode?.code ?? null,
    serviceTypeCode: serviceType?.code ?? null,
  };
}

async function contextFor(subdomain: string) {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ slug: subdomain }, { subdomain }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const ctx = tenantContextFor(org, "job");
  if (!ctx) throw new Error(`Tenant ${subdomain} is CLOSED and cannot be acted as.`);
  return ctx;
}

/** Reaching B's rows by id, from inside A, through the application client. */
async function probeDirectReads(b: Fixture) {
  console.log("\nDirect reads of the other tenant's rows, by id");

  const byId: Array<[string, string | null, () => Promise<unknown>]> = [
    ["shipment.findUnique", b.shipmentId, () => prisma.shipment.findUnique({ where: { id: b.shipmentId! } })],
    ["shipment.findFirst", b.shipmentId, () => prisma.shipment.findFirst({ where: { id: b.shipmentId! } })],
    ["shipment.count", b.shipmentId, () => prisma.shipment.count({ where: { id: b.shipmentId! } })],
    ["customer.findUnique", b.customerId, () => prisma.customer.findUnique({ where: { id: b.customerId! } })],
    ["user.findUnique", b.userId, () => prisma.user.findUnique({ where: { id: b.userId! } })],
    ["invoice.findUnique", b.invoiceId, () => prisma.invoice.findUnique({ where: { id: b.invoiceId! } })],
    ["role.findUnique", b.roleId, () => prisma.role.findUnique({ where: { id: b.roleId! } })],
    ["vehicle.findUnique", b.vehicleId, () => prisma.vehicle.findUnique({ where: { id: b.vehicleId! } })],
    ["fileAsset.findUnique (POD images)", b.fileAssetId, () => prisma.fileAsset.findUnique({ where: { id: b.fileAssetId! } })],
    ["deliveryTask.findUnique", b.deliveryTaskId, () => prisma.deliveryTask.findUnique({ where: { id: b.deliveryTaskId! } })],
  ];

  for (const [label, id, run] of byId) {
    if (!id) {
      console.log(`  [SKIP] ${label} — tenant ${b.slug} has no such row to try`);
      continue;
    }
    await mustBeEmpty(label, run);
  }

  if (b.shipmentId) {
    await mustBeEmpty("shipment.findUniqueOrThrow", () =>
      prisma.shipment.findUniqueOrThrow({ where: { id: b.shipmentId! } }),
    );
  }
}

/** Writes are the half that turns a leak into damage. */
async function probeWrites(b: Fixture) {
  console.log("\nWrites against the other tenant's rows");

  if (b.shipmentId) {
    await mustBeEmpty("shipment.updateMany reaches no rows", async () => {
      const result = await prisma.shipment.updateMany({
        where: { id: b.shipmentId! },
        data: { specialInstructions: "tenant-isolation probe" },
      });
      return result.count;
    });

    await mustThrow("shipment.update by id is refused", () =>
      prisma.shipment.update({
        where: { id: b.shipmentId! },
        data: { specialInstructions: "tenant-isolation probe" },
      }),
    );

    await mustThrow("shipment.delete by id is refused", () =>
      prisma.shipment.delete({ where: { id: b.shipmentId! } }),
    );
  }

  await mustThrow("creating a row stamped with the other tenant's id is refused", () =>
    prisma.serviceType.create({
      data: {
        orgId: b.orgId,
        code: `PROBE-${Date.now()}`,
        name: "Tenant isolation probe",
        mode: "PTL",
      },
    }),
  );
}

/**
 * The sweep. Every scoped model, every row the app client can see, must
 * belong to the tenant we are acting as. This is the probe most likely to
 * catch a model that slipped out of the generated registry.
 */
async function probeEveryScopedModel(a: Fixture) {
  console.log("\nEvery row the client returns belongs to this tenant");

  const client = prisma as unknown as Record<
    string,
    { findMany: (args: unknown) => Promise<Array<{ orgId?: string }>> }
  >;

  let checked = 0;
  const offenders: string[] = [];

  for (const model of TENANT_SCOPED_MODELS) {
    const delegate = client[model];
    if (!delegate?.findMany) continue;
    try {
      const rows = await delegate.findMany({ take: 200, select: { orgId: true } });
      checked += 1;
      if (rows.some((row) => row.orgId !== a.orgId)) offenders.push(model);
    } catch (error) {
      offenders.push(`${model} (threw: ${(error as Error).message.slice(0, 60)})`);
    }
  }

  check(
    `${checked} scoped models return only this tenant's rows`,
    offenders.length === 0,
    offenders.length ? offenders.join(", ") : "",
  );
}

/** Masters are per-tenant, including geography — the same code is a different row. */
async function probeMasters(a: Fixture, b: Fixture) {
  console.log("\nMasters are the tenant's own, not shared");

  if (b.pincodeCode) {
    const rows = await prisma.pincode.findMany({ where: { code: b.pincodeCode }, select: { orgId: true } });
    check(
      `pincode ${b.pincodeCode} resolves only within this tenant`,
      rows.every((row) => row.orgId === a.orgId),
      rows.length === 0 ? "not serviced by this tenant, which is also correct" : "",
    );
  }

  if (b.serviceTypeCode) {
    const rows = await prisma.serviceType.findMany({
      where: { code: b.serviceTypeCode },
      select: { orgId: true },
    });
    check(
      `service type ${b.serviceTypeCode} resolves only within this tenant`,
      rows.every((row) => row.orgId === a.orgId),
    );
  }
}

/** Child rows inherit isolation through a foreign key — verify that they do. */
async function probeChildRows(a: Fixture, b: Fixture) {
  console.log("\nChild rows reached through a parent stay inside the tenant");

  if (b.shipmentId) {
    await mustBeEmpty("shipmentEvent list for the other tenant's shipment", () =>
      prisma.shipmentEvent.findMany({
        where: { shipment: { id: b.shipmentId! } },
        take: 5,
        select: { id: true },
      }),
    );

    await mustBeEmpty("shipmentPackage list for the other tenant's shipment", () =>
      prisma.shipmentPackage.findMany({
        where: { shipment: { id: b.shipmentId! } },
        take: 5,
        select: { id: true },
      }),
    );
  }

  const events = await prisma.shipmentEvent.findMany({
    take: 200,
    select: { shipment: { select: { orgId: true } } },
  });
  check(
    "every event reached without a filter belongs to this tenant's shipments",
    events.every((event) => event.shipment.orgId === a.orgId),
  );

  // The relation filter is the shape that broke the original design: the
  // extension rewrites a top-level `where`, not a nested one, so any table
  // reachable this way had to stop depending on its foreign key and carry
  // the tenant itself. These probe the sensitive ones by name, because a
  // regression here is a regression in the reasoning, not just in a query.
  if (!b.shipmentId) return;

  const client = prisma as unknown as Record<
    string,
    { findMany: (args: unknown) => Promise<unknown[]> }
  >;

  const throughShipment: Array<[string, string]> = [
    ["shipmentCharge", "charges on the other tenant's consignment"],
    ["freightCalculation", "pricing for the other tenant's consignment"],
    ["pod", "proof of delivery for the other tenant's consignment"],
    ["shipmentSla", "SLA record for the other tenant's consignment"],
  ];

  for (const [model, label] of throughShipment) {
    const delegate = client[model];
    if (!delegate?.findMany) continue;
    await mustBeEmpty(label, () =>
      delegate.findMany({
        where: { shipment: { id: b.shipmentId! } },
        take: 5,
        // `orgId` rather than `id`: every scoped model has one, and not
        // every model is keyed on `id` — a validation error would read as a
        // pass while proving nothing.
        select: { orgId: true },
      }),
    );
  }
}

/** Public tracking is the surface a stranger reaches. */
async function probeTracking(a: Fixture, b: Fixture) {
  console.log("\nPublic tracking cannot cross tenants");

  if (!b.lrNumber) {
    console.log("  [SKIP] the other tenant has no consignment to look up");
    return;
  }

  // Two carriers issuing the same LR number is correct, not a collision:
  // numbering is per organisation and `Shipment.lrNumber` is unique only
  // within one. So the question is not "did this return nothing" but
  // "whose row did it return".
  const found = await prisma.shipment.findFirst({
    where: { lrNumber: b.lrNumber! },
    select: { id: true, orgId: true },
  });

  check(
    `LR ${b.lrNumber} does not resolve to the other tenant's consignment`,
    found?.id !== b.shipmentId,
    found ? "resolved to this tenant's own consignment of the same number" : "no such number here",
  );

  if (found) {
    check(
      `LR ${b.lrNumber} resolved inside this tenant`,
      found.orgId === a.orgId,
      `belongs to ${found.orgId}`,
    );
  }
}

/**
 * The backstop, checked directly.
 *
 * Everything above goes through the application client, so it tests the
 * Prisma extension. This asks the database the same question in raw SQL,
 * with no tenant on the session — which is what a forgotten filter, a raw
 * query, or a model missing from the generated list would actually look
 * like. If row-level security is doing its job the answer is nothing; if
 * the application is still connecting as the table owner, it is everything.
 */
async function probeRlsDirectly(a: Fixture) {
  console.log("\nRow-level security, asked in raw SQL");

  // A skip here is how a deployment ends up on one mechanism while a green
  // suite says it is on two. The whole point of this probe is the second
  // one, so its absence is a failure, not a note — and the message says
  // what to do rather than what happened.
  if (process.env.TENANT_RLS !== "on") {
    check(
      "row-level security is switched on",
      false,
      "TENANT_RLS is not \"on\", so the Prisma extension is the only thing " +
        "standing between two carriers. Set it, point DATABASE_URL at the " +
        "logistics_app role, and re-run — see the README.",
    );
    return;
  }

  const rows = await basePrisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM "shipment"
  `;
  check(
    "a raw count of every shipment returns nothing without a tenant on the session",
    Number(rows[0]?.n ?? 0) === 0,
    `saw ${rows[0]?.n ?? 0}`,
  );

  const scoped = await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${a.orgId}, TRUE)`;
    return tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "shipment"`;
  });

  // A tenant that has never booked anything cannot demonstrate this half:
  // "the policy lets its owner through" and "the tenant has no rows" both
  // count zero, and the two are not the same finding. Said out loud rather
  // than failed — a fresh install has no consignments and that is not a
  // defect — and rather than passed, which would let a policy that admits
  // nobody sail through on an empty table. Book one and it is a real check
  // again; CI does exactly that before this runs.
  if (Number(scoped[0]?.n ?? 0) === 0) {
    const total = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${a.orgId}, TRUE)`;
      return tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "organization"`;
    });

    // The organisation row itself is visible, so the session variable is
    // reaching the policies; it is only the shipment table that is empty.
    console.log(
      Number(total[0]?.n ?? 0) > 0
        ? "  [SKIP] this tenant has booked no consignment, so there is nothing " +
            "for the policy to let through — the session variable does reach " +
            "the policies, which the organisation row above proves"
        : "  [SKIP] this tenant has no rows at all to read back",
    );
    skips += 1;
    return;
  }

  check(
    "the same raw count sees this tenant's consignments once the session names it",
    true,
    `saw ${scoped[0]?.n ?? 0}`,
  );
}

/** With no tenant established at all, nothing may be read. */
async function probeNoContext(b: Fixture) {
  console.log("\nWith no tenant established");

  await mustThrow("a scoped read outside any tenant is refused", () =>
    prisma.shipment.findMany({ take: 1 }),
  );

  if (b.shipmentId) {
    await mustThrow("a scoped read by id outside any tenant is refused", () =>
      prisma.shipment.findUnique({ where: { id: b.shipmentId! } }),
    );
  }
}

/**
 * An LR number `owner` has issued and `other` has not.
 *
 * Read with `basePrisma` because it is fixture selection, not the thing
 * under test — the same reason `loadFixture` does.
 */
async function lrNumberOnlyHeldBy(
  owner: Fixture,
  other: Fixture,
): Promise<string | null> {
  const theirs = await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${owner.orgId}, TRUE)`;
    return tx.shipment.findMany({
      where: { orgId: owner.orgId, deletedAt: null },
      select: { lrNumber: true },
      take: 200,
    });
  });
  if (theirs.length === 0) return null;

  const numbers = theirs.map((row) => row.lrNumber);
  const shared = await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${other.orgId}, TRUE)`;
    return tx.shipment.findMany({
      where: { orgId: other.orgId, lrNumber: { in: numbers } },
      select: { lrNumber: true },
    });
  });

  const taken = new Set(shared.map((row) => row.lrNumber));
  return numbers.find((number) => !taken.has(number)) ?? null;
}

/** The HTTP surfaces, when a running server is pointed at. */
async function probeHttp(a: Fixture, b: Fixture) {
  if (!BASE) {
    console.log("\nHTTP probes skipped — pass --base http://localhost:3010 with the server running");
    return;
  }

  console.log(`\nOver HTTP, on tenant ${a.subdomain}'s host — ${BASE}`);

  if (!b.lrNumber) {
    console.log("  [SKIP] the other tenant has no consignment to look up");
    return;
  }

  // `hostFetch`, not `fetch`. Both obvious approaches fail silently here
  // and this file used to use one of them: `fetch` cannot resolve
  // `acme.localhost` because `*.localhost` is a browser convention rather
  // than DNS, and `fetch(url, { headers: { host } })` is worse — undici
  // drops `host` as a forbidden header, so the request goes wherever the
  // URL pointed while the probe reports on somewhere else. See the note in
  // `scripts/host-fetch.ts`.
  const host = hostFor(a.subdomain);

  // The number has to be one only the other carrier holds.
  //
  // Numbering is per organisation — `probeTracking` above spells this out —
  // so two carriers issuing the same LR number is correct rather than a
  // collision. Against a shared number, "the page shows this number" is
  // equally what a leak and a correct answer look like, and asserting on it
  // reports a breach every time the seed gives both tenants the same
  // series. Asking for a number that exists only over there removes the
  // ambiguity: the only right answer is 404.
  const exclusive = await lrNumberOnlyHeldBy(b, a);
  if (!exclusive) {
    console.log(
      `  [SKIP] every one of ${b.slug}'s LR numbers is also issued by ${a.slug}, ` +
        "so a tracking lookup cannot tell a leak from a correct answer",
    );
  } else {
    const page = await hostFetch(host, PORT, `/track/${encodeURIComponent(exclusive)}`);
    const empty = page.status === 404 || page.body.includes("Nothing found");
    // Not "the body mentions the number": the empty state echoes the query
    // back, in the title and in "No consignment matches …", so its presence
    // is what both a leak and a correct refusal look like. The empty state
    // itself is the signal, and asserting on its copy means a rewrite of
    // that copy fails the suite rather than quietly disarming it.
    check(
      `GET /track/${exclusive} does not reveal the other tenant's consignment`,
      empty,
      empty ? `status ${page.status}` : `status ${page.status} — the tracking card rendered`,
    );
  }

  const api = await hostFetch(host, PORT, `/api/v1/track/${encodeURIComponent(b.lrNumber)}`);
  check(
    `GET /api/v1/track/${b.lrNumber} is refused without a key for that tenant`,
    api.status === 401 || api.status === 403 || api.status === 404,
    `status ${api.status}`,
  );
}

// ────────────────────────────────────────────────────────────
// Stored files
// ────────────────────────────────────────────────────────────

/**
 * Object keys carry the tenant, and that is checkable without a server.
 *
 * The route probes below prove the handler refuses. This proves the thing
 * underneath them: that a key from one carrier cannot *name* another's
 * file, so a key that escapes into a log line, a support ticket or a
 * mis-set foreign key is still not a way in. A failure here is the reason
 * the storage migration exists, and the remedy is printed with it.
 */
function probeObjectKeyShape(fixtures: Fixture[]) {
  console.log("\nStored object keys are partitioned by tenant");

  for (const fixture of fixtures) {
    if (fixture.objectKeys.length === 0) {
      console.log(`  [SKIP] ${fixture.slug} has stored no files`);
      continue;
    }

    const foreign = fixture.objectKeys.filter(
      (row) => objectKeyOrgId(row.objectKey) !== fixture.orgId,
    );

    check(
      `all ${fixture.objectKeys.length} of ${fixture.slug}'s object keys begin with its own organisation`,
      foreign.length === 0,
      foreign.length
        ? `${foreign.length} do not — e.g. ${foreign[0].objectKey}. ` +
          "Run: npx tsx scripts/migrate-storage-keys.ts --apply"
        : "",
    );
  }
}

/** Sign in to the operations app on one carrier's host. */
async function signInAsOps(host: string) {
  const jar = new CookieJar();
  const csrf = await hostFetch(host, PORT, "/api/auth/csrf", { cookie: jar.header() });
  jar.absorb(csrf);

  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };
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

  return { jar, ok: !(response.location ?? "").includes("error") };
}

/** Sign in to the customer portal on one carrier's host. */
async function signInAsCustomer(host: string, email: string) {
  const jar = new CookieJar();
  const csrf = await hostFetch(host, PORT, "/api/auth/csrf", { cookie: jar.header() });
  jar.absorb(csrf);

  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };
  const response = await hostFetch(host, PORT, "/api/auth/callback/customer", {
    method: "POST",
    cookie: jar.header(),
    body: new URLSearchParams({
      email,
      password: PORTAL_PASSWORD,
      csrfToken,
      callbackUrl: `http://${host}:${PORT}/portal`,
    }).toString(),
  });
  jar.absorb(response);

  return { jar, ok: !(response.location ?? "").includes("error") };
}

/** Serving the bytes is the failure; anything else is a refusal. */
function refused(response: HostResponse): boolean {
  return response.status !== 200;
}

/**
 * The two document routes, over HTTP, as a signed-in user of the wrong
 * carrier.
 *
 * These have to be HTTP probes. What is being tested is what a route
 * handler checks before it reads a byte — the POD route's ownership guard
 * used to compare two halves of the same URL and prove nothing — and no
 * amount of exercising Prisma reaches a route handler.
 *
 * Direction is chosen from the data, not from the `--a`/`--b` arguments.
 * Only a tenant that has actually taken a delivery has a photograph worth
 * stealing, and in most databases that is one of the two; a probe that
 * skipped because the nominated victim had nothing would report a pass it
 * had not earned.
 */
async function probeStorageRoutes(a: Fixture, b: Fixture) {
  if (!BASE) return;

  const victim = b.podAssets.length ? b : a.podAssets.length ? a : null;
  if (!victim) {
    console.log(
      "\nStored files over HTTP\n" +
        "  [SKIP] neither tenant has a POD photograph to try to steal. Seed one:\n" +
        "           npm run db:seed:demo",
    );
    return;
  }
  const attacker = victim === b ? a : b;

  console.log(
    `\nStored files over HTTP — ${attacker.slug} reaching for ${victim.slug}'s`,
  );

  const attackerHost = hostFor(attacker.subdomain);
  const victimHost = hostFor(victim.subdomain);
  const target = victim.podAssets[0];

  // ── The attacker's session has to be real ───────────────────
  const attackerSession = await signInAsOps(attackerHost);
  if (!attackerSession.ok) {
    console.log(
      `  [SKIP] could not sign in to ${attacker.slug} as ${OPS_MOBILE}. ` +
        "Set SMOKE_ADMIN_MOBILE / SMOKE_ADMIN_PASSWORD, or seed the tenant.",
    );
    return;
  }

  // The control. Without it a 404 below could mean "isolation works" or
  // "the cookie was never valid", and those are not the same result.
  const dashboard = await hostFetch(attackerHost, PORT, "/dashboard", {
    cookie: attackerSession.jar.header(),
  });
  if (dashboard.status !== 200) {
    console.log(
      `  [SKIP] the signed-in control failed — GET /dashboard on ${attacker.slug} ` +
        `returned ${dashboard.status}, so a 404 below would prove nothing.`,
    );
    return;
  }
  check(`control: ${attacker.slug} is signed in and reaching its own app`, true);

  // ── The POD photograph, by asset id ─────────────────────────
  const byId = await hostFetch(
    attackerHost,
    PORT,
    `/delivery/pod/${target.shipmentId}/asset/${target.assetId}`,
    { cookie: attackerSession.jar.header() },
  );
  check(
    `${attacker.slug} cannot fetch ${victim.slug}'s POD photograph by asset id`,
    refused(byId),
    byId.status === 200
      ? "LEAK — the image was served across a tenant boundary"
      : `HTTP ${byId.status}`,
  );

  // The same asset id hung off a consignment the attacker does own, which
  // is the shape the old guard was blind to: it compared the asset's owner
  // with the id in the URL, and both came from the URL.
  if (attacker.shipmentId) {
    const grafted = await hostFetch(
      attackerHost,
      PORT,
      `/delivery/pod/${attacker.shipmentId}/asset/${target.assetId}`,
      { cookie: attackerSession.jar.header() },
    );
    check(
      `nor by hanging that asset id off one of ${attacker.slug}'s own consignments`,
      refused(grafted),
      grafted.status === 200
        ? "LEAK — the image was served across a tenant boundary"
        : `HTTP ${grafted.status}`,
    );
  }

  // ── The bytes, by guessing at the path ──────────────────────
  // The key is the address of the file. If the tree were reachable as
  // static content — under `public/`, or behind a rewrite somebody adds
  // later — the route's checks would be beside the point.
  for (const path of [
    `/storage/${target.objectKey}`,
    `/${target.objectKey}`,
    `/_next/static/${target.objectKey}`,
  ]) {
    const guessed = await hostFetch(attackerHost, PORT, path, {
      cookie: attackerSession.jar.header(),
    });
    check(
      `GET ${path} serves nothing`,
      refused(guessed),
      guessed.status === 200 ? "LEAK — the storage tree is being served" : `HTTP ${guessed.status}`,
    );
  }

  // ── The route is a real route, and the guard is a real guard ─
  // Proved from inside the owning tenant, where a 200 is expected: the
  // asset must serve under its own consignment and 404 under another of
  // the same carrier's. This is the half that fails if somebody deletes
  // the ownership check and leaves tenant scoping to carry everything.
  const victimSession = await signInAsOps(victimHost);
  if (!victimSession.ok) {
    console.log(`  [SKIP] could not sign in to ${victim.slug} to run the positive control`);
  } else {
    const own = await hostFetch(
      victimHost,
      PORT,
      `/delivery/pod/${target.shipmentId}/asset/${target.assetId}`,
      { cookie: victimSession.jar.header() },
    );
    check(
      `control: ${victim.slug} can fetch its own POD photograph`,
      own.status === 200,
      `HTTP ${own.status}`,
    );

    const other = victim.podAssets.find((row) => row.shipmentId !== target.shipmentId);
    if (other) {
      const misfiled = await hostFetch(
        victimHost,
        PORT,
        `/delivery/pod/${other.shipmentId}/asset/${target.assetId}`,
        { cookie: victimSession.jar.header() },
      );
      check(
        "and cannot fetch it under a different consignment of its own",
        refused(misfiled),
        misfiled.status === 200
          ? "LEAK — the route serves any asset under any consignment id"
          : `HTTP ${misfiled.status}`,
      );
    } else {
      console.log(
        `  [SKIP] ${victim.slug} has only one POD photograph, so the ` +
          "wrong-consignment probe has nothing to point at",
      );
    }
  }

  await probeInvoiceDocument(a, b);
}

/**
 * The invoice PDF route, which refuses on the same two grounds.
 *
 * The route resolves the asset from the *invoice* id through a query that
 * already carries the account, so the strongest form of the probe reaches
 * for the other carrier's invoice by its real id. Billing is the last part
 * of this product to be seeded, though, and a probe that disappears the
 * moment the fixture is missing is a probe nobody notices has stopped
 * running. So it degrades rather than skips: with no invoice to name it
 * asks for one that cannot exist, which still exercises the handler and
 * still insists on 404 — never a 403, which would confirm an id is real,
 * and never a 500, which is how a route that stopped resolving through the
 * account would announce itself. The label says which form ran.
 */
async function probeInvoiceDocument(a: Fixture, b: Fixture) {
  // Which carrier plays the attacker is decided here rather than inherited
  // from the POD probe above. The portal is a gated module, so it answers
  // on one carrier's host and 404s on another's, and a probe fired at a
  // host where the portal is switched off would record a refusal the route
  // never made.
  let chosen: { attacker: Fixture; victim: Fixture; host: string } | null = null;
  for (const [attacker, victim] of [
    [a, b],
    [b, a],
  ] as Array<[Fixture, Fixture]>) {
    const host = hostFor(attacker.subdomain);
    const login = await hostFetch(host, PORT, "/portal/login");
    if (login.status === 200) {
      chosen = { attacker, victim, host };
      break;
    }
  }

  if (!chosen) {
    console.log(
      "  [SKIP] neither carrier serves the customer portal, so the invoice " +
        "document route cannot be reached from anywhere",
    );
    return;
  }

  const { attacker, victim, host: attackerHost } = chosen;
  const invoiceId =
    victim.invoiceWithDocumentId ?? victim.invoiceId ?? "cq0000000000000000000000";
  const what = victim.invoiceWithDocumentId
    ? `${victim.slug}'s invoice document`
    : victim.invoiceId
      ? `${victim.slug}'s invoice (no PDF rendered for it yet)`
      : "an invoice id that exists nowhere";

  const path = `/portal/invoices/${invoiceId}/document`;

  const anonymous = await hostFetch(attackerHost, PORT, path);
  check(
    `the invoice document route serves nothing to an anonymous caller (${what})`,
    refused(anonymous),
    anonymous.status === 200
      ? "LEAK — an invoice PDF was served without a session"
      : `HTTP ${anonymous.status}`,
  );

  if (!attacker.portalEmail) {
    console.log(
      `  [SKIP] ${attacker.slug} has no portal login, so the signed-in half ` +
        "of the invoice probe cannot run",
    );
    return;
  }

  const session = await signInAsCustomer(attackerHost, attacker.portalEmail);
  if (!session.ok) {
    console.log(
      `  [SKIP] could not sign in to ${attacker.slug}'s portal as ${attacker.portalEmail}`,
    );
    return;
  }

  const overview = await hostFetch(attackerHost, PORT, "/portal", {
    cookie: session.jar.header(),
  });
  if (overview.status !== 200) {
    console.log(
      `  [SKIP] the portal control failed — GET /portal returned ${overview.status}`,
    );
    return;
  }

  const reached = await hostFetch(attackerHost, PORT, path, {
    cookie: session.jar.header(),
  });
  check(
    `a portal customer of ${attacker.slug} asking for ${what} gets a 404`,
    reached.status === 404,
    reached.status === 200
      ? "LEAK — an invoice PDF crossed a tenant boundary"
      : `HTTP ${reached.status}${
          reached.status === 403 ? " — 403 confirms the id exists; 404 is the correct refusal" : ""
        }`,
  );
}

async function main() {
  console.log(`\nTenant isolation — acting as "${SLUG_A}", trying to reach "${SLUG_B}"\n`);

  const [a, b] = await Promise.all([loadFixture(SLUG_A), loadFixture(SLUG_B)]);

  if (a.orgId === b.orgId) {
    throw new Error("Both arguments resolve to the same organisation; there is nothing to prove.");
  }

  console.log(`  ${a.slug} → ${a.orgId}`);
  console.log(`  ${b.slug} → ${b.orgId}`);

  const ctxA = await contextFor(SLUG_A);

  await runWithTenant(ctxA, async () => {
    await probeDirectReads(b);
    await probeWrites(b);
    await probeEveryScopedModel(a);
    await probeMasters(a, b);
    await probeChildRows(a, b);
    await probeTracking(a, b);
  });

  // Outside runWithTenant, and outside any request: there is no tenant.
  await probeNoContext(b);
  await probeRlsDirectly(a);
  probeObjectKeyShape([a, b]);
  await probeHttp(a, b);
  await probeStorageRoutes(a, b);

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} probe(s) refused as they should be, ` +
      `${failures} leaked` +
      (skips > 0 ? `, ${skips} could not be run` : "") +
      ".\n",
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
