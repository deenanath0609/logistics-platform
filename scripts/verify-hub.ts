/**
 * The hub module, proved end to end and then driven as a signed-in person.
 *
 *   npx tsx scripts/verify-hub.ts [--base http://localhost:3010]
 *
 * The branch floor is where freight stops being paperwork. A vehicle
 * arrives, somebody opens the manifest as a checklist, scans what comes
 * off it, and closes the receipt — and that close is the most
 * consequential button in the product, because it is what turns a line
 * nobody scanned into a shortage owned by the branch that dispatched it.
 *
 * So this walks the whole thing with real people at real branches:
 * Gurugram books, sorts, manifests and gates a vehicle out; Delhi
 * receives it, scans three of five boxes plus two that were never on the
 * paperwork, and closes. Then it asserts what that close produced — the
 * discrepancy rows, the attribution, the timeline events, and the
 * exceptions in the control tower — and finally opens the screens over
 * HTTP as the people who have to look at them.
 *
 * Refusals are checked as carefully as successes, and where a refusal
 * matters the check also proves nothing was written on either side of it.
 * A guard that returns an error message after writing the row is not a
 * guard.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { basePrisma, prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor } from "../src/lib/tenant";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";
import { createBooking } from "../src/lib/shipment/booking";
import { appendShipmentEvent } from "../src/lib/shipment/events";
import {
  createManifest,
  addShipmentsToManifest,
  closeManifest,
  setManifestTrip,
} from "../src/lib/transport/manifest";
import { createTrip, gateOut, gateIn, closeTrip } from "../src/lib/transport/trip";
import { canAssignVehicle } from "../src/lib/fleet/availability";
import {
  openReceipt,
  scanIntoReceipt,
  closeReceipt,
  resolveDiscrepancy,
} from "../src/lib/hub/receipt";
import { recordScan } from "../src/lib/hub/scan";
import { captureRevisedWeight, previewRevisedWeight } from "../src/lib/hub/weight";
import { transitionException, addExceptionNote } from "../src/lib/exceptions/service";
import type { SessionUser } from "../src/lib/auth/session";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};

const BASE = arg("base", "http://localhost:3010");
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
const SUBDOMAIN = arg("tenant", "city-logistics");
const HOST = `${SUBDOMAIN}.${ROOT}`;
const PASSWORD = arg("password", "Admin@123");

/** The lane. Gurugram dispatches, Delhi receives, Mumbai is the outsider. */
const ORIGIN = "BR-GGN";
const HUB = "HUB-DEL";
const OUTSIDER = "BR-BOM";

/** Branch crews: 9 + branch digit ×3 + 00000 + post digit. */
const GGN_MANAGER = "9333000001";
const DEL_MANAGER = "9222000001";
const DEL_BOOKING = "9222000002";
const DEL_DISPATCH = "9222000004";
const DEL_OPERATOR = "9222000003";
const BOM_MANAGER = "9555000001";
const NETWORK_ADMIN = "9999999999";

let passes = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(title: string) {
  console.log(`\n${title}\n`);
}

// ────────────────────────────────────────────────────────────
// Sessions
// ────────────────────────────────────────────────────────────

/**
 * A session exactly as sign-in would build one.
 *
 * Widest scope wins across roles, and `branchIds` is null only for
 * NETWORK — which is what makes every `coversBranch` assertion below mean
 * something.
 */
async function sessionFor(mobile: string): Promise<SessionUser | null> {
  const user = await prisma.user.findFirst({
    where: { mobile, status: "ACTIVE" },
    include: {
      primaryBranch: { select: { id: true, code: true, name: true } },
      roles: {
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      },
    },
  });
  if (!user) return null;

  const permissions = new Set<string>();
  const rank: Record<string, number> = { OWN: 0, BRANCH: 1, BRANCH_SET: 2, NETWORK: 3 };
  let widest: SessionUser["scope"] = "OWN";

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
    roles: user.roles.map((r) => ({ code: r.role.code, name: r.role.name, scope: r.role.scope })),
    permissions,
    scope: widest,
    branchIds:
      widest === "NETWORK" ? null : user.primaryBranch ? [user.primaryBranch.id] : [],
  };
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
 * A page fetched once it has actually rendered.
 *
 * The dev server compiles a route on its first request, and while another
 * change is being watched in it does that again. A page asked for in that
 * window comes back 200 with the shell and not yet the table, and a check
 * reading it sees a board with no rows on it — which looks exactly like
 * the product hiding a manifest and is nothing of the sort. `ready` says
 * what "rendered" means for the page in question; the last response is
 * returned either way, so a genuine absence still fails the check.
 */
async function rendered<T extends { body: string }>(
  fetchPage: () => Promise<T>,
  ready: (page: T) => boolean,
  attempts = 4,
): Promise<T> {
  let page = await fetchPage();

  for (let i = 1; i < attempts && !ready(page); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000 * i));
    page = await fetchPage();
  }

  return page;
}

// ────────────────────────────────────────────────────────────

const stamp = Date.now().toString().slice(-6);

