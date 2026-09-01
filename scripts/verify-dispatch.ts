/**
 * Dispatch — manifests, trips, the gate, the fleet behind them, and the
 * vendors who are paid for the running.
 *
 *   npx tsx scripts/verify-dispatch.ts [--base http://localhost:3010]
 *
 * Two halves, and both are needed.
 *
 * The screens are driven over HTTP as a signed-in person, because a
 * service that works and a screen that cannot reach it is the failure
 * this module kept having: `setManifestTrip` was permissioned, scoped,
 * audited and unreachable, so a manifest built before the lorry turned up
 * could never be joined to one.
 *
 * The rules are exercised against the services, because a refusal is only
 * proven by *also* proving nothing was written — a service that returns
 * `{ ok: false }` after having already inserted the row reads identically
 * to one that refused, and only the row count tells them apart. Every
 * refusal below is followed by a count taken on both sides of it.
 *
 * ── No assertion here depends on how much data is in the database ───────
 *
 * `verify-reweigh.ts` compared a `count()` of a whole table against a
 * `findMany({ take: 6 })` and started failing the day the table held six
 * rows — a false defect while the product was fine. So this script builds
 * its own vehicle, its own driver, its own consignments and its own
 * vendor, all prefixed `VD-`, asserts only against those, and retires
 * them at the end. The seeded fleet is largely mid-trip and is left alone.
 */
import "dotenv/config";
import { basePrisma, prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor, type TenantContext } from "../src/lib/tenant";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";
import type { SessionUser } from "../src/lib/auth/session";
import {
  createTrip,
  gateOut,
  closeTrip,
  markVehicleReported,
} from "../src/lib/transport/trip";
import {
  createManifest,
  addShipmentsToManifest,
  closeManifest,
  setManifestTrip,
} from "../src/lib/transport/manifest";
import { createVendorBill } from "../src/lib/billing/vendor";
import { saveVendorRateLine } from "../src/lib/billing/vendor-rates";
import { VENDOR_BILL_SERIES } from "../src/lib/billing/default-series";
import { isoDate } from "../src/components/finance/format";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "true");
}

const BASE = args.get("base") ?? "http://localhost:3010";
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
const SUBDOMAIN = args.get("tenant") ?? "city-logistics";
const HOST = `${SUBDOMAIN}.${ROOT}`;

const ADMIN_MOBILE = args.get("admin") ?? process.env.SMOKE_ADMIN_MOBILE ?? "9999999999";
/** BR-GGN's dispatch manager: branch digit 3, post digit 4. */
const BRANCH_DISPATCHER = args.get("dispatcher") ?? "9333000004";
const PASSWORD = args.get("password") ?? "Admin@123";

/** Everything this script creates carries it, so cleanup cannot overreach. */
const TAG = "VD-";
/**
 * A per-run suffix on the identifiers that carry a unique constraint.
 *
 * `shipment_event` is append-only at the database — a trigger refuses
 * DELETE outright — so a consignment this script raises can be retired but
 * never erased, and a fixed LR number would collide on the second run.
 */
const RUN = Date.now().toString(36).slice(-5).toUpperCase();

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

/**
 * A page GET, retried once on a 5xx.
 *
 * Not leniency about server errors — a second 5xx still fails. The dev
 * server compiles a route on its first request after the module graph
 * under it changes, and that one request can answer 500 with a chunk
 * error while the product is fine. Retrying once tells a cold compile
 * apart from a page that is actually broken, which is the difference
 * between a gate worth running and a gate people learn to re-run.
 */
async function page(
  path: string,
  jar: CookieJar,
): Promise<Awaited<ReturnType<typeof hostFollow>>> {
  const first = await hostFollow(HOST, PORT, path, jar);
  if (first.status < 500) return first;
  return hostFollow(HOST, PORT, path, jar);
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
 * A session for the service layer, assembled the same way the app does.
 *
 * `UserBranchScope` has no rows, so a `BRANCH_SET` role collapses to the
 * primary branch. That is somebody else's repair; this script only has to
 * reason about it correctly, which is why the branch-scoped checks below
 * are written against the one branch the dispatcher actually reaches.
 */
async function actorFor(mobile: string): Promise<SessionUser | null> {
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
    branchIds:
      widest === "NETWORK" ? null : user.primaryBranch ? [user.primaryBranch.id] : [],
  };
}

const MS_PER_DAY = 86_400_000;
/** A `@db.Date` value, built on the UTC calendar the column stores. */
function day(offsetDays: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) +
      offsetDays * MS_PER_DAY,
  );
}

/**
 * Retires everything a previous run left behind, and everything this one
 * made. Scoped to the `VD-` prefix throughout: the seeded fleet is
 * mid-trip and none of it is ours to touch.
 */
