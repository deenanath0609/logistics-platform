/**
 * Fetches a real shipment's PUBLIC tracking page as an anonymous visitor
 * and asserts that nothing internal reaches the HTML.
 *
 *   npx tsx scripts/verify-tracking-privacy.ts [tenant-subdomain] [baseUrl]
 *
 * The unit tests assert this against the projection function. This asserts
 * it against the rendered page, which is what an actual competitor or
 * curious consignee would see — a field can leak through a layout, a
 * breadcrumb, or a debug attribute without the projection ever changing.
 */
import "dotenv/config";
import { basePrisma, prisma } from "../src/lib/prisma";
import { getEnv } from "../src/lib/env";
import {
  runWithTenant,
  tenantContextFor,
  tenantOrigin,
  type ResolvedOrg,
  type TenantContext,
} from "../src/lib/tenant";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};

/**
 * The organisation this run acts as.
 *
 * There is no request here and so no `Host` header, which means every
 * tenant-scoped query would be refused until one is named. Naming it on the
 * command line rather than reading an environment variable keeps the choice
 * in the shell history of whoever ran the script, next to the results.
 *
 * `findFirstOrThrow` on `basePrisma`: `Organization` is the tenant list
 * itself, one of the two tables ADR 001 keeps global.
 */
async function actingTenant(): Promise<{ org: ResolvedOrg; tenant: TenantContext }> {
  const subdomain = process.argv[2] ?? "city-logistics";

  const org = await basePrisma.organization.findFirstOrThrow({
    where: { subdomain },
    select: {
      id: true,
      slug: true,
      subdomain: true,
      customDomain: true,
      status: true,
    },
  });

  const tenant = tenantContextFor(org, "job");
  if (!tenant) {
    throw new Error(`Organisation "${subdomain}" is closed; refusing to run against it.`);
  }
  return { org, tenant };
}

/**
 * Which host to fetch the tracking page from.
 *
 * The page resolves its own tenant from the `Host` header, so pointing this
 * at the bare development host while reading another carrier's shipment
 * would compare one company's LR against another company's page — and a
 * page that simply does not know the LR leaks nothing, so the run would
 * pass while proving nothing at all. So the base URL is always the tenant's
 * own origin, in development as in production — the bare platform domain
 * belongs to the operator console and serves no carrier at all.
 */
function baseUrlFor(org: ResolvedOrg): string {
  const override = process.argv[3];
  if (override) return override;

  const env = getEnv();
  const app = new URL(env.APP_URL);
  return tenantOrigin(
    org,
    env.APP_ROOT_DOMAIN,
    app.protocol.replace(":", ""),
    app.port || undefined,
  );
}