async function main() {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${SUBDOMAIN}" is closed.`);

  console.log(`\nHub operations — ${org.slug}\n`);

  // Signed in before the work starts: one of the checks below has to look
  // at the inbound board at a particular moment — while the vehicle is
  // loaded but not yet gated out — which is gone by the time the screens
  // are driven at the end.
  const operatorJar = await signIn(DEL_OPERATOR, "/hub");

  // Everything the screens will later be asked to render is produced here
  // by the people whose job it is, never by an administrator.
  const built = await runWithTenant(
    tenant,
    async () => await buildAndProve(operatorJar),
  );

  await screens(built);

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

type Built = {
  receiptId: string | null;
  manifestNumber: string | null;
  shortLr: string | null;
  excessLr: string | null;
  shortExceptionNumber: string | null;
  weighableLr: string | null;
};

async function buildAndProve(operatorJar: CookieJar): Promise<Built> {
  const result: Built = {
    receiptId: null,
    manifestNumber: null,
    shortLr: null,
    excessLr: null,
    shortExceptionNumber: null,
    weighableLr: null,
  };

  const branches = await prisma.branch.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true },
  });
  const byCode = new Map(branches.map((b) => [b.code, b]));

  const origin = byCode.get(ORIGIN);
  const hub = byCode.get(HUB);
  const outsider = byCode.get(OUTSIDER);
  if (!origin || !hub || !outsider) {
    throw new Error(`The hub check needs ${ORIGIN}, ${HUB} and ${OUTSIDER}.`);
  }

  const [ggnManager, delManager, delOperator, bomManager, delDispatch, admin] =
    await Promise.all([
      sessionFor(GGN_MANAGER),
      sessionFor(DEL_MANAGER),
      sessionFor(DEL_OPERATOR),
      sessionFor(BOM_MANAGER),
      sessionFor(DEL_DISPATCH),
      sessionFor(NETWORK_ADMIN),
    ]);

  section("The people the floor needs");
  check(`${ORIGIN} has a manager who can dispatch`, Boolean(ggnManager), ggnManager?.name ?? "nobody");
  check(`${HUB} has a hub operator`, Boolean(delOperator), delOperator?.name ?? "nobody");
  check(`${HUB} has a manager who can close a receipt`, Boolean(delManager), delManager?.name ?? "nobody");
  check(`${OUTSIDER} has a manager, to prove scope with`, Boolean(bomManager), bomManager?.name ?? "nobody");

  if (!ggnManager || !delManager || !delOperator || !bomManager) return result;
  if (!delDispatch || !admin) {
    check("the dispatch desk and the network administrator can be signed in", false);
    return result;
  }

  // The division of labour the module is built around: the operator with
  // the gun receives, and closing — which raises a claim against another
  // branch — belongs to somebody senior enough to answer for it.
  check(
    "the operator may scan inbound but not close a receipt",
    delOperator.permissions.has("scan.inbound") && !delOperator.permissions.has("receipt.close"),
    "scan.inbound without receipt.close",
  );
  check(
    "the branch manager may close one",
    delManager.permissions.has("receipt.close") && delManager.permissions.has("discrepancy.resolve"),
  );

  // ── Put freight on a vehicle at Gurugram ──────────────────
  section("Gurugram loads a vehicle for Delhi");

  const [service, packageType, ggnCity, delCity] = await Promise.all([
    prisma.serviceType.findFirstOrThrow({ where: { isActive: true, mode: "PTL" } }),
    prisma.packageType.findFirstOrThrow({ where: { isActive: true } }),
    prisma.city.findFirstOrThrow({ where: { code: "GGN" } }),
    prisma.city.findFirstOrThrow({ where: { code: "DEL" } }),
  ]);

  // Asked through `canAssignVehicle` rather than filtered by status alone:
  // a truck with lapsed fitness is refused at the trip, and picking one
  // here would fail this check for a reason that has nothing to do with
  // the hub.
  const candidates = await prisma.vehicle.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      // Not already out on the road: the trip planner refuses a truck with
      // a live trip against it, and so it should.
      trips: {
        none: {
          status: { in: ["LOADING", "DISPATCHED", "IN_TRANSIT", "ARRIVED", "UNLOADING"] },
        },
      },
    },
    select: {
      id: true,
      registrationNumber: true,
      status: true,
      isActive: true,
      deletedAt: true,
      documents: { select: { kind: true, expiresOn: true, isMandatory: true } },
    },
  });

  const now = new Date();
  let vehicle = candidates.find((v) => canAssignVehicle(v, v.documents, now).ok) ?? null;

  // The seed fleet is small and its trucks are usually mid-trip, and this
  // check is about the dock rather than the yard. Rather than close
  // somebody else's live trip to free one up, it keeps a truck of its own.
  if (!vehicle) {
    const vehicleType = await prisma.vehicleType.findFirstOrThrow({
      where: { isActive: true },
      select: { id: true },
    });
    const created = await prisma.vehicle.upsert({
      where: {
        orgId_registrationNumber: {
          orgId: ggnManager!.orgId,
          registrationNumber: "HRVERIFY01",
        },
      },
      create: {
        orgId: ggnManager!.orgId,
        registrationNumber: "HRVERIFY01",
        vehicleTypeId: vehicleType.id,
        branchId: origin!.id,
        status: "AVAILABLE",
        notes: "Reserved for scripts/verify-hub.ts.",
      },
      update: { status: "AVAILABLE", isActive: true, deletedAt: null },
      select: { id: true, registrationNumber: true },
    });

    // Its own leftovers, retired. The lane this check drives ends with the
    // vehicle gated out and still on the road, so the run after it would
    // be refused the truck it reserved — "close that trip before sending
    // it out again", which is the trip planner being right about a trip
    // this script abandoned. Retiring only this reserved vehicle's trips
    // touches nothing anybody else is using, and keeps the check's result
    // independent of how many times it has been run before.
    await prisma.trip.updateMany({
      where: {
        vehicleId: created.id,
        status: { in: ["PLANNED", "VEHICLE_REPORTED", "LOADING", "DISPATCHED", "IN_TRANSIT", "ARRIVED", "UNLOADING"] },
      },
      data: { status: "COMPLETED", closedAt: new Date() },
    });

    vehicle = { ...created, status: "AVAILABLE", isActive: true, deletedAt: null, documents: [] };
  }

  check(
    "the fleet has a roadworthy vehicle to send",
    Boolean(vehicle),
    vehicle?.registrationNumber ?? "every vehicle is blocked or has a lapsed document",
  );
  if (!vehicle) return result;

  // A previous run that failed partway leaves its truck standing on the
  // road. Settle anything still open on it rather than picking a different
  // vehicle every run and quietly growing the fleet.
  const stranded = await prisma.trip.findMany({
    where: {
      vehicleId: vehicle.id,
      status: { in: ["LOADING", "DISPATCHED", "IN_TRANSIT", "ARRIVED", "UNLOADING"] },
    },
    select: { id: true, status: true, destinationBranchId: true },
  });

  for (const old of stranded) {
    if (old.status === "DISPATCHED" || old.status === "IN_TRANSIT") {
      await gateIn({ tripId: old.id, branchId: old.destinationBranchId }, admin);
    }
    await closeTrip({ tripId: old.id }, admin);
  }

  async function book(label: string, packageCount: number) {
    return createBooking(
      {
        mode: "PTL",
        serviceTypeId: service.id,
        bookingBranchId: origin!.id,
        originBranchId: origin!.id,
        destinationBranchId: hub!.id,
        consignorName: `Hub check ${stamp} — ${label}`,
        consignorPhone: "9811100021",
        consignorAddress: "Plot 9, Udyog Vihar Phase III",
        consignorCityId: ggnCity.id,
        consignorPincode: "122015",
        consigneeName: `Hub check ${stamp} — ${label}`,
        consigneePhone: "9811100022",
        consigneeAddress: "14 Okhla Industrial Estate",
        consigneeCityId: delCity.id,
        consigneePincode: "110020",
        packageCount,
        packageTypeId: packageType.id,
        actualWeight: 10,
        goodsDescription: "Hub verification — auto-generated",
        declaredValue: 9000,
        paymentType: "PAID",
        pickupRequired: false,
      },
      ggnManager!,
    );
  }

  // Three on the manifest — one arrives whole, one arrives a box short,
  // one never turns up at all — and a fourth that is never manifested and
  // turns up anyway, which is what an excess actually looks like.
  const whole = await book("arrives whole", 2);
  const partial = await book("arrives short", 2);
  const missing = await book("never arrives", 1);
  const stray = await book("stray box", 1);

  const booked = [whole, partial, missing, stray];
  check(
    "four consignments are booked at Gurugram",
    booked.every((b) => b.ok),
    booked.map((b) => (b.ok ? b.lrNumber : b.error)).join(", "),
  );
  if (!whole.ok || !partial.ok || !missing.ok || !stray.ok) return result;

  // Received and sorted at the origin: a manifest takes PROCESSED
  // consignments only, because a box nobody sorted has no confirmed lane.
  for (const b of [whole, partial, missing]) {
    await appendShipmentEvent(
      { shipmentId: b.shipmentId, eventType: "INBOUND_SCAN", branchId: origin.id },
      ggnManager,
    );
    await appendShipmentEvent(
      { shipmentId: b.shipmentId, eventType: "SORTED", branchId: origin.id },
      ggnManager,
    );
  }

  const manifest = await createManifest(
    { originBranchId: origin.id, destinationBranchId: hub.id },
    ggnManager,
  );
  check("a manifest is raised for the lane", manifest.ok, manifest.ok ? manifest.number : manifest.error);
  if (!manifest.ok) return result;
  result.manifestNumber = manifest.number;

  const added = await addShipmentsToManifest(
    {
      manifestId: manifest.manifestId,
      shipmentIds: [whole.shipmentId, partial.shipmentId, missing.shipmentId],
    },
    ggnManager,
  );
  check(
    "three consignments go on it — five packages declared",
    added.ok && added.added.length === 3,
    added.ok ? `${added.added.length} added` : added.error,
  );

  const closedManifest = await closeManifest({ manifestId: manifest.manifestId }, ggnManager);
  check("it is closed for dispatch", closedManifest.ok, closedManifest.ok ? closedManifest.number : closedManifest.error);

  // ── The trap that used to be silent ───────────────────────
  //
  // A manifest closed for dispatch has not left: every consignment on it
  // is still MANIFESTED, and the spine takes an inbound scan from
  // DISPATCHED. Opening a receipt here once "worked" — the lines ticked
  // green, the reconciliation came out clean, and not one consignment
  // moved. Delhi would have signed for freight the network still believed
  // was standing in Gurugram.
  section("A vehicle that has not been gated out cannot be received");

  const receiptsBefore = await prisma.inboundReceipt.count({
    where: { manifestId: manifest.manifestId },
  });

  const premature = await openReceipt(
    { manifestId: manifest.manifestId, branchId: hub.id },
    delOperator,
  );
  check(
    "receiving a manifest that never left is refused",
    !premature.ok,
    premature.ok ? "it was allowed" : premature.error,
  );
  check(
    "and it says why, naming the gate-out",
    !premature.ok && premature.error.includes("gated out"),
    premature.ok ? "" : premature.error,
  );
  check(
    "and no receipt was written on the way to the refusal",
    (await prisma.inboundReceipt.count({ where: { manifestId: manifest.manifestId } })) ===
      receiptsBefore,
  );

  // The other half of the same fix. The board used to put a Receive button
  // on this row, so the refusal above would only ever have been read by
  // somebody who had already pressed it.
  const board = await rendered(
    () => hostFollow(HOST, PORT, "/hub/inbound", operatorJar),
    // The board has rendered its table, not just the shell around it.
    (page) => page.body.includes("Expected here"),
  );

  // The row is bounded by where the *next* row starts, not by a fixed
  // number of characters. Every row opens with a link to its manifest, so
  // the following `/dispatch/manifests/` is the end of this one. A fixed
  // window is a check whose result depends on how long a driver's name
  // happens to be — it passed for three runs and then did not.
  const at = board.body.indexOf(manifest.number);
  const nextRow = board.body.indexOf("/dispatch/manifests/", at + 1);
  const row =
    at === -1
      ? ""
      : board.body.slice(at, nextRow === -1 ? board.body.length : nextRow);

  check(
    "and the board says so on the row rather than offering to receive it",
    at !== -1 && row.includes("Not gated out yet"),
    at === -1
      ? `${manifest.number} is not on the board at all`
      : `${manifest.number}, row of ${row.length} characters`,
  );

  // ── Out of the gate ───────────────────────────────────────
  const trip = await createTrip(
    {
      vehicleId: vehicle.id,
      originBranchId: origin.id,
      destinationBranchId: hub.id,
      sealNumber: `SEAL-${stamp}`,
    },
    ggnManager,
  );
  check("a trip is planned", trip.ok, trip.ok ? trip.number : trip.error);
  if (!trip.ok) return result;

  const attached = await setManifestTrip(
    { manifestId: manifest.manifestId, tripId: trip.tripId },
    ggnManager,
  );
  check("the manifest is put on the vehicle", attached.ok, attached.ok ? "" : attached.error);

  const gated = await gateOut({ tripId: trip.tripId, sealNumber: `SEAL-${stamp}` }, ggnManager);
  check("the vehicle is gated out", gated.ok, gated.ok ? "" : gated.error);

  const dispatched = await prisma.manifest.findUniqueOrThrow({
    where: { id: manifest.manifestId },
    select: { status: true },
  });
  check("the manifest now reads dispatched", dispatched.status === "DISPATCHED", dispatched.status);

  // The truck presents at Delhi. Gate-in is the dispatch desk's event, not
  // the dock's — the dock's work starts with the doors coming open.
  const arrived = await gateIn({ tripId: trip.tripId, branchId: hub.id }, delDispatch);
  check("the vehicle reports at Delhi", arrived.ok, arrived.ok ? "" : arrived.error);

  // ── Delhi receives ────────────────────────────────────────
  section("Delhi opens the manifest as a checklist");

  // Opened without an answer about the seal — the driver was still
  // unhitching and nobody had looked yet.
  const opened = await openReceipt(
    { manifestId: manifest.manifestId, branchId: hub.id },
    delOperator,
  );
  check("the operator opens a receipt against it", opened.ok, opened.ok ? opened.receiptId : opened.error);
  if (!opened.ok) return result;
  result.receiptId = opened.receiptId;

  const openedReceipt = await prisma.inboundReceipt.findUniqueOrThrow({
    where: { id: opened.receiptId },
    select: {
      expectedShipments: true,
      expectedPackages: true,
      sealIntact: true,
      lines: { select: { id: true } },
    },
  });
  check(
    "it is pre-loaded with what the manifest declared",
    openedReceipt.expectedShipments === 3 && openedReceipt.expectedPackages === 5,
    `${openedReceipt.expectedShipments} consignments, ${openedReceipt.expectedPackages} packages`,
  );

  check(
    "with nothing yet said about the seal",
    openedReceipt.sealIntact === null,
    String(openedReceipt.sealIntact),
  );

  // Back to the same truck, this time having looked at the seal. The
  // dialog asks the question on every open and the resume path used to
  // drop the answer on the floor: the receipt went on reading "not
  // checked" behind a clerk who had just said otherwise.
  const resumed = await openReceipt(
    { manifestId: manifest.manifestId, branchId: hub.id, sealIntact: true },
    delOperator,
  );
  check(
    "opening it again resumes the same receipt rather than splitting the scans",
    resumed.ok && resumed.receiptId === opened.receiptId && resumed.reopened,
    resumed.ok ? `${resumed.receiptId} (reopened: ${resumed.reopened})` : resumed.error,
  );
  check(
    "and the seal answer given on the way back in is kept",
    (
      await prisma.inboundReceipt.findUniqueOrThrow({
        where: { id: opened.receiptId },
        select: { sealIntact: true },
      })
    ).sealIntact === true,
  );

  // ── Somebody else's dock ──────────────────────────────────
  const scansBefore = await prisma.scanRecord.count({ where: { receiptId: opened.receiptId } });

  const wholePackages = await prisma.shipmentPackage.findMany({
    where: { shipmentId: whole.shipmentId },
    orderBy: { sequence: "asc" },
    select: { barcode: true },
  });
  const partialPackages = await prisma.shipmentPackage.findMany({
    where: { shipmentId: partial.shipmentId },
    orderBy: { sequence: "asc" },
    select: { barcode: true },
  });
  const strayPackages = await prisma.shipmentPackage.findMany({
    where: { shipmentId: stray.shipmentId },
    select: { barcode: true },
  });

  const trespass = await scanIntoReceipt(
    {
      receiptId: opened.receiptId,
      barcode: wholePackages[0].barcode,
      idempotencyKey: crypto.randomUUID(),
    },
    bomManager,
  );
  check(
    "a Mumbai manager cannot scan into Delhi's receipt",
    !trespass.ok,
    trespass.ok ? "it was allowed" : trespass.error,
  );
  check(
    "and the refusal wrote no scan",
    (await prisma.scanRecord.count({ where: { receiptId: opened.receiptId } })) === scansBefore,
  );

  // ── The dock does its work ────────────────────────────────
  section("The dock scans what actually came off the vehicle");

  const receiptId = opened.receiptId;

  async function scan(barcode: string) {
    return scanIntoReceipt(
      { receiptId, barcode, idempotencyKey: crypto.randomUUID() },
      delOperator!,
    );
  }

  const firstBox = await scan(wholePackages[0].barcode);
  check(
    "the first box off the truck is on the paperwork",
    firstBox.ok && firstBox.result.outcome.isExpected && firstBox.result.outcome.tone === "ok",
    firstBox.ok ? firstBox.result.outcome.message : firstBox.error,
  );
  check(
    "and the consignment is now received at the hub",
    (
      await prisma.shipment.findUniqueOrThrow({
        where: { id: whole.shipmentId },
        select: { currentStatus: true },
      })
    ).currentStatus === "RECEIVED_AT_HUB",
  );

  await scan(wholePackages[1].barcode);

  // The same trigger pull twice. A duplicate is noise, not a second box:
  // counted once, it would otherwise invent an excess against Gurugram.
  const repeat = await scan(wholePackages[1].barcode);
  check(
    "reading the same box twice does not tick the line twice",
    repeat.ok && repeat.result.line?.scannedPackages === 2,
    repeat.ok ? `line at ${repeat.result.line?.scannedPackages}/2` : repeat.error,
  );

  // One of two. The other becomes the shortage.
  await scan(partialPackages[0].barcode);

  const strayScan = await scan(strayPackages[0].barcode);
  check(
    "a real box that is not on this manifest goes red",
    strayScan.ok && !strayScan.result.outcome.isExpected && strayScan.result.outcome.tone === "bad",
    strayScan.ok ? strayScan.result.outcome.message : strayScan.error,
  );

  const nonsense = await scan(`FOREIGN-LABEL-${stamp}`);
  check(
    "a barcode nothing in the system recognises is still recorded",
    nonsense.ok && Boolean(nonsense.result.outcome.scanRecordId) && !nonsense.result.outcome.recognised,
    nonsense.ok ? nonsense.result.outcome.message : nonsense.error,
  );

  // ── What the next person to open the console is told ──────
  //
  // The unexpected tally was built only from what this browser had
  // scanned. A colleague on the second gun, or the same clerk after a
  // reload, saw "0 unexpected" over a receipt that already carried two
  // stray boxes — and that tally is what the close dialog quotes as the
  // claim about to be raised against the dispatching branch.
  section("A fresh console knows what the last one found");

  const reloaded = await hostFollow(
    HOST,
    PORT,
    `/hub/inbound/${receiptId}`,
    await signIn(DEL_OPERATOR, `/hub/inbound/${receiptId}`),
  );
  check(
    "the open receipt renders for the operator",
    reloaded.status === 200 && !reloaded.finalPath.includes("/forbidden"),
    `HTTP ${reloaded.status} at ${reloaded.finalPath}`,
  );
  check(
    "and carries the excess already recorded on it, not an empty tally",
    reloaded.body.includes(strayPackages[0].barcode) &&
      reloaded.body.includes(`FOREIGN-LABEL-${stamp}`),
    `${strayPackages[0].barcode} and FOREIGN-LABEL-${stamp}`,
  );

  // ── The operator may not close ────────────────────────────
  section("Closing is a permission, not a step");

  const discrepanciesBefore = await prisma.receiptDiscrepancy.count({
    where: { receiptId: opened.receiptId },
  });

  const refusedClose = await closeReceipt({ receiptId: opened.receiptId }, delOperator);
  check(
    "the hub operator cannot close the receipt",
    !refusedClose.ok,
    refusedClose.ok ? "it was allowed" : refusedClose.error,
  );
  check(
    "the receipt is untouched by the refusal",
    (
      await prisma.inboundReceipt.findUniqueOrThrow({
        where: { id: opened.receiptId },
        select: { status: true },
      })
    ).status === "OPEN" &&
      (await prisma.receiptDiscrepancy.count({ where: { receiptId: opened.receiptId } })) ===
        discrepanciesBefore,
  );

  const outsiderClose = await closeReceipt({ receiptId: opened.receiptId }, bomManager);
  check(
    "nor can a manager from another branch",
    !outsiderClose.ok,
    outsiderClose.ok ? "it was allowed" : outsiderClose.error,
  );

  // ── The close ─────────────────────────────────────────────
  section("Closing turns what is missing into somebody's problem");

  const closed = await closeReceipt(
    { receiptId: opened.receiptId, sealIntact: true, remarks: "Verification close." },
    delManager,
  );
  check("the branch manager closes and reconciles", closed.ok, closed.ok ? "" : closed.error);
  if (!closed.ok) return result;

  const totals = closed.reconciliation.totals;
  check(
    "two packages are short — the half-arrived consignment and the one that never came",
    totals.shortPackages === 2,
    `${totals.shortPackages} short of ${totals.expectedPackages} expected`,
  );
  check(
    "two are excess — the stray box and the unreadable label",
    totals.excessPackages === 2,
    `${totals.excessPackages} excess`,
  );
  check("three are matched", totals.matchedPackages === 3, `${totals.matchedPackages} matched`);
  check("the receipt is not clean", !closed.reconciliation.isClean);

  const settled = await prisma.inboundReceipt.findUniqueOrThrow({
    where: { id: opened.receiptId },
    select: { status: true, shortPackages: true, excessPackages: true, scannedPackages: true, closedById: true },
  });
  check(
    "and the row says so — closed, 2 short, 2 excess",
    settled.status === "CLOSED" && settled.shortPackages === 2 && settled.excessPackages === 2,
    `${settled.status}, ${settled.shortPackages} short, ${settled.excessPackages} excess`,
  );
  check("closed by the manager who pressed it", settled.closedById === delManager.id);

  const manifestAfter = await prisma.manifest.findUniqueOrThrow({
    where: { id: manifest.manifestId },
    select: { status: true, receivedById: true },
  });
  check("the manifest is marked received", manifestAfter.status === "RECEIVED", manifestAfter.status);

  // The trip settles only once the receipt against it is closed — the
  // shortages have to be raised before the leg is signed off. Doing it
  // here also hands the truck back for the next run of this check.
  const tripClosed = await closeTrip({ tripId: trip.tripId }, delDispatch);
  check(
    "and the trip can now be settled, with its shortages already raised",
    tripClosed.ok,
    tripClosed.ok ? tripClosed.number : tripClosed.error,
  );

  // ── Attribution: the whole point ──────────────────────────
  section("The shortage is owned by the branch that dispatched it");

  const discrepancies = await prisma.receiptDiscrepancy.findMany({
    where: { receiptId: opened.receiptId },
    select: {
      kind: true,
      barcode: true,
      ownerBranchId: true,
      shipmentId: true,
      reasonCodeId: true,
      remarks: true,
      shipment: { select: { lrNumber: true } },
    },
  });

  check(
    "four discrepancy rows were written",
    discrepancies.length === 4,
    discrepancies.map((d) => `${d.kind}:${d.barcode ?? "—"}`).join(", "),
  );
  check(
    "every one of them is owned by Gurugram, not by Delhi who found it",
    discrepancies.length > 0 && discrepancies.every((d) => d.ownerBranchId === origin.id),
    `owner ${ORIGIN}`,
  );
  check(
    "every one carries a reason code, so the register can be grouped",
    discrepancies.length > 0 && discrepancies.every((d) => Boolean(d.reasonCodeId)),
  );

  const shortRows = discrepancies.filter((d) => d.kind === "SHORT");
  check(
    "the unscanned box of the part-received consignment is short",
    shortRows.some(
      (d) => d.shipmentId === partial.shipmentId && d.barcode === partialPackages[1].barcode,
    ),
    partialPackages[1].barcode,
  );
  check(
    "so is the consignment that never turned up",
    shortRows.some((d) => d.shipmentId === missing.shipmentId),
    missing.lrNumber,
  );
  check(
    "the fully received consignment is short of nothing",
    !shortRows.some((d) => d.shipmentId === whole.shipmentId),
    whole.lrNumber,
  );

  const excessRows = discrepancies.filter((d) => d.kind === "EXCESS");
  check(
    "the stray box is excess, and named to the consignment it really belongs to",
    excessRows.some((d) => d.shipmentId === stray.shipmentId),
    stray.lrNumber,
  );
  check(
    "the unreadable label is excess with no consignment at all",
    excessRows.some((d) => d.shipmentId === null && d.barcode?.includes("FOREIGN-LABEL")),
  );

  result.shortLr = missing.lrNumber;
  result.excessLr = stray.lrNumber;

  // ── The timeline ──────────────────────────────────────────
  const shortEvents = await prisma.shipmentEvent.findMany({
    where: { shipmentId: missing.shipmentId, eventType: "DISCREPANCY_RAISED" },
    select: { remarks: true },
  });
  check(
    "the consignment's own timeline records the shortage",
    shortEvents.length === 1,
    shortEvents[0]?.remarks ?? "no event",
  );

  // ── The control tower ─────────────────────────────────────
  //
  // A discrepancy row records that freight is missing; it makes nobody
  // answer for it. `SHORT_RECEIVED` and `EXCESS_RECEIVED` were defined
  // with owners and escalation ladders and raised by nothing at all, so
  // the tower — the screen a duty manager runs the shift from — never
  // heard about the single most expensive thing a hub finds.
  section("And it reaches the control tower");

  check(
    "closing opened exceptions",
    closed.exceptionNumbers.length >= 3,
    closed.exceptionNumbers.join(", ") || "none",
  );

  const raised = await prisma.exception.findMany({
    where: { dedupeKey: { startsWith: `receipt:${opened.receiptId}:` } },
    select: {
      number: true,
      kind: true,
      priority: true,
      shipmentId: true,
      branchId: true,
      ownerBranchId: true,
      status: true,
      escalateAt: true,
      title: true,
    },
  });

  const shortExceptions = raised.filter((e) => e.kind === "SHORT_RECEIVED");
  const excessExceptions = raised.filter((e) => e.kind === "EXCESS_RECEIVED");

  check(
    "one short-received exception per affected consignment",
    shortExceptions.length === 2,
    shortExceptions.map((e) => e.number).join(", ") || "none",
  );
  check(
    "one excess-received exception per unlisted consignment, plus one for the unidentified freight",
    excessExceptions.length === 2,
    excessExceptions.map((e) => e.title).join(" | ") || "none",
  );
  check(
    "the tower attributes them to Gurugram too",
    raised.length > 0 && raised.every((e) => e.ownerBranchId === origin.id),
  );
  check(
    "while recording Delhi as where they were found",
    raised.length > 0 && raised.every((e) => e.branchId === hub.id),
  );
  check(
    "a shortage is raised high and starts an escalation clock",
    shortExceptions.every((e) => e.priority === "HIGH" && e.escalateAt !== null),
  );
  check(
    "the shortage names the consignment, so the loss report can count it",
    shortExceptions.some((e) => e.shipmentId === missing.shipmentId),
  );

  result.shortExceptionNumber =
    shortExceptions.find((e) => e.shipmentId === missing.shipmentId)?.number ?? null;

  // ── A manifest is reconciled once ─────────────────────────
  section("A reconciled manifest cannot be received a second time");

  const receiptCount = await prisma.inboundReceipt.count({
    where: { manifestId: manifest.manifestId },
  });

  const second = await openReceipt(
    { manifestId: manifest.manifestId, branchId: hub.id },
    delOperator,
  );
  check(
    "a second receipt on the same manifest is refused",
    !second.ok,
    second.ok ? "it was allowed" : second.error,
  );
  check(
    "and no second receipt row exists to re-file every box as short again",
    (await prisma.inboundReceipt.count({ where: { manifestId: manifest.manifestId } })) ===
      receiptCount,
  );

  const reclose = await closeReceipt({ receiptId: opened.receiptId }, delManager);
  check(
    "closing an already-closed receipt is refused",
    !reclose.ok,
    reclose.ok ? "it was allowed" : reclose.error,
  );
  check(
    "and did not duplicate the discrepancies",
    (await prisma.receiptDiscrepancy.count({ where: { receiptId: opened.receiptId } })) === 4,
  );

  // ── Settling one ──────────────────────────────────────────
  section("A discrepancy is settled, never deleted");

  const toResolve = await prisma.receiptDiscrepancy.findFirstOrThrow({
    where: { receiptId: opened.receiptId, kind: "SHORT" },
    select: { id: true },
  });

  const thin = await resolveDiscrepancy(
    { discrepancyId: toResolve.id, resolution: "ok" },
    delManager,
  );
  check("a one-word resolution is refused", !thin.ok, thin.ok ? "it was allowed" : thin.error);

  const byOutsider = await resolveDiscrepancy(
    { discrepancyId: toResolve.id, resolution: "Found it in our own bay." },
    bomManager,
  );
  check(
    "another branch cannot settle Delhi's discrepancy",
    !byOutsider.ok,
    byOutsider.ok ? "it was allowed" : byOutsider.error,
  );
  check(
    "and neither refusal marked it resolved",
    (
      await prisma.receiptDiscrepancy.findUniqueOrThrow({
        where: { id: toResolve.id },
        select: { resolvedAt: true },
      })
    ).resolvedAt === null,
  );

  const resolved = await resolveDiscrepancy(
    { discrepancyId: toResolve.id, resolution: "Found behind pallet 4 and scanned in." },
    delManager,
  );
  check("the branch manager settles it", resolved.ok, resolved.ok ? "" : resolved.error);

  const after = await prisma.receiptDiscrepancy.findUniqueOrThrow({
    where: { id: toResolve.id },
    select: { resolvedAt: true, resolution: true, resolvedById: true },
  });
  check(
    "the row survives with the outcome beside it",
    after.resolvedAt !== null && after.resolution !== null && after.resolvedById === delManager.id,
    after.resolution ?? "",
  );

  // ── The tower's own writes are scoped ─────────────────────
  section("The tower's buttons are scoped, not just its lists");

  if (result.shortExceptionNumber) {
    const target = await prisma.exception.findFirstOrThrow({
      where: { number: result.shortExceptionNumber },
      select: { id: true, status: true },
    });

    const stolen = await transitionException(
      { exceptionId: target.id, to: "RESOLVED", note: "Nothing to do with us." },
      bomManager,
    );
    check(
      "a Mumbai manager cannot resolve a Gurugram shortage found in Delhi",
      !stolen.ok,
      stolen.ok ? "it was allowed" : stolen.error,
    );
    check(
      "and the exception is exactly as it was",
      (
        await prisma.exception.findUniqueOrThrow({
          where: { id: target.id },
          select: { status: true },
        })
      ).status === target.status,
    );

    const notesBefore = await prisma.exceptionAction.count({ where: { exceptionId: target.id } });
    const stolenNote = await addExceptionNote(target.id, "Passing through.", bomManager);
    check(
      "nor add a note to it",
      !stolenNote.ok,
      stolenNote.ok ? "it was allowed" : stolenNote.error,
    );
    check(
      "and no note was written",
      (await prisma.exceptionAction.count({ where: { exceptionId: target.id } })) === notesBefore,
    );

    const owned = await transitionException(
      { exceptionId: target.id, to: "ACKNOWLEDGED", note: "" },
      delManager,
    );
    check(
      "the Delhi manager who found it can acknowledge it",
      owned.ok,
      owned.ok ? owned.message : owned.error,
    );
  }

  // ── The stock audit ───────────────────────────────────────
  section("A stock audit counts and moves nothing");

  const auditBarcode = wholePackages[0].barcode;
  const beforeAudit = await prisma.shipmentPackage.findFirstOrThrow({
    where: { barcode: auditBarcode },
    select: { id: true, status: true, currentBranchId: true },
  });

  const audit = await recordScan(
    {
      barcode: auditBarcode,
      scanType: "AUDIT",
      branchId: hub.id,
      idempotencyKey: crypto.randomUUID(),
    },
    delOperator,
  );
  check("the audit scan is recorded", audit.ok && Boolean(audit.scanRecordId), audit.message);

  const afterAudit = await prisma.shipmentPackage.findUniqueOrThrow({
    where: { id: beforeAudit.id },
    select: { status: true, currentBranchId: true },
  });
  check(
    "and the package is exactly where and what it was",
    afterAudit.status === beforeAudit.status &&
      afterAudit.currentBranchId === beforeAudit.currentBranchId,
    `${afterAudit.status} at the same branch`,
  );

  const audited = await prisma.shipmentEvent.count({
    where: { shipmentId: whole.shipmentId, payload: { path: ["scanType"], equals: "AUDIT" } },
  });
  check("an audit moves nothing on the timeline either", audited === 0);

  // ── A bin is a place on one floor ─────────────────────────
  //
  // The console only offers the bins of the dock the operator picked, but
  // the bin id comes off the client and nothing checked it. A sort scan
  // naming Mumbai's bin wrote a location row saying the box is in a
  // Mumbai lane while the same call moved the package to Delhi — and that
  // row is the floor's whole answer to "where is it?".
  section("A package cannot be sorted into another branch's bin");

  // A bin of its own at the outsider branch, so the check does not depend
  // on how the floor at Mumbai happens to be laid out today.
  const foreignBin = await prisma.sortBin.upsert({
    where: { branchId_code: { branchId: outsider.id, code: "VERIFY-HUB" } },
    create: {
      orgId: delOperator.orgId,
      branchId: outsider.id,
      code: "VERIFY-HUB",
      name: "Reserved for scripts/verify-hub.ts",
    },
    update: { isActive: true },
    select: { id: true, code: true },
  });

  {
    const sortTarget = wholePackages[1].barcode;
    const locationBefore = await prisma.packageLocation.findFirst({
      where: { package: { barcode: sortTarget } },
      select: { binId: true, branchId: true },
    });

    const misplaced = await recordScan(
      {
        barcode: sortTarget,
        scanType: "SORT",
        branchId: hub.id,
        binId: foreignBin.id,
        idempotencyKey: crypto.randomUUID(),
      },
      delOperator,
    );
    check(
      "a bin belonging to another branch is refused",
      !misplaced.ok,
      misplaced.ok ? "it was allowed" : misplaced.message,
    );

    const locationAfter = await prisma.packageLocation.findFirst({
      where: { package: { barcode: sortTarget } },
      select: { binId: true, branchId: true },
    });
    check(
      "and the package was not filed into it on the way to the refusal",
      (locationAfter?.binId ?? null) === (locationBefore?.binId ?? null) &&
        (locationAfter?.branchId ?? null) === (locationBefore?.branchId ?? null),
      locationAfter?.binId ?? "no location row",
    );
  }

  // ── Weighment ─────────────────────────────────────────────
  section("Weighment prices before it commits");

  const weighable = await prisma.shipment.findUniqueOrThrow({
    where: { id: whole.shipmentId },
    select: { id: true, lrNumber: true, chargeableWeight: true, grandTotal: true, currentStatus: true },
  });
  result.weighableLr = weighable.lrNumber;

  const preview = await previewRevisedWeight(
    { shipmentId: weighable.id, actualWeight: 42 },
    delOperator,
  );
  check(
    "the clerk can see what the reading would cost",
    preview.ok,
    preview.ok ? `₹${preview.previousTotal.toFixed(2)} → ₹${preview.revisedTotal.toFixed(2)}` : preview.error,
  );

  const unchanged = await prisma.shipment.findUniqueOrThrow({
    where: { id: weighable.id },
    select: { chargeableWeight: true, grandTotal: true },
  });
  check(
    "and the preview applied nothing to the consignment",
    unchanged.chargeableWeight.toString() === weighable.chargeableWeight.toString() &&
      unchanged.grandTotal.toString() === weighable.grandTotal.toString(),
    `still ${unchanged.chargeableWeight} kg`,
  );

  const noPermission = await captureRevisedWeight(
    { shipmentId: weighable.id, branchId: hub.id, actualWeight: 42 },
    bomManager,
  );
  check(
    "a manager whose scope does not reach Delhi cannot weigh there",
    !noPermission.ok,
    noPermission.ok ? "it was allowed" : noPermission.error,
  );

  // The same manager, this time naming their own branch. Only the branch
  // on the input was checked, so a Mumbai manager could reprice a
  // consignment that has never been within seven hundred miles of them —
  // and repricing raises a debit note and tells the customer about it.
  const elsewhere = await captureRevisedWeight(
    { shipmentId: weighable.id, branchId: outsider.id, actualWeight: 91 },
    bomManager,
  );
  check(
    "nor by claiming to have weighed it on their own scale",
    !elsewhere.ok,
    elsewhere.ok ? "it was allowed" : elsewhere.error,
  );
  check(
    "and the price is exactly what it was before the attempt",
    (
      await prisma.shipment.findUniqueOrThrow({
        where: { id: weighable.id },
        select: { grandTotal: true },
      })
    ).grandTotal.toString() === weighable.grandTotal.toString(),
    `still ₹${weighable.grandTotal}`,
  );

  const peeked = await previewRevisedWeight(
    { shipmentId: weighable.id, actualWeight: 91 },
    bomManager,
  );
  check(
    "and cannot price another branch's freight even without committing it",
    !peeked.ok,
    peeked.ok ? "it was allowed" : peeked.error,
  );

  const zero = await captureRevisedWeight(
    { shipmentId: weighable.id, branchId: hub.id, actualWeight: 0 },
    delOperator,
  );
  check("a reading of zero is not a weighing", !zero.ok, zero.ok ? "it was allowed" : zero.error);

  const captured = await captureRevisedWeight(
    {
      shipmentId: weighable.id,
      branchId: hub.id,
      actualWeight: 42,
      reference: `WB-${stamp}`,
    },
    delOperator,
  );
  check(
    "the hub operator records the scale reading",
    captured.ok,
    captured.ok
      ? `${captured.previousChargeableWeight.toFixed(3)} → ${captured.revisedChargeableWeight.toFixed(3)} kg`
      : captured.error,
  );

  if (captured.ok) {
    const repriced = await prisma.shipment.findUniqueOrThrow({
      where: { id: weighable.id },
      select: { chargeableWeight: true },
    });
    check(
      "and the consignment now bills on it",
      repriced.chargeableWeight.toString() !== weighable.chargeableWeight.toString(),
      `${repriced.chargeableWeight} kg`,
    );
    check(
      "with a weight-captured event to explain the change six weeks from now",
      (await prisma.shipmentEvent.count({
        where: { shipmentId: weighable.id, eventType: "WEIGHT_CAPTURED" },
      })) > 0,
    );
  }

  return result;
}

