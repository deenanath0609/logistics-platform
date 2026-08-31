/**
 * Can a branch run the flow with its own people?
 *
 *   npx tsx scripts/verify-branch-flow.ts [--tenant city-logistics]
 *
 * Every other verification in this folder proves a mechanism: the spine
 * projects status from its log, the pickup services refuse a stale device,
 * the screens render. None of them answers the question a carrier actually
 * asks before going live, which is whether the people standing in a branch
 * can move a consignment without telephoning head office.
 *
 * That question is not about code. It is about who holds which permission at
 * which branch, and it is invisible to unit tests, because a permission
 * matrix is data. It has already been wrong here: the only booking clerk in
 * the seed could raise a collection but neither assign it nor scan the goods
 * her own counter received, so a consignment booked at Gurugram could not
 * leave Gurugram unless the network administrator signed in and did it.
 *
 * So this runs in two parts.
 *
 * The roll call asks, for each branch, whether somebody stationed there
 * holds each permission the flow needs at that branch — no consignment is
 * touched, and a missing post is named with the step it blocks.
 *
 * The relay then books two consignments at the origin and walks them to
 * delivery, and every single event is posted **as the person whose job it
 * is**, never as an administrator. Both ways in are covered: one collected
 * by a van, one carried to the counter, which is the path that had no edge
 * in the state machine until today.
 *
 * A step that a branch cannot staff fails here rather than at a dock.
 */
import "dotenv/config";
import { basePrisma, prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor } from "../src/lib/tenant";
import { createBooking } from "../src/lib/shipment/booking";
import { appendShipmentEvent, replayStatus } from "../src/lib/shipment/events";
import { coversBranch } from "../src/server/repositories/scope";
import { can } from "../src/lib/auth/session";
import type { SessionUser } from "../src/lib/auth/session";
import type { Prisma, ShipmentEventType } from "../src/generated/prisma/client";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const SUBDOMAIN = arg("tenant", "city-logistics");

let passes = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * The steps of the operating flow, in order, as permissions.
 *
 * `where` is the branch the step physically happens at, expressed as a role
 * in the lane rather than a code, so the same table can be read against any
 * lane. This is the process the operator is handed, written down once.
 */
const FLOW = [
  { step: "Book a consignment", permission: "shipment.create", where: "origin" },
  { step: "Raise a collection", permission: "pickup.create", where: "origin" },
  { step: "Send a van for it", permission: "pickup.assign", where: "origin" },
  { step: "Collect at the door", permission: "pickup.execute", where: "origin" },
  { step: "Receive it inbound", permission: "scan.inbound", where: "origin" },
  { step: "Weigh it", permission: "weight.capture", where: "origin" },
  { step: "Sort it to a bin", permission: "scan.sort", where: "origin" },
  { step: "Manifest the leg", permission: "manifest.create", where: "hub" },
  { step: "Load the vehicle", permission: "loading.execute", where: "hub" },
  { step: "Gate it out", permission: "trip.dispatch", where: "hub" },
  { step: "Receive it at the hub", permission: "scan.inbound", where: "destination" },
  { step: "Put it on a delivery run", permission: "delivery.assign", where: "destination" },
  { step: "Deliver it", permission: "delivery.execute", where: "destination" },
] as const;

/**
 * A session exactly as sign-in would build one.
 *
 * Widest scope wins across roles, and `branchIds` is null only for NETWORK —
 * which is what makes `coversBranch` mean anything below. Building this by
 * hand rather than importing the session helper is deliberate: the helper
 * needs a request, and the point of the check is the data, not the plumbing.
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

/** Everybody whose primary branch is this one, with their session built. */
async function crewAt(branchId: string): Promise<SessionUser[]> {
  const users = await prisma.user.findMany({
    where: { primaryBranchId: branchId, status: "ACTIVE" },
    select: { mobile: true },
    orderBy: { mobile: "asc" },
  });

  const crew: SessionUser[] = [];
  for (const u of users) {
    const session = await sessionFor(u.mobile);
    if (session) crew.push(session);
  }
  return crew;
}

/**
 * Somebody at this branch who may do this, and whose scope reaches it.
 *
 * Both halves matter and the second is the one that bites: a BRANCH-scoped
 * manager at the Delhi hub holds `scan.inbound` and still cannot receive
 * freight at Gurugram, so holding the permission is not the same as being
 * able to do the job here.
 */
function whoCan(
  crew: SessionUser[],
  permission: string,
  branchId: string,
): SessionUser | undefined {
  return crew.find((u) => can(u, permission) && coversBranch(u, branchId));
}

async function post(
  eventType: ShipmentEventType,
  shipmentId: string,
  actor: SessionUser,
  branchId: string,
  payload: Prisma.InputJsonObject = {},
) {
  return appendShipmentEvent({ shipmentId, eventType, branchId, payload }, actor);
}