async function run(BASE: string) {
  const shipment = await prisma.shipment.findFirst({
    where: { deletedAt: null },
    orderBy: { bookedAt: "desc" },
    include: {
      originBranch: true,
      destinationBranch: true,
      currentBranch: true,
      bookedBy: { select: { name: true } },
      consignorCity: { select: { name: true } },
      consigneeCity: { select: { name: true } },
      events: {
        include: {
          branch: { select: { code: true, name: true } },
          user: { select: { name: true } },
          reasonCode: { select: { code: true, name: true } },
          // `ShipmentEvent` carries `vehicleId` and `tripId` as bare
          // columns — the tracking tables are deliberately decoupled from
          // the operational ones — so the plate and the trip number are
          // resolved separately below.
        },
      },
    },
  });

  if (!shipment) {
    console.log("  No shipments in the database — run verify-spine.ts first.\n");
    process.exit(1);
  }

  const response = await fetch(`${BASE}/track/${shipment.lrNumber}`);
  const html = await response.text();

  check("page renders without a login", response.status === 200, `status ${response.status}`);
  check("the LR number is shown", html.includes(shipment.lrNumber));
  check(
    "the destination city is shown",
    html.includes(shipment.consigneeCity.name),
    shipment.consigneeCity.name,
  );

  // Everything below must be ABSENT. These are the values a competitor
  // would want and a consignee has no business seeing.
  const secrets: Array<[string, string | null | undefined]> = [
    ["origin branch code", shipment.originBranch.code],
    ["origin branch name", shipment.originBranch.name],
    ["destination branch code", shipment.destinationBranch.code],
    ["destination branch name", shipment.destinationBranch.name],
    ["current branch code", shipment.currentBranch?.code],
    ["booking staff name", shipment.bookedBy?.name],
    ["consignor address", shipment.consignorAddress],
    ["consignee address", shipment.consigneeAddress],
    ["consignee phone", shipment.consigneePhone],
    ["consignor phone", shipment.consignorPhone],
    ["grand total", Number(shipment.grandTotal) > 0 ? String(shipment.grandTotal) : null],
    ["freight amount", Number(shipment.freightAmount) > 0 ? String(shipment.freightAmount) : null],
    ["COD amount", shipment.codAmount ? String(shipment.codAmount) : null],
    ["internal shipment id", shipment.id],
  ];

  for (const event of shipment.events) {
    if (event.user?.name) secrets.push(["event staff name", event.user.name]);
    if (event.branch?.code) secrets.push(["event branch code", event.branch.code]);
    if (event.remarks) secrets.push(["internal remarks", event.remarks]);
    if (event.reasonCode?.code) secrets.push(["reason code", event.reasonCode.code]);

    // ── What tracking adds to this log ──────────────────────
    //
    // A GPS device id is the worst of these: it is the identifier a
    // competitor would hand to the telematics vendor, and it is stamped on
    // every automatic arrival. The vehicle's plate and the trip number are
    // the line-haul plan — which truck runs which lane, on what schedule —
    // and the coordinates on a fence crossing are the yard itself.
    if (event.deviceId) secrets.push(["GPS device id", event.deviceId]);
    if (event.latitude != null) {
      secrets.push(["event latitude", Number(event.latitude).toFixed(4)]);
    }
    if (event.longitude != null) {
      secrets.push(["event longitude", Number(event.longitude).toFixed(4)]);
    }

    // The payload a fence crossing carries: the fence's own name — which
    // embeds the branch — the adapter code, and, on a movement typed by
    // hand, the name of the person who typed it.
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};

    for (const [key, label] of [
      ["geofence", "geofence name"],
      ["trip", "trip number in payload"],
      ["provider", "telematics adapter code"],
      ["enteredBy", "name of the person who typed the movement"],
    ] as const) {
      const value = payload[key];
      if (typeof value === "string") secrets.push([label, value]);
    }
  }

  // The vehicles and trips this consignment's own events name. Resolved by
  // id because `ShipmentEvent` holds no relation to either.
  const vehicleIds = [
    ...new Set(
      shipment.events
        .map((event) => event.vehicleId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const tripIds = [
    ...new Set(
      shipment.events
        .map((event) => event.tripId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  if (vehicleIds.length > 0) {
    const vehicles = await prisma.vehicle.findMany({
      where: { id: { in: vehicleIds } },
      select: { registrationNumber: true, gpsDeviceId: true },
    });
    for (const vehicle of vehicles) {
      secrets.push(["vehicle registration", vehicle.registrationNumber]);
      if (vehicle.gpsDeviceId) {
        secrets.push(["vehicle's GPS device id", vehicle.gpsDeviceId]);
      }
    }
  }

  if (tripIds.length > 0) {
    const trips = await prisma.trip.findMany({
      where: { id: { in: tripIds } },
      select: { number: true },
    });
    for (const trip of trips) secrets.push(["trip number", trip.number]);
  }

  // Every fence this carrier has drawn. A fence name is "Delhi Hub — site":
  // the branch, and the fact that it is a hub, in one string.
  const fences = await prisma.geofence.findMany({
    take: 20,
    select: { name: true },
  });
  for (const fence of fences) secrets.push(["geofence name", fence.name]);

  const seen = new Set<string>();
  let leaks = 0;

  for (const [label, value] of secrets) {
    if (!value || value.length < 3) continue;
    const key = `${label}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (html.includes(value)) {
      leaks++;
      console.log(`  [FAIL] LEAKED ${label}: "${value}"`);
      failures++;
    }
  }

  check(
    `no internal data in the rendered page (${seen.size} values checked)`,
    leaks === 0,
    leaks === 0 ? "" : `${leaks} leaked`,
  );

  // An unauthenticated endpoint that accepts an identifier is an
  // enumeration target; a miss must not confirm or deny anything useful.
  const bogus = await fetch(`${BASE}/track/CL999999999999`);
  const bogusHtml = await bogus.text();
  check(
    "an unknown LR does not error out",
    bogus.status === 200 || bogus.status === 404,
    `status ${bogus.status}`,
  );
  check(
    "an unknown LR reveals no stack trace",
    !bogusHtml.includes("prisma") && !bogusHtml.includes("at async"),
  );

  console.log(
    failures === 0
      ? `\nNothing leaked. Checked ${seen.size} internal values against ${shipment.lrNumber}.\n`
      : `\n${failures} problem(s).\n`,
  );

  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  const { org, tenant } = await actingTenant();
  const base = baseUrlFor(org);

  console.log(
    `\nPublic tracking privacy — ${base} · acting as ${tenant.slug} (${tenant.subdomain})\n`,
  );

  await runWithTenant(tenant, () => run(base));
}

main().catch(async (error) => {
  console.error("\nCrashed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