// ────────────────────────────────────────────────────────────
// The screens, as the people who use them
// ────────────────────────────────────────────────────────────

async function screens(built: Built) {
  section("The screens, driven as signed-in people");

  // The navigation offers "Inbound receipts" on `receipt.read`, and the
  // page guarded itself on `scan.inbound` — so every read-only role was
  // shown the link and thrown to the 403 page for following it. The two
  // are compared here rather than only exercised, because the roles that
  // expose the gap are not the ones with logins in the seed.
  const root = path.resolve(__dirname, "..");
  const nav = readFileSync(path.join(root, "src/components/shell/nav.ts"), "utf8");
  const inboundPage = readFileSync(
    path.join(root, "src/app/(ops)/hub/inbound/page.tsx"),
    "utf8",
  );
  const navPermission = /href:\s*"\/hub\/inbound",[\s\S]{0,200}?permission:\s*"([^"]+)"/.exec(nav)?.[1];
  const guard = /requirePermission\("([^"]+)"\)/.exec(inboundPage)?.[1];
  check(
    "the inbound board is guarded on the permission its nav entry advertises",
    Boolean(navPermission) && navPermission === guard,
    `nav ${navPermission} / page ${guard}`,
  );

  // `previewRevisedWeight` was written to let a clerk see the money before
  // committing to it and then had no caller for its whole life, so the one
  // button on the screen repriced, raised a debit note and told the
  // customer in a single irreversible press. The control it feeds only
  // exists once a consignment has been picked, which no server render can
  // show — so the wiring is asserted at the source.
  const weighForm = readFileSync(
    path.join(root, "src/app/(ops)/hub/weigh/weigh-form.tsx"),
    "utf8",
  );
  const weighActions = readFileSync(
    path.join(root, "src/app/(ops)/hub/weigh/actions.ts"),
    "utf8",
  );
  check(
    "the weighment screen is wired to the price preview, not only to the commit",
    weighForm.includes("previewWeight") &&
      weighForm.includes("Check the price first") &&
      weighActions.includes("previewRevisedWeight"),
  );

  const operator = await signIn(DEL_OPERATOR, "/hub");

  const floor = await hostFollow(HOST, PORT, "/hub", operator);
  check(
    "the branch floor renders for the hub operator",
    floor.status === 200 && !floor.finalPath.includes("/login") && !floor.finalPath.includes("/forbidden"),
    `HTTP ${floor.status} at ${floor.finalPath}`,
  );
  check(
    "and puts the work in front of them",
    floor.body.includes("Receipts open") && floor.body.includes("Open discrepancies"),
  );

  const scan = await hostFollow(HOST, PORT, "/hub/scan", operator);
  check(
    "the scan console renders",
    scan.status === 200 && !scan.finalPath.includes("/forbidden"),
    `HTTP ${scan.status} at ${scan.finalPath}`,
  );
  check(
    "with all six modes the operator's role allows",
    ["Inbound", "Sort", "Load", "Outbound", "Unload", "Stock audit"].every((mode) =>
      scan.body.includes(mode),
    ),
  );

  const weigh = await hostFollow(HOST, PORT, "/hub/weigh", operator);
  check(
    "the weighment screen renders",
    weigh.status === 200 && !weigh.finalPath.includes("/forbidden"),
    `HTTP ${weigh.status} at ${weigh.finalPath}`,
  );
  check(
    "listing only what has been received and can be weighed",
    weigh.body.includes("Weigh") && !weigh.body.includes("Nothing received here is waiting"),
  );
  if (built.weighableLr) {
    check(
      "including the consignment the hub just took in",
      weigh.body.includes(built.weighableLr),
      built.weighableLr,
    );
  }

  const inbound = await hostFollow(HOST, PORT, "/hub/inbound", operator);
  check(
    "the inbound board renders",
    inbound.status === 200 && !inbound.finalPath.includes("/forbidden"),
    `HTTP ${inbound.status} at ${inbound.finalPath}`,
  );

  if (built.manifestNumber) {
    check(
      "and the manifest just reconciled is on the recently-closed list",
      inbound.body.includes(built.manifestNumber),
      built.manifestNumber,
    );
  }

  if (built.receiptId) {
    const receipt = await hostFollow(HOST, PORT, `/hub/inbound/${built.receiptId}`, operator);
    check(
      "the reconciled receipt opens",
      receipt.status === 200 && !receipt.finalPath.includes("/forbidden"),
      `HTTP ${receipt.status} at ${receipt.finalPath}`,
    );
    check(
      "showing what was short and what arrived unannounced",
      receipt.body.includes("SHORT") && receipt.body.includes("EXCESS"),
    );
    check(
      "and naming the branch that owns them",
      receipt.body.includes(ORIGIN),
      ORIGIN,
    );
    check(
      "with the lines as reconciled beneath them",
      receipt.body.includes("Lines as reconciled") && receipt.body.includes("Discrepancies"),
    );
  }

  // ── A role with no business on the dock ───────────────────
  const booking = await signIn(DEL_BOOKING, "/hub");

  const bookingScan = await hostFollow(HOST, PORT, "/hub/scan", booking);
  check(
    "a booking executive is refused the scan console",
    bookingScan.finalPath.includes("/forbidden"),
    bookingScan.finalPath,
  );
  const bookingInbound = await hostFollow(HOST, PORT, "/hub/inbound", booking);
  check(
    "and the inbound board",
    bookingInbound.finalPath.includes("/forbidden"),
    bookingInbound.finalPath,
  );

  // ── A role that does one thing on the dock ────────────────
  //
  // The dispatch manager is granted `scan.outbound` and `loading.execute`
  // and not `scan.inbound`. The console is the only screen in the product
  // that offers an outbound scan and it was guarded on `scan.inbound`, so
  // the permission their role is given had nowhere at all to be used.
  const dispatcher = await signIn(DEL_DISPATCH, "/hub/scan");
  const dispatcherScan = await hostFollow(HOST, PORT, "/hub/scan", dispatcher);
  check(
    "a dispatch manager can reach the console their outbound permission is for",
    dispatcherScan.status === 200 && !dispatcherScan.finalPath.includes("/forbidden"),
    `HTTP ${dispatcherScan.status} at ${dispatcherScan.finalPath}`,
  );
  check(
    "and is offered outbound and load, and not the modes they cannot do",
    dispatcherScan.body.includes("Outbound") &&
      dispatcherScan.body.includes("Stock audit") === false,
    "outbound without the inbound-only modes",
  );

  // ── The tower ─────────────────────────────────────────────
  const manager = await signIn(DEL_MANAGER, "/exceptions");

  const tower = await hostFollow(HOST, PORT, "/exceptions", manager);
  check(
    "the exception tower renders for the branch manager",
    tower.status === 200 && !tower.finalPath.includes("/forbidden"),
    `HTTP ${tower.status} at ${tower.finalPath}`,
  );

  if (built.shortExceptionNumber) {
    // Looked up rather than read off the first page. The tower sorts worst
    // first and then oldest first, so a shortage raised a second ago is
    // the *last* of the high-priority rows — on a busy network it is
    // legitimately on page three, and asserting against page one would
    // fail for the healthiest possible reason.
    const searched = await hostFollow(
      HOST,
      PORT,
      `/exceptions?q=${built.shortExceptionNumber}`,
      manager,
    );
    check(
      "and the shortage raised by the close is in the tower",
      searched.status === 200 && searched.body.includes(built.shortExceptionNumber),
      built.shortExceptionNumber,
    );

    const found = await runWithTenantId(async () =>
      prisma.exception.findFirst({
        where: { number: built.shortExceptionNumber as string },
        select: { id: true },
      }),
    );

    if (found) {
      const detail = await hostFollow(HOST, PORT, `/exceptions/${found.id}`, manager);
      check(
        "the exception opens",
        detail.status === 200 && detail.body.includes(built.shortExceptionNumber),
        `HTTP ${detail.status}`,
      );
      // Read out of the "Owner branch" fact itself rather than looked for
      // anywhere on the page. `ORIGIN` also appears in the consignment's
      // lane a few centimetres lower, so a page naming Delhi as the owner
      // would have satisfied a plain `body.includes(ORIGIN)` — which is
      // exactly what it was doing. The relation behind that label hangs
      // off `branchId`, where the shortage was *found*, and the branch
      // that owes for it is `ownerBranchId`.
      const ownerFact = detail.body.slice(
        detail.body.indexOf("Owner branch"),
        detail.body.indexOf("Owner branch") + 300,
      );
      check(
        "the owner branch on the page is the one that dispatched",
        detail.body.includes("Owner branch") && ownerFact.includes(ORIGIN),
        ownerFact.includes(HUB) ? `it names ${HUB}, which only found it` : ORIGIN,
      );
      check(
        "and where it was found is shown separately, not instead",
        detail.body.includes("Found at"),
      );

      // Mumbai is neither where it was found nor who owns it, and it is
      // assigned to nobody — so it is not theirs to see.
      const outsider = await signIn(BOM_MANAGER, "/exceptions");
      const hidden = await hostFollow(HOST, PORT, `/exceptions/${found.id}`, outsider);
      check(
        "a Mumbai manager cannot open it at all",
        hidden.status === 404,
        `HTTP ${hidden.status}`,
      );
    }
  }

  const operatorTower = await hostFollow(HOST, PORT, "/exceptions", operator);
  check(
    "a hub operator, who holds no exception permission, is refused the tower",
    operatorTower.finalPath.includes("/forbidden"),
    operatorTower.finalPath,
  );
}

/** A tenant-scoped read from the screen phase, which runs outside one. */
async function runWithTenantId<T>(fn: () => Promise<T>): Promise<T> {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${SUBDOMAIN}" is closed.`);
  return runWithTenant(tenant, async () => await fn());
}

main().catch((error) => {
  console.error("\nThe hub check could not run:\n", error);
  process.exit(1);
});