async function cleanup(): Promise<void> {
  const trips = await prisma.trip.findMany({
    where: { number: { startsWith: "" }, vehicle: { registrationNumber: { startsWith: TAG } } },
    select: { id: true },
  });
  const tripIds = trips.map((trip) => trip.id);

  const manifests = await prisma.manifest.findMany({
    where: { remarks: { startsWith: TAG } },
    select: { id: true },
  });
  const manifestIds = manifests.map((manifest) => manifest.id);

  const shipments = await prisma.shipment.findMany({
    where: { lrNumber: { startsWith: TAG } },
    select: { id: true },
  });
  const shipmentIds = shipments.map((shipment) => shipment.id);

  if (manifestIds.length) {
    await prisma.manifestLine.deleteMany({ where: { manifestId: { in: manifestIds } } });
  }
  if (tripIds.length) {
    await prisma.loadingSheetLine.deleteMany({ where: { loadingSheet: { tripId: { in: tripIds } } } });
    await prisma.loadingSheet.deleteMany({ where: { tripId: { in: tripIds } } });
    await prisma.tripEvent.deleteMany({ where: { tripId: { in: tripIds } } });
    await prisma.manifest.updateMany({
      where: { tripId: { in: tripIds } },
      data: { tripId: null },
    });
  }
  if (manifestIds.length) {
    await prisma.manifest.deleteMany({ where: { id: { in: manifestIds } } });
  }
  if (tripIds.length) {
    await prisma.vehicleStatusLog.deleteMany({ where: { tripId: { in: tripIds } } });
    await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
  }
  if (shipmentIds.length) {
    // Retired, not erased. `shipment_event` is append-only by trigger —
    // "record a compensating entry instead" — so the consignment cannot
    // be deleted without its history. Soft-deleting is what the product
    // itself does, and it takes these rows off every screen.
    await prisma.shipment.updateMany({
      where: { id: { in: shipmentIds }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  const vehicles = await prisma.vehicle.findMany({
    where: { registrationNumber: { startsWith: TAG } },
    select: { id: true },
  });
  if (vehicles.length) {
    const ids = vehicles.map((vehicle) => vehicle.id);
    await prisma.vehicleStatusLog.deleteMany({ where: { vehicleId: { in: ids } } });
    await prisma.vehicleDocument.deleteMany({ where: { vehicleId: { in: ids } } });
    await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.driver.deleteMany({ where: { code: { startsWith: TAG } } });

  const contracts = await prisma.vendorRateContract.findMany({
    where: { code: { startsWith: TAG } },
    select: { id: true },
  });
  if (contracts.length) {
    const ids = contracts.map((contract) => contract.id);
    await prisma.vendorRateLine.deleteMany({ where: { contractId: { in: ids } } });
    await prisma.vendorRateContract.deleteMany({ where: { id: { in: ids } } });
  }

  const vendors = await prisma.vendor.findMany({
    where: { code: { startsWith: TAG } },
    select: { id: true },
  });
  if (vendors.length) {
    const ids = vendors.map((vendor) => vendor.id);
    await prisma.vendorBillLine.deleteMany({ where: { bill: { vendorId: { in: ids } } } });
    await prisma.vendorBill.deleteMany({ where: { vendorId: { in: ids } } });
    await prisma.vendorBankAccount.deleteMany({ where: { vendorId: { in: ids } } });
    await prisma.vendor.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.vehicleType.deleteMany({ where: { code: { startsWith: TAG } } });
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed(admin: SessionUser) {
  const [origin, destination, elsewhere] = await Promise.all([
    prisma.branch.findFirstOrThrow({ where: { code: "HO-DEL" }, select: { id: true, code: true } }),
    prisma.branch.findFirstOrThrow({ where: { code: "HUB-JAI" }, select: { id: true, code: true } }),
    prisma.branch.findFirstOrThrow({ where: { code: "BR-BOM" }, select: { id: true, code: true } }),
  ]);

  const [serviceType, city] = await Promise.all([
    prisma.serviceType.findFirstOrThrow({ where: { isActive: true }, select: { id: true } }),
    prisma.city.findFirstOrThrow({ where: { isActive: true }, select: { id: true } }),
  ]);

  // A class of our own, rated at a weight this script can cross on
  // purpose. Nothing seeded is small enough to overload deliberately
  // without loading a hundred consignments onto it.
  const smallType = await prisma.vehicleType.create({
    data: {
      orgId: admin.orgId,
      code: `${TAG}SMALL${RUN}`,
      name: "Verification tempo — 300 kg",
      capacityKg: "300.00",
      maxSpeedKmph: 60,
      isActive: true,
    },
    select: { id: true, capacityKg: true },
  });

  const roadworthy = await prisma.vehicle.create({
    data: {
      orgId: admin.orgId,
      registrationNumber: `${TAG}OK${RUN}`,
      vehicleTypeId: smallType.id,
      branchId: origin.id,
      ownership: "OWN",
      status: "AVAILABLE",
      isActive: true,
      documents: {
        create: {
          orgId: admin.orgId,
          kind: "INSURANCE",
          documentNumber: `${TAG}INS-OK-${RUN}`,
          expiresOn: day(120),
          isMandatory: true,
        },
      },
    },
    select: { id: true, registrationNumber: true },
  });

  // The same lorry in every respect except that its insurance ran out
  // last week. BRD §A.8 says it may not be put on a trip.
  const lapsed = await prisma.vehicle.create({
    data: {
      orgId: admin.orgId,
      registrationNumber: `${TAG}LAP${RUN}`,
      vehicleTypeId: smallType.id,
      branchId: origin.id,
      ownership: "OWN",
      status: "AVAILABLE",
      isActive: true,
      documents: {
        create: {
          orgId: admin.orgId,
          kind: "INSURANCE",
          documentNumber: `${TAG}INS-LAP-${RUN}`,
          expiresOn: day(-7),
          isMandatory: true,
        },
      },
    },
    select: { id: true, registrationNumber: true },
  });

  const goodDriver = await prisma.driver.create({
    data: {
      orgId: admin.orgId,
      code: `${TAG}DRV1${RUN}`,
      name: "Verification Driver",
      mobile: `98${RUN.charCodeAt(0)}${Date.now() % 100000}`.slice(0, 10),
      branchId: origin.id,
      status: "AVAILABLE",
      isActive: true,
      licenceNumber: `${TAG}DL1${RUN}`,
      licenceExpiry: day(200),
    },
    select: { id: true, name: true },
  });

  // Suspended, with a perfectly valid licence. The checkpoint commit
  // pinned every driver to AVAILABLE before asking `canAssignDriver`,
  // which erased exactly this refusal.
  const suspended = await prisma.driver.create({
    data: {
      orgId: admin.orgId,
      code: `${TAG}DRV2${RUN}`,
      name: "Suspended Driver",
      mobile: `97${RUN.charCodeAt(1)}${Date.now() % 100000}`.slice(0, 10),
      branchId: origin.id,
      status: "SUSPENDED",
      isActive: true,
      licenceNumber: `${TAG}DL2${RUN}`,
      licenceExpiry: day(200),
    },
    select: { id: true, name: true },
  });

  async function consignment(
    suffix: string,
    weightKg: string,
    overrides: Record<string, unknown> = {},
  ) {
    return prisma.shipment.create({
      data: {
        orgId: admin.orgId,
        lrNumber: `${TAG}${RUN}${suffix}`,
        mode: "PTL",
        serviceTypeId: serviceType.id,
        bookingBranchId: origin.id,
        originBranchId: origin.id,
        destinationBranchId: destination.id,
        currentBranchId: origin.id,
        currentStatus: "PROCESSED",
        consignorName: "Verification Consignor",
        consignorPhone: "9800000903",
        consignorAddress: "1 Test Road",
        consignorCityId: city.id,
        consignorPincode: "110001",
        consigneeName: "Verification Consignee",
        consigneePhone: "9800000904",
        consigneeAddress: "2 Test Road",
        consigneeCityId: city.id,
        consigneePincode: "302001",
        packageCount: 1,
        actualWeight: weightKg,
        chargeableWeight: weightKg,
        goodsDescription: "Dispatch verification — auto-generated",
        pickupRequired: false,
        ...overrides,
      },
      select: { id: true, lrNumber: true, chargeableWeight: true },
    });
  }

  // 200 + 200 against a 300 kg class: the first fits, the second cannot.
  const light = await consignment("LR0001", "200.000");
  const heavy = await consignment("LR0002", "200.000");

  // A full load, standing at a hub rather than where it was booked —
  // the case the trip screen posted the wrong branch for.
  const ftl = await consignment("LR0003", "250.000", {
    mode: "FTL",
    originBranchId: elsewhere.id,
    bookingBranchId: elsewhere.id,
    currentBranchId: origin.id,
  });

  const vendor = await prisma.vendor.create({
    data: {
      orgId: admin.orgId,
      code: `${TAG}V${RUN}`,
      name: "Verification Roadlines",
      kind: "TRANSPORTER",
      phone: "9800000905",
      isActive: true,
      isBlocked: false,
    },
    select: { id: true, name: true },
  });

  const contract = await prisma.vendorRateContract.create({
    data: {
      orgId: admin.orgId,
      vendorId: vendor.id,
      code: `${TAG}C${RUN}`,
      name: "Verification contract",
      effectiveFrom: day(-30),
      isActive: true,
    },
    select: { id: true },
  });

  return {
    origin,
    destination,
    elsewhere,
    smallType,
    roadworthy,
    lapsed,
    goodDriver,
    suspended,
    light,
    heavy,
    ftl,
    vendor,
    contract,
  };
}

// ────────────────────────────────────────────────────────────
// The rules
// ────────────────────────────────────────────────────────────

async function checkTripPlanning(admin: SessionUser, fx: Fixture) {
  section("Planning a trip");

  const before = await prisma.trip.count({ where: { vehicleId: fx.lapsed.id } });
  const refusedPaperwork = await createTrip(
    {
      vehicleId: fx.lapsed.id,
      originBranchId: fx.origin.id,
      destinationBranchId: fx.destination.id,
    },
    admin,
  );
  const after = await prisma.trip.count({ where: { vehicleId: fx.lapsed.id } });

  check(
    "a lorry whose insurance has lapsed cannot be put on a trip",
    !refusedPaperwork.ok && /expired/i.test(refusedPaperwork.ok ? "" : refusedPaperwork.error),
    refusedPaperwork.ok ? "it was accepted" : refusedPaperwork.error,
  );
  check(
    "and nothing was written either side of that refusal",
    before === 0 && after === 0,
    `${before} before, ${after} after`,
  );

  // The regression the checkpoint introduced: pinning the driver to
  // AVAILABLE before asking `canAssignDriver` erased the suspension.
  const beforeSuspended = await prisma.trip.count({ where: { driverId: fx.suspended.id } });
  const refusedDriver = await createTrip(
    {
      vehicleId: fx.roadworthy.id,
      driverId: fx.suspended.id,
      originBranchId: fx.origin.id,
      destinationBranchId: fx.destination.id,
    },
    admin,
  );
  const afterSuspended = await prisma.trip.count({ where: { driverId: fx.suspended.id } });

  check(
    "a suspended driver cannot be assigned",
    !refusedDriver.ok && /suspend/i.test(refusedDriver.ok ? "" : refusedDriver.error),
    refusedDriver.ok ? "it was accepted" : refusedDriver.error,
  );
  check(
    "and nothing was written either side of that refusal",
    beforeSuspended === 0 && afterSuspended === 0,
    `${beforeSuspended} before, ${afterSuspended} after`,
  );

  const planned = await createTrip(
    {
      vehicleId: fx.roadworthy.id,
      driverId: fx.goodDriver.id,
      originBranchId: fx.origin.id,
      destinationBranchId: fx.destination.id,
      plannedDepartureAt: new Date(Date.now() + 3_600_000),
    },
    admin,
  );
  check(
    "a roadworthy lorry with a licensed driver is accepted",
    planned.ok,
    planned.ok ? planned.number : planned.error,
  );
  if (!planned.ok) return null;

  // The trip is not on the road yet, so a second one may be planned
  // against the same lorry for tomorrow — but once it is loading, it may
  // not. This is why the checkpoint stopped reading the status column.
  await markVehicleReported({ tripId: planned.tripId }, admin);
  await prisma.trip.update({ where: { id: planned.tripId }, data: { status: "LOADING" } });

  const doubleBooked = await createTrip(
    {
      vehicleId: fx.roadworthy.id,
      originBranchId: fx.origin.id,
      destinationBranchId: fx.destination.id,
    },
    admin,
  );
  check(
    "the same lorry cannot be sent out twice while it is loading",
    !doubleBooked.ok && /loading/i.test(doubleBooked.ok ? "" : doubleBooked.error),
    doubleBooked.ok ? "it was accepted" : doubleBooked.error,
  );

  return planned.tripId;
}

async function checkFullTruck(admin: SessionUser, fx: Fixture) {
  section("The full-truck path, which skips the manifest");

  // Booked at BR-BOM, standing at HO-DEL. The truck loads where the
  // freight is, so HO-DEL is the only origin `createTrip` will accept.
  const wrongOrigin = await createTrip(
    {
      vehicleId: fx.roadworthy.id,
      originBranchId: fx.elsewhere.id,
      destinationBranchId: fx.destination.id,
      ftlShipmentId: fx.ftl.id,
    },
    admin,
  );
  check(
    "a full load cannot start from a branch it is not standing at",
    !wrongOrigin.ok,
    wrongOrigin.ok ? "it was accepted" : wrongOrigin.error,
  );

  const wrongDestination = await createTrip(
    {
      vehicleId: fx.roadworthy.id,
      originBranchId: fx.origin.id,
      destinationBranchId: fx.elsewhere.id,
      ftlShipmentId: fx.ftl.id,
    },
    admin,
  );
  check(
    "nor go anywhere but where its consignment is going",
    !wrongDestination.ok,
    wrongDestination.ok ? "it was accepted" : wrongDestination.error,
  );

  const beforeBind = await prisma.trip.count({ where: { ftlShipmentId: fx.ftl.id } });
  check(
    "and nothing was written either side of those refusals",
    beforeBind === 0,
    `${beforeBind} trips bound`,
  );

  // A second lorry, because the first is loading a part-load.
  const second = await prisma.vehicle.create({
    data: {
      orgId: admin.orgId,
      registrationNumber: `${TAG}FTL${RUN}`,
      vehicleTypeId: fx.smallType.id,
      branchId: fx.origin.id,
      ownership: "OWN",
      status: "AVAILABLE",
      isActive: true,
    },
    select: { id: true },
  });

  const bound = await createTrip(
    {
      vehicleId: second.id,
      originBranchId: fx.origin.id,
      destinationBranchId: fx.destination.id,
      ftlShipmentId: fx.ftl.id,
    },
    admin,
  );
  check(
    "bound to the branch the freight is standing at, it is accepted",
    bound.ok,
    bound.ok ? bound.number : bound.error,
  );
  if (!bound.ok) return;

  const spare = await prisma.vehicle.create({
    data: {
      orgId: admin.orgId,
      registrationNumber: `${TAG}SPR${RUN}`,
      vehicleTypeId: fx.smallType.id,
      branchId: fx.origin.id,
      ownership: "OWN",
      status: "AVAILABLE",
      isActive: true,
    },
    select: { id: true },
  });

  const twice = await createTrip(
    {
      vehicleId: spare.id,
      originBranchId: fx.origin.id,
      destinationBranchId: fx.destination.id,
      ftlShipmentId: fx.ftl.id,
    },
    admin,
  );
  check(
    "one consignment cannot be bound to two lorries",
    !twice.ok && /already on/i.test(twice.ok ? "" : twice.error),
    twice.ok ? "it was accepted" : twice.error,
  );

  // The whole point of FTL: no manifest, ever.
  const manifest = await createManifest(
    {
      originBranchId: fx.origin.id,
      destinationBranchId: fx.destination.id,
      remarks: `${TAG} full-truck check`,
    },
    admin,
  );
  if (manifest.ok) {
    const attached = await setManifestTrip(
      { manifestId: manifest.manifestId, tripId: bound.tripId },
      admin,
    );
    check(
      "a full-truck trip refuses to carry a manifest",
      !attached.ok && /full-truck/i.test(attached.ok ? "" : attached.error),
      attached.ok ? "it was attached" : attached.error,
    );

    const stillLoose = await prisma.manifest.findUnique({
      where: { id: manifest.manifestId },
      select: { tripId: true },
    });
    check(
      "and the manifest was not joined to it anyway",
      stillLoose?.tripId === null,
      String(stillLoose?.tripId),
    );
  }

  // Gate-out on a full truck moves the one consignment, with no manifest
  // in the picture at all — the path that is easy to leave half-built.
  const gate = await gateOut({ tripId: bound.tripId }, admin);
  check(
    "gate-out dispatches the bound consignment with no manifest involved",
    gate.ok && gate.moved === 1,
    gate.ok ? `${gate.moved} moved` : gate.error,
  );

  const shipment = await prisma.shipment.findUnique({
    where: { id: fx.ftl.id },
    select: { currentStatus: true },
  });
  check(
    "and the consignment reads as dispatched",
    shipment?.currentStatus === "DISPATCHED",
    String(shipment?.currentStatus),
  );

  const driverless = await prisma.trip.findUnique({
    where: { id: bound.tripId },
    select: { status: true, vehicle: { select: { status: true } } },
  });
  check(
    "the lorry is marked out on the road",
    driverless?.vehicle.status === "DISPATCHED",
    String(driverless?.vehicle.status),
  );
}

async function checkCapacity(admin: SessionUser, fx: Fixture, tripId: string | null) {
  section("Capacity — a rated payload that refuses, not a coloured bar");

  const manifest = await createManifest(
    {
      originBranchId: fx.origin.id,
      destinationBranchId: fx.destination.id,
      remarks: `${TAG} capacity check`,
    },
    admin,
  );
  check("a manifest can be raised", manifest.ok, manifest.ok ? manifest.number : manifest.error);
  if (!manifest.ok) return null;

  if (tripId) {
    const joined = await setManifestTrip({ manifestId: manifest.manifestId, tripId }, admin);
    check(
      "and joined to a lorry after the fact — the control that did not exist",
      joined.ok,
      joined.ok ? "attached" : joined.error,
    );
  }

  const first = await addShipmentsToManifest(
    { manifestId: manifest.manifestId, shipmentIds: [fx.light.id] },
    admin,
  );
  check(
    "200 kg goes onto a 300 kg lorry",
    first.ok && first.added.length === 1,
    first.rejected.map((r) => `${r.lrNumber}: ${r.reason}`).join(" · ") || "added",
  );

  const weightBefore = await prisma.manifest.findUnique({
    where: { id: manifest.manifestId },
    select: { totalWeight: true, totalShipments: true },
  });

  const second = await addShipmentsToManifest(
    { manifestId: manifest.manifestId, shipmentIds: [fx.heavy.id] },
    admin,
  );
  check(
    "a second 200 kg is refused — it would put the lorry over its rated payload",
    second.added.length === 0 &&
      second.rejected.some((r) => /rated payload/i.test(r.reason)),
    second.rejected.map((r) => `${r.lrNumber}: ${r.reason}`).join(" · ") || "it was added",
  );

  const weightAfter = await prisma.manifest.findUnique({
    where: { id: manifest.manifestId },
    select: { totalWeight: true, totalShipments: true },
  });
  check(
    "and nothing was written either side of that refusal",
    weightBefore?.totalWeight.toString() === weightAfter?.totalWeight.toString() &&
      weightBefore?.totalShipments === weightAfter?.totalShipments,
    `${weightBefore?.totalWeight} kg / ${weightBefore?.totalShipments} before, ${weightAfter?.totalWeight} kg / ${weightAfter?.totalShipments} after`,
  );

  const refusedShipment = await prisma.shipment.findUnique({
    where: { id: fx.heavy.id },
    select: { currentStatus: true },
  });
  check(
    "the refused consignment is still sitting on the floor, not manifested",
    refusedShipment?.currentStatus === "PROCESSED",
    String(refusedShipment?.currentStatus),
  );

  // Swap a bigger lorry under the manifest and the same box goes on.
  const bigType = await prisma.vehicleType.findFirstOrThrow({
    where: { isActive: true, code: "TRUCK32" },
    select: { id: true },
  });
  await prisma.vehicle.updateMany({
    where: { registrationNumber: `${TAG}OK${RUN}` },
    data: { vehicleTypeId: bigType.id },
  });

  const retry = await addShipmentsToManifest(
    { manifestId: manifest.manifestId, shipmentIds: [fx.heavy.id] },
    admin,
  );
  check(
    "on a bigger lorry the same consignment is accepted — the refusal was the payload, not the box",
    retry.added.length === 1,
    retry.rejected.map((r) => `${r.lrNumber}: ${r.reason}`).join(" · ") || "added",
  );

  // Now shrink it back underneath the load and try to close.
  await prisma.vehicle.updateMany({
    where: { registrationNumber: `${TAG}OK${RUN}` },
    data: { vehicleTypeId: fx.smallType.id },
  });

  const closedOver = await closeManifest({ manifestId: manifest.manifestId }, admin);
  check(
    "an overloaded manifest cannot be closed for dispatch",
    !closedOver.ok && /rated payload/i.test(closedOver.ok ? "" : closedOver.error),
    closedOver.ok ? "it closed" : closedOver.error,
  );

  const stillDraft = await prisma.manifest.findUnique({
    where: { id: manifest.manifestId },
    select: { status: true, closedAt: true },
  });
  check(
    "and it is still a draft, with no closed-at stamped on it",
    stillDraft?.status === "DRAFT" && stillDraft.closedAt === null,
    `${stillDraft?.status} / ${stillDraft?.closedAt}`,
  );

  await prisma.vehicle.updateMany({
    where: { registrationNumber: `${TAG}OK${RUN}` },
    data: { vehicleTypeId: bigType.id },
  });

  const closed = await closeManifest({ manifestId: manifest.manifestId }, admin);
  check(
    "within the payload it closes",
    closed.ok,
    closed.ok ? `${closed.number} at ${closed.load.percent}%` : closed.error,
  );

  return manifest.manifestId;
}

async function checkGate(admin: SessionUser, fx: Fixture, tripId: string | null) {
  section("The gate");
  if (!tripId) {
    console.log("  [SKIP] no trip was planned, so there is nothing at the gate");
    return;
  }

  const sheet = await prisma.loadingSheet.create({
    data: {
      orgId: admin.orgId,
      tripId,
      branchId: fx.origin.id,
      status: "OPEN",
      openedById: admin.id,
    },
    select: { id: true },
  });

  const refused = await gateOut({ tripId }, admin);
  check(
    "a lorry cannot leave while the loading sheet is still open",
    !refused.ok && /loading sheet/i.test(refused.ok ? "" : refused.error),
    refused.ok ? "it left" : refused.error,
  );

  const afterRefusal = await prisma.trip.findUnique({
    where: { id: tripId },
    select: { status: true, actualDepartureAt: true },
  });
  check(
    "and nothing was written either side of that refusal",
    afterRefusal?.status === "LOADING" && afterRefusal.actualDepartureAt === null,
    `${afterRefusal?.status} / ${afterRefusal?.actualDepartureAt}`,
  );

  await prisma.loadingSheet.update({
    where: { id: sheet.id },
    data: { status: "CLOSED", closedAt: new Date() },
  });

  const gated = await gateOut({ tripId, odometerKm: 100_000, sealNumber: `${TAG}SEAL${RUN}` }, admin);
  check(
    "with the sheet closed it gates out",
    gated.ok && gated.moved > 0,
    gated.ok ? `${gated.moved} consignment(s)` : gated.error,
  );

  const onTheRoad = await prisma.trip.findUnique({
    where: { id: tripId },
    select: {
      status: true,
      driverId: true,
      driver: { select: { status: true } },
      manifests: { select: { status: true } },
    },
  });
  check(
    "the manifest goes with it",
    onTheRoad?.manifests.every((manifest) => manifest.status === "DISPATCHED") ?? false,
    onTheRoad?.manifests.map((m) => m.status).join(", "),
  );
  check(
    "and the driver is marked out on the road",
    onTheRoad?.driver?.status === "ON_TRIP",
    String(onTheRoad?.driver?.status),
  );

  // Closing releases both. The checkpoint put the driver ON_TRIP at the
  // gate and nothing ever took them off it, so every driver in the
  // network would eventually read as permanently out.
  await prisma.trip.update({ where: { id: tripId }, data: { status: "ARRIVED" } });
  const closedTrip = await closeTrip({ tripId }, admin);
  check("the trip closes", closedTrip.ok, closedTrip.ok ? closedTrip.number : closedTrip.error);

  const released = await prisma.trip.findUnique({
    where: { id: tripId },
    select: {
      driver: { select: { status: true } },
      vehicle: { select: { status: true } },
    },
  });
  check(
    "and releases the driver back to the roster",
    released?.driver?.status === "AVAILABLE",
    String(released?.driver?.status),
  );
  check(
    "and the lorry with them",
    released?.vehicle.status === "AVAILABLE",
    String(released?.vehicle.status),
  );
}

async function checkScope(fx: Fixture) {
  section("Branch scope");

  const dispatcher = await actorFor(BRANCH_DISPATCHER);
  if (!dispatcher) {
    console.log(`  [SKIP] no branch dispatcher on ${BRANCH_DISPATCHER}`);
    return;
  }
  check(
    "the branch dispatcher is scoped to their own branch",
    dispatcher.branchIds !== null && !dispatcher.branchIds.includes(fx.origin.id),
    `covers ${dispatcher.branchIds?.length ?? "the network"}`,
  );
  if (dispatcher.branchIds === null) return;

  const trip = await prisma.trip.findFirst({
    where: { vehicle: { registrationNumber: `${TAG}FTL${RUN}` } },
    select: { id: true, status: true },
  });
  if (!trip) {
    console.log("  [SKIP] the full-truck trip was not created");
    return;
  }

  await prisma.trip.update({ where: { id: trip.id }, data: { status: "ARRIVED" } });
  const outsider = await closeTrip({ tripId: trip.id }, dispatcher);
  check(
    "a trip running between two branches they do not cover cannot be closed by them",
    !outsider.ok && /another branch/i.test(outsider.ok ? "" : outsider.error),
    outsider.ok ? "it closed" : outsider.error,
  );

  const untouched = await prisma.trip.findUnique({
    where: { id: trip.id },
    select: { status: true, closedAt: true },
  });
  check(
    "and nothing was written either side of that refusal",
    untouched?.status === "ARRIVED" && untouched.closedAt === null,
    `${untouched?.status} / ${untouched?.closedAt}`,
  );

  const foreign = await createManifest(
    {
      originBranchId: fx.origin.id,
      destinationBranchId: fx.destination.id,
      remarks: `${TAG} scope check`,
    },
    dispatcher,
  );
  check(
    "nor may they raise a manifest out of a branch they do not cover",
    !foreign.ok,
    foreign.ok ? "it was raised" : foreign.error,
  );
}

async function checkVendors(admin: SessionUser, fx: Fixture) {
  section("Vendors — the money side of the running");

  // ── The lane rate: two foreign keys and two branches ─────────────────
  const wrongVendor = await prisma.vendor.create({
    data: {
      orgId: admin.orgId,
      code: `${TAG}W${RUN}`,
      name: "Verification Other Roadlines",
      kind: "TRANSPORTER",
      phone: "9800000906",
    },
    select: { id: true },
  });

  const linesBefore = await prisma.vendorRateLine.count({
    where: { contractId: fx.contract.id },
  });

  const crossed = await saveVendorRateLine(
    {
      contractId: fx.contract.id,
      vendorId: wrongVendor.id,
      originBranchId: fx.origin.id,
      destinationBranchId: fx.destination.id,
      vehicleTypeId: null,
      basis: "PER_TRIP",
      rate: 18_000,
      minimumAmount: null,
    },
    admin,
  );
  check(
    "a lane rate cannot be written onto a contract belonging to another vendor",
    !crossed.ok && /not on this vendor/i.test(crossed.ok ? "" : crossed.error),
    crossed.ok ? "it was written" : crossed.error,
  );

  // A branch-scoped actor. No shipped role is both branch-scoped and
  // holds `vendor.read`, so this is built from the dispatcher's own
  // session with the vendor permission added: the question being asked
  // is whether the branch rule holds, not whether the role exists.
  const dispatcher = await actorFor(BRANCH_DISPATCHER);
  if (dispatcher && dispatcher.branchIds !== null) {
    const scoped: SessionUser = {
      ...dispatcher,
      permissions: new Set([...dispatcher.permissions, "vendor.update"]),
    };

    const outOfScope = await saveVendorRateLine(
      {
        contractId: fx.contract.id,
        vendorId: fx.vendor.id,
        originBranchId: fx.origin.id,
        destinationBranchId: fx.destination.id,
        vehicleTypeId: null,
        basis: "PER_TRIP",
        rate: 18_000,
        minimumAmount: null,
      },
      scoped,
    );
    check(
      "nor may a branch-scoped user set the payable rate on a lane they do not cover",
      !outOfScope.ok && /outside the branches you cover/i.test(outOfScope.ok ? "" : outOfScope.error),
      outOfScope.ok ? "it was written" : outOfScope.error,
    );
  }

  const linesAfter = await prisma.vendorRateLine.count({
    where: { contractId: fx.contract.id },
  });
  check(
    "and nothing was written either side of those refusals",
    linesBefore === 0 && linesAfter === 0,
    `${linesBefore} before, ${linesAfter} after`,
  );

  const allowed = await saveVendorRateLine(
    {
      contractId: fx.contract.id,
      vendorId: fx.vendor.id,
      originBranchId: fx.origin.id,
      destinationBranchId: fx.destination.id,
      vehicleTypeId: null,
      basis: "PER_TRIP",
      rate: 18_000,
      minimumAmount: null,
    },
    admin,
  );
  check(
    "the lane the actor does cover is accepted",
    allowed.ok,
    allowed.ok ? "written" : allowed.error,
  );

  // ── The series the seed never wrote ──────────────────────────────────
  //
  // `VENDOR_BILL` is in the enum and `createVendorBill` has always asked
  // `nextNumber` for it, and nothing seeded a row — so the first bill a
  // transporter sent in could not be raised on a fresh database. The
  // default now lives in `default-series.ts` and the seed writes it; this
  // does the same thing idempotently so the check below can run against a
  // database seeded before that fix.
  const existingSeries = await prisma.numberSeries.findFirst({
    where: { document: "VENDOR_BILL", branchId: null },
    select: { id: true },
  });
  if (!existingSeries) {
    await prisma.numberSeries.create({
      data: {
        orgId: admin.orgId,
        document: VENDOR_BILL_SERIES.document,
        pattern: VENDOR_BILL_SERIES.pattern,
        prefix: VENDOR_BILL_SERIES.prefix,
        padding: VENDOR_BILL_SERIES.padding,
        resetPolicy: VENDOR_BILL_SERIES.resetPolicy,
      },
    });
    console.log("  [note] wrote the missing VENDOR_BILL series, as the seed now does");
  }

  // Blocking, which nothing in the product could do.
  const billable = await createVendorBill(
    {
      vendorId: fx.vendor.id,
      billDate: day(0),
      lines: [{ description: `${TAG} line-haul`, amount: "18000" }],
    },
    admin,
  );
  check(
    "a working vendor can be billed",
    billable.ok,
    billable.ok ? billable.number : billable.error,
  );

  await prisma.vendor.update({ where: { id: fx.vendor.id }, data: { isBlocked: true } });

  const billsBefore = await prisma.vendorBill.count({ where: { vendorId: fx.vendor.id } });
  const blocked = await createVendorBill(
    {
      vendorId: fx.vendor.id,
      billDate: day(0),
      lines: [{ description: `${TAG} second`, amount: "9000" }],
    },
    admin,
  );
  const billsAfter = await prisma.vendorBill.count({ where: { vendorId: fx.vendor.id } });

  check(
    "a blocked vendor cannot be billed",
    !blocked.ok && /blocked/i.test(blocked.ok ? "" : blocked.error),
    blocked.ok ? "it was raised" : blocked.error,
  );
  check(
    "and nothing was written either side of that refusal",
    billsBefore === billsAfter,
    `${billsBefore} before, ${billsAfter} after`,
  );

  // The variance test the tile got backwards. A bill with no contract
  // line to check against carries `null`; a bill checked and matching
  // carries `0.00`. Only the second is "checked".
  const raised = await prisma.vendorBill.findFirst({
    where: { vendorId: fx.vendor.id },
    select: { varianceAmount: true },
  });
  check(
    "a bill with no contract line to check against records no variance, not a zero one",
    raised?.varianceAmount === null,
    String(raised?.varianceAmount),
  );

  const countedByTile = await prisma.vendorBill.count({
    where: {
      vendorId: fx.vendor.id,
      status: { in: ["SUBMITTED", "APPROVED", "PARTIALLY_PAID", "DISPUTED"] },
      varianceAmount: { not: null },
      NOT: { varianceAmount: 0 },
    },
  });
  check(
    "so the variance tile does not count it",
    countedByTile === 0,
    `${countedByTile} counted`,
  );

  await prisma.vendor.update({ where: { id: fx.vendor.id }, data: { isBlocked: false } });
}

function checkDates() {
  section("Dates, on the calendar the columns store");

  const inTheGap = new Date("2026-09-02T00:30:00Z");
  check(
    "a pre-filled date at 06:00 IST is today, not yesterday",
    isoDate(inTheGap) === "2026-09-02",
    `${isoDate(inTheGap)} for ${inTheGap.toISOString()}`,
  );

  const beforeIstMidnight = new Date("2026-09-01T18:00:00Z");
  check(
    "and 23:30 IST is still the same day",
    isoDate(beforeIstMidnight) === "2026-09-01",
    `${isoDate(beforeIstMidnight)} for ${beforeIstMidnight.toISOString()}`,
  );

  const afterIstMidnight = new Date("2026-09-01T18:31:00Z");
  check(
    "and half an hour later it is the next one",
    isoDate(afterIstMidnight) === "2026-09-02",
    `${isoDate(afterIstMidnight)} for ${afterIstMidnight.toISOString()}`,
  );
}

// ────────────────────────────────────────────────────────────
// The screens
// ────────────────────────────────────────────────────────────

async function checkScreens(fx: Fixture) {
  section("The screens, as a signed-in person");

  const jar = await signIn(ADMIN_MOBILE, "/dispatch/trips");

  const pages: Array<[string, string]> = [
    ["/dispatch/manifests", "Manifests"],
    ["/dispatch/trips", "Trips"],
    ["/fleet/vehicles", "Vehicles"],
    ["/fleet/vehicle-types", "Vehicle types"],
    ["/fleet/drivers", "Drivers"],
    ["/fleet/expiries", "Document expiries"],
    ["/fleet/field-staff", "Field staff"],
    ["/vendors", "Vendors"],
  ];

  const bodies = new Map<string, string>();
  for (const [path, marker] of pages) {
    const response = await page(path, jar);
    bodies.set(path, response.body);
    check(
      `${path} renders`,
      response.status === 200 &&
        !response.finalPath.includes("/login") &&
        response.body.includes(marker),
      `HTTP ${response.status} at ${response.finalPath}`,
    );
  }

  check(
    "the overspeed threshold has a field to set it — the detector had none",
    bodies.get("/fleet/vehicle-types")?.includes("Overspeed above") ?? false,
  );

  const expiries = bodies.get("/fleet/expiries") ?? "";
  check(
    "the expiry desk surfaces the lapsed insurance",
    expiries.includes(`${TAG}INS-LAP-${RUN}`) && expiries.includes("Blocks assignment now"),
    "the vehicle and its consequence are both on the page",
  );
  check(
    "and the one that is still in date is not called out as blocking",
    !expiries.includes(`${TAG}INS-OK-${RUN}`),
    "a document 120 days out is beyond the 60-day horizon",
  );

  const vendorPage = await page(`/vendors/${fx.vendor.id}`, jar);
  check(
    "a vendor opens",
    vendorPage.status === 200 && vendorPage.body.includes(fx.vendor.name),
    `HTTP ${vendorPage.status}`,
  );
  check(
    "and offers a way to stand them down — the badge was a branch nothing could reach",
    vendorPage.body.includes("Stand ") || vendorPage.body.includes("stand down"),
  );
  check(
    "and a way to remove them",
    vendorPage.body.includes("Remove"),
  );

  // Blocked, over HTTP, is the state the "New bill" button has to read.
  await runWithTenant(await tenantOrThrow(), async () => {
    await prisma.vendor.update({ where: { id: fx.vendor.id }, data: { isBlocked: true } });
  });

  const blockedPage = await page(`/vendors/${fx.vendor.id}`, jar);
  check(
    "a blocked vendor says so",
    blockedPage.body.includes("cannot be billed"),
  );
  check(
    "and the New bill button is disabled rather than failing after the form is filled",
    blockedPage.body.includes("Lift the block before raising a bill"),
    "the refusal is previewed on the trigger",
  );

  await runWithTenant(await tenantOrThrow(), async () => {
    await prisma.vendor.update({ where: { id: fx.vendor.id }, data: { isBlocked: false } });
  });

  // A branch dispatcher must not be able to read a vendor at all: no
  // shipped branch-scoped role holds `vendor.read`. Asserted rather than
  // assumed, because the scoping fix on the lane-rate form is only
  // defence-in-depth if this stays true.
  const dispatcherJar = await signIn(BRANCH_DISPATCHER, "/dispatch/trips");
  const scopedVendor = await page(`/vendors/${fx.vendor.id}`, dispatcherJar);
  check(
    "a branch dispatcher cannot read a vendor",
    !scopedVendor.body.includes(fx.vendor.name),
    `HTTP ${scopedVendor.status} at ${scopedVendor.finalPath}`,
  );

  const dispatcherTrips = await page("/dispatch/trips", dispatcherJar);
  check(
    "but does reach the trips board",
    dispatcherTrips.status === 200 && !dispatcherTrips.finalPath.includes("/login"),
    `HTTP ${dispatcherTrips.status} at ${dispatcherTrips.finalPath}`,
  );

  // Our own draft, not whatever happens to be first on the list — a
  // dispatched manifest is not editable and would not show the control
  // whether it existed or not.
  const draft = await runWithTenant(await tenantOrThrow(), async () =>
    prisma.manifest.findFirst({
      where: { remarks: { startsWith: TAG }, status: "DRAFT" },
      select: { id: true, number: true },
    }),
  );

  if (draft) {
    const detail = await page(`/dispatch/manifests/${draft.id}`, jar);
    check(
      "a draft manifest opens",
      detail.status === 200 && detail.body.includes(draft.number),
      `${draft.number} — HTTP ${detail.status}`,
    );
    check(
      "and offers a vehicle — the action existed and no control reached it",
      detail.body.includes("Assign a vehicle") || detail.body.includes("Change vehicle"),
      "the assign control is on the page",
    );
  } else {
    console.log("  [SKIP] no draft manifest of ours survived the run");
  }

  // The loading console, which is the screen the gate refuses against.
  // Planned here rather than reused: every trip the rules section made has
  // been gated out and closed by now, which is the point of those checks.
  const loadable = await runWithTenant(await tenantOrThrow(), async () => {
    const admin = await actorFor(ADMIN_MOBILE);
    if (!admin) return null;

    const lorry = await prisma.vehicle.create({
      data: {
        orgId: admin.orgId,
        registrationNumber: `${TAG}LOD${RUN}`,
        vehicleTypeId: fx.smallType.id,
        branchId: fx.origin.id,
        ownership: "OWN",
        status: "AVAILABLE",
        isActive: true,
      },
      select: { id: true },
    });

    const trip = await createTrip(
      {
        vehicleId: lorry.id,
        originBranchId: fx.origin.id,
        destinationBranchId: fx.destination.id,
      },
      admin,
    );
    if (!trip.ok) return null;
    return { id: trip.tripId, number: trip.number };
  });
  if (loadable) {
    const console_ = await page(`/dispatch/trips/${loadable.id}/loading`, jar);
    check(
      "the loading console opens for a trip that has not left",
      console_.status === 200 && console_.body.includes("Loading sheet"),
      `${loadable.number} — HTTP ${console_.status}`,
    );
  } else {
    console.log("  [SKIP] no pre-departure trip of ours survived the run");
  }

  const trips = await page("/dispatch/trips", jar);
  const firstTrip = /\/dispatch\/trips\/([a-z0-9]+)/.exec(trips.body);
  if (firstTrip) {
    const detail = await page(`/dispatch/trips/${firstTrip[1]}`, jar);
    check(
      "a trip opens",
      detail.status === 200,
      `HTTP ${detail.status}`,
    );
  }
}

let cachedTenant: TenantContext | null = null;
async function tenantOrThrow(): Promise<TenantContext> {
  if (cachedTenant) return cachedTenant;
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${SUBDOMAIN}" is closed.`);
  cachedTenant = tenant;
  return tenant;
}

async function main() {
  const tenant = await tenantOrThrow();
  console.log(`\nDispatch — ${tenant.slug}, as ${ADMIN_MOBILE}`);

  const fixture = await runWithTenant(tenant, async () => {
    await cleanup();
    const admin = await actorFor(ADMIN_MOBILE);
    if (!admin) throw new Error(`No user on ${ADMIN_MOBILE}`);
    return { admin, fx: await seed(admin) };
  });

  try {
    await runWithTenant(tenant, async () => {
      const tripId = await checkTripPlanning(fixture.admin, fixture.fx);
      await checkFullTruck(fixture.admin, fixture.fx);
      await checkCapacity(fixture.admin, fixture.fx, tripId);
      await checkGate(fixture.admin, fixture.fx, tripId);
      await checkScope(fixture.fx);
      await checkVendors(fixture.admin, fixture.fx);
    });

    checkDates();
    await checkScreens(fixture.fx);
  } finally {
    await runWithTenant(tenant, async () => {
      await cleanup();
    });
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nThe dispatch check could not run:\n", error);
  process.exit(1);
});