async function main() {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${SUBDOMAIN}" is closed.`);

  await runWithTenant(tenant, async () => {
    const branches = await prisma.branch.findMany({
      where: { code: { in: ["BR-GGN", "HUB-DEL", "HUB-JAI", "HO-DEL"] } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    });
    const byCode = new Map(branches.map((b) => [b.code, b]));

    const origin = byCode.get("BR-GGN");
    const hub = byCode.get("HUB-DEL");
    const destination = byCode.get("HUB-JAI");
    if (!origin || !hub || !destination) {
      throw new Error("The test lane needs BR-GGN, HUB-DEL and HUB-JAI.");
    }

    // ── Roll call ─────────────────────────────────────────────
    //
    // Read down a branch's list and you have its staffing gaps.
    console.log("\nRoll call — can each branch staff its own steps?\n");

    const crews = new Map<string, SessionUser[]>();
    for (const branch of branches) crews.set(branch.code, await crewAt(branch.id));

    for (const branch of branches) {
      const crew = crews.get(branch.code) ?? [];
      console.log(`${branch.code} — ${branch.name} (${crew.length} people)`);

      // Every branch is checked against every step, not only the ones its
      // place in this lane happens to need: a branch is an origin on one
      // consignment and a destination on the next.
      const needed = [...new Set(FLOW.map((f) => f.permission))];
      for (const permission of needed) {
        const steps = FLOW.filter((f) => f.permission === permission).map((f) => f.step);
        const holder = whoCan(crew, permission, branch.id);
        check(
          steps.join(" / "),
          Boolean(holder),
          holder ? `${holder.name} (${holder.mobile})` : `nobody at ${branch.code} can`,
        );
      }
      console.log("");
    }

    // ── The relay ─────────────────────────────────────────────
    console.log("The relay — one consignment per way in, each step by its own person\n");

    const [service, packageType, gurugram, jaipur] = await Promise.all([
      // The booking below is PTL, and the masters carry FTL service types
      // too — which booking rightly refuses to mix.
      prisma.serviceType.findFirstOrThrow({ where: { isActive: true, mode: "PTL" } }),
      prisma.packageType.findFirstOrThrow({ where: { isActive: true } }),
      prisma.city.findFirstOrThrow({ where: { code: "GGN" } }),
      prisma.city.findFirstOrThrow({ where: { code: "JAI" } }),
    ]);

    const originCrew = crews.get(origin.code) ?? [];
    const hubCrew = crews.get(hub.code) ?? [];
    const destinationCrew = crews.get(destination.code) ?? [];

    const booker = whoCan(originCrew, "shipment.create", origin.id);
    check("somebody at the origin can book", Boolean(booker), booker?.name ?? "nobody");
    if (!booker) return;

    const book = (pickupRequired: boolean, label: string) =>
      createBooking(
        {
          mode: "PTL",
          serviceTypeId: service.id,
          bookingBranchId: origin.id,
          originBranchId: origin.id,
          destinationBranchId: destination.id,
          consignorName: `Branch flow — ${label}`,
          consignorPhone: "9811100011",
          consignorAddress: "Plot 14, Udyog Vihar Phase IV",
          consignorCityId: gurugram.id,
          consignorPincode: "122015",
          consigneeName: `Branch flow — ${label}`,
          consigneePhone: "9811100012",
          consigneeAddress: "22 Vaishali Nagar",
          consigneeCityId: jaipur.id,
          consigneePincode: "302013",
          packageCount: 2,
          packageTypeId: packageType.id,
          actualWeight: 8,
          goodsDescription: "Branch flow verification — auto-generated",
          declaredValue: 12000,
          paymentType: "PAID",
          pickupRequired,
        },
        booker,
      );

    // ── Way in 1: a van goes for it ───────────────────────────
    console.log("Collected by a van");

    const collected = await book(true, "collected");
    check("booked at the origin", collected.ok, collected.ok ? collected.lrNumber : collected.error);
    if (!collected.ok) return;

    check(
      "and the collection was raised with it",
      Boolean(collected.pickupNumber),
      collected.pickupNumber ?? "no pickup number came back",
    );

    const assigner = whoCan(originCrew, "pickup.assign", origin.id);
    check("somebody at the origin can send the van", Boolean(assigner), assigner?.name ?? "nobody");

    if (assigner) {
      const assigned = await post("PICKUP_ASSIGNED", collected.shipmentId, assigner, origin.id);
      check("the van is assigned", assigned.ok, assigned.ok ? "PICKUP_ASSIGNED" : assigned.error);

      const collector = whoCan(originCrew, "pickup.execute", origin.id);
      check("somebody at the origin can collect", Boolean(collector), collector?.name ?? "nobody");

      if (collector) {
        const done = await post("PICKUP_COMPLETED", collected.shipmentId, collector, origin.id);
        check("the goods are collected", done.ok, done.ok ? "PICKED_UP" : done.error);
      }
    }

    // ── Way in 2: the consignor brings it to the counter ──────
    //
    // Until today `BOOKED` led only to the two pickup events, so this
    // consignment could not enter the network at all without a branch
    // raising a collection for a van that never left the yard.
    console.log("\nCarried to the counter");

    const counter = await book(false, "counter");
    check("booked at the counter", counter.ok, counter.ok ? counter.lrNumber : counter.error);
    if (!counter.ok) return;

    check(
      "and no van was raised for it",
      !counter.pickupNumber,
      counter.pickupNumber ? `a pickup was raised: ${counter.pickupNumber}` : "none, correctly",
    );

    const receiver = whoCan(originCrew, "scan.inbound", origin.id);
    check("somebody at the origin can receive it", Boolean(receiver), receiver?.name ?? "nobody");
    if (!receiver) return;

    const walkedIn = await post("INBOUND_SCAN", counter.shipmentId, receiver, origin.id);
    check(
      "a counter drop-off enters the network straight from BOOKED",
      walkedIn.ok && walkedIn.previousStatus === "BOOKED" &&
        walkedIn.currentStatus === "RECEIVED_AT_ORIGIN",
      walkedIn.ok
        ? `${walkedIn.previousStatus} → ${walkedIn.currentStatus}`
        : walkedIn.error,
    );

    // ── Both now travel together ──────────────────────────────
    console.log("\nOn through the network");

    const received = await post("INBOUND_SCAN", collected.shipmentId, receiver, origin.id);
    check(
      "the collected one is received too",
      received.ok && received.currentStatus === "RECEIVED_AT_ORIGIN",
      received.ok ? `${received.previousStatus} → ${received.currentStatus}` : received.error,
    );

    const both = [collected.shipmentId, counter.shipmentId];

    /** Every consignment through one step, by one person, or a named failure. */
    async function everybody(
      label: string,
      event: ShipmentEventType,
      actor: SessionUser,
      branchId: string,
      expected: string,
      payload: Prisma.InputJsonObject = {},
    ) {
      const errors: string[] = [];
      for (const id of both) {
        const result = await post(event, id, actor, branchId, payload);
        if (!result.ok) errors.push(result.error);
      }
      check(label, errors.length === 0, errors.length === 0 ? expected : errors.join("; "));
      return errors.length === 0;
    }

    const sorter = whoCan(originCrew, "scan.sort", origin.id);
    check("somebody at the origin can sort", Boolean(sorter), sorter?.name ?? "nobody");
    if (!sorter) return;
    if (!(await everybody("both are sorted to a bin", "SORTED", sorter, origin.id, "PROCESSED"))) return;

    const manifester = whoCan(hubCrew, "manifest.create", hub.id);
    check("somebody at the hub can manifest", Boolean(manifester), manifester?.name ?? "nobody");
    if (!manifester) return;
    if (!(await everybody("both are on a manifest", "MANIFEST_ADDED", manifester, hub.id, "MANIFESTED"))) return;

    const dispatcher = whoCan(hubCrew, "trip.dispatch", hub.id);
    check("somebody at the hub can gate it out", Boolean(dispatcher), dispatcher?.name ?? "nobody");
    if (!dispatcher) return;
    if (!(await everybody("both are dispatched", "GATE_OUT", dispatcher, hub.id, "DISPATCHED"))) return;
    if (!(await everybody("both arrive at the destination", "GATE_IN", dispatcher, destination.id, "ARRIVED_AT_HUB"))) return;

    const hubReceiver = whoCan(destinationCrew, "scan.inbound", destination.id);
    check("somebody at the destination can receive", Boolean(hubReceiver), hubReceiver?.name ?? "nobody");
    if (!hubReceiver) return;
    if (!(await everybody("both are received at the destination", "INBOUND_SCAN", hubReceiver, destination.id, "RECEIVED_AT_HUB"))) return;

    const runner = whoCan(destinationCrew, "delivery.assign", destination.id);
    check("somebody at the destination can raise a run", Boolean(runner), runner?.name ?? "nobody");
    if (!runner) return;
    if (!(await everybody("both are on a delivery run", "DELIVERY_ASSIGNED", runner, destination.id, "ASSIGNED_FOR_DELIVERY"))) return;

    const agent = whoCan(destinationCrew, "delivery.execute", destination.id);
    check("somebody at the destination can deliver", Boolean(agent), agent?.name ?? "nobody");
    if (!agent) return;
    if (!(await everybody("both go out for delivery", "RUN_STARTED", agent, destination.id, "OUT_FOR_DELIVERY"))) return;
    if (
      !(await everybody("both are delivered", "DELIVERED", agent, destination.id, "DELIVERED", {
        receivedBy: "Branch flow verification",
      }))
    ) {
      return;
    }

    // ── The log is still the truth ────────────────────────────
    console.log("\nThe event log");

    for (const [label, id] of [
      ["collected", collected.shipmentId],
      ["counter", counter.shipmentId],
    ] as const) {
      const shipment = await prisma.shipment.findUniqueOrThrow({
        where: { id },
        select: { lrNumber: true },
      });
      const { replayed, stored, matches } = await replayStatus(id);
      check(
        `the ${label} consignment's stored status is what its log projects to`,
        matches,
        `${shipment.lrNumber} — ${stored} vs ${replayed}`,
      );
    }
  });

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} passed, ${failures} failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("\nThe branch flow check could not run:\n", error);
  await prisma.$disconnect();
  process.exit(1);
});
