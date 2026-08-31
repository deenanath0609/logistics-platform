/**
 * Drives a pickup from the doorstep, the way the executive's phone does.
 *
 *   npx tsx scripts/verify-pickup-cycle.ts [tenant-subdomain]
 *
 * Until now this could not be written, because the product had no way to
 * finish a pickup. It could be raised, assigned and cancelled; `IN_PROGRESS`,
 * `COMPLETED` and `FAILED` were in the enum, `PickupAttempt` was in the
 * schema and `nextAttemptDate` was written and tested, and nothing reached
 * any of them. A carrier could send an executive out and had nowhere to
 * record that the goods came back.
 *
 * What this proves, in order:
 *
 *   · a raised pickup is assigned, and starting the run marks it in
 *     progress rather than leaving it looking untouched;
 *   · a failed attempt is a row and not a flag — the visit survives, the
 *     request returns to the executive for the next working day, and the
 *     shipment records the attempt without pretending it was collected;
 *   · a second attempt that succeeds does not erase the first;
 *   · what was collected is recorded as counted, and a shortfall against
 *     the booking is left standing rather than written over it;
 *   · replaying either action with the same idempotency key does not record
 *     it twice — the property the offline queue depends on and the one a
 *     browser cannot easily test;
 *   · an executive cannot touch another executive's pickup;
 *   · the shipment's own event log tells the story and projects back to the
 *     status that is stored;
 *   · a pickup raised by hand — the consignor who telephones, which had a
 *     validated action and no caller anywhere in the product — is raised
 *     from what the dialog actually posts, lands on the day the desk is
 *     looking at, and runs to collection with no consignment behind it; and
 *   · a cancelled pickup keeps the branch's notes, leaves the executive's
 *     run, cannot be completed afterwards by a phone that still holds it,
 *     and tells its consignment.
 *
 * It calls the services the screens call. Like `verify-field-cycle.ts` it
 * books its own consignment and leaves everything behind: the event log is
 * append-only, so a run that tidied up after itself would be deleting the
 * evidence it just produced.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { basePrisma, prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor, type TenantContext } from "../src/lib/tenant";
import type { SessionUser } from "../src/lib/auth/session";
import { createBooking } from "../src/lib/shipment/booking";
import { appendShipmentEvent, replayStatus } from "../src/lib/shipment/events";
import {
  recordPickupCollected,
  recordPickupFailed,
  startPickup,
} from "../src/lib/pickup/execute";
import {
  pickupRequestSchema,
  raisePickupRequest,
} from "../src/lib/pickup/request";
import { cancelPickupRequest } from "../src/lib/pickup/cancel";
import { nextNumber } from "../src/lib/numbering/number-series";

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function actingTenant(): Promise<TenantContext> {
  const subdomain = process.argv[2] ?? "city-logistics";
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain }, { slug: subdomain }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${subdomain}" is closed.`);
  return tenant;
}

async function loadActor(mobile: string): Promise<SessionUser> {
  const user = await prisma.user.findFirstOrThrow({
    where: { mobile },
    include: {
      primaryBranch: { select: { id: true, code: true, name: true } },
      roles: {
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      },
    },
  });

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
    roles: user.roles.map((r) => ({ code: r.role.code, name: r.role.name, scope: r.role.scope })),
    permissions,
    scope: widest,
    branchIds: widest === "NETWORK" ? null : user.primaryBranch ? [user.primaryBranch.id] : [],
  };
}

function field() {
  return {
    idempotencyKey: randomUUID(),
    occurredAt: new Date(),
    latitude: 28.4595,
    longitude: 77.0266,
    deviceId: "verify-pickup-cycle",
  };
}

async function run() {
  const admin = await loadActor(process.env.SMOKE_ADMIN_MOBILE ?? "9999999999");

  const executive = await prisma.user.findFirst({
    where: {
      isFieldUser: true,
      status: "ACTIVE",
      roles: { some: { role: { code: "PICKUP_EXEC" } } },
    },
    select: { mobile: true, name: true, primaryBranchId: true },
  });

  if (!executive?.primaryBranchId) {
    check(
      "a pickup executive with a home branch exists",
      false,
      "no active PICKUP_EXEC with a primary branch — seed the demo users first",
    );
    return;
  }

  const agent = await loadActor(executive.mobile);
  const branch = await prisma.branch.findUniqueOrThrow({
    where: { id: executive.primaryBranchId },
    select: { id: true, code: true },
  });

  console.log(`  executive ${agent.name} (${agent.mobile}) at ${branch.code}\n`);

  check(
    "the executive may run a pickup",
    agent.permissions.has("pickup.execute"),
    agent.permissions.has("pickup.execute") ? "" : "PICKUP_EXEC does not hold pickup.execute",
  );
  check(
    "and may not assign work to themselves",
    !agent.permissions.has("pickup.assign"),
  );

  // ── A consignment waiting to be collected ─────────────────
  console.log("\nA consignment to collect");

  const [destination, service, packageType, gurugram, jaipur] = await Promise.all([
    prisma.branch.findFirstOrThrow({
      where: { isActive: true, id: { not: branch.id } },
      orderBy: { code: "asc" },
    }),
    prisma.serviceType.findFirstOrThrow({ where: { code: "PTL-EXP" } }),
    prisma.packageType.findFirstOrThrow({ where: { code: "CARTON" } }),
    prisma.city.findFirstOrThrow({ where: { code: "GGN" } }),
    prisma.city.findFirstOrThrow({ where: { code: "JAI" } }),
  ]);

  const booking = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: service.id,
      bookingBranchId: branch.id,
      originBranchId: branch.id,
      destinationBranchId: destination.id,

      consignorName: "Verify Pickup Consignor",
      consignorPhone: "9800000011",
      consignorAddress: "Plot 4, Sector 18",
      consignorCityId: gurugram.id,
      consignorPincode: "122015",

      consigneeName: "Verify Pickup Consignee",
      consigneePhone: "9800000012",
      consigneeAddress: "12 Station Road",
      consigneeCityId: jaipur.id,
      consigneePincode: "302013",

      packageCount: 6,
      packageTypeId: packageType.id,
      actualWeight: 30,
      goodsDescription: "Pickup verification — auto-generated",
      declaredValue: 12000,
      packages: [
        { lengthCm: 40, breadthCm: 40, heightCm: 30 },
        { lengthCm: 40, breadthCm: 40, heightCm: 30 },
        { lengthCm: 30, breadthCm: 30, heightCm: 20 },
        { lengthCm: 30, breadthCm: 30, heightCm: 20 },
        { lengthCm: 20, breadthCm: 20, heightCm: 20 },
        { lengthCm: 20, breadthCm: 20, heightCm: 20 },
      ],
      paymentType: "PAID",
      pickupRequired: true,
    },
    admin,
  );

  if (!booking.ok) {
    check("a consignment was booked", false, booking.error);
    return;
  }
  check("a consignment was booked", true, booking.lrNumber);

  // ── Raised and assigned ───────────────────────────────────
  console.log("\nRaised and assigned");

  const request = await prisma.pickupRequest.create({
    data: {
      orgId: admin.orgId,
      number: await nextNumber({ document: "PICKUP" }),
      branchId: branch.id,
      shipmentId: booking.shipmentId,
      customerId: (await prisma.customer.findFirstOrThrow({ select: { id: true } })).id,
      contactName: "Verify Pickup Consignor",
      phone: "9800000011",
      address: "Plot 4, Sector 18",
      cityId: (await prisma.city.findFirstOrThrow({ select: { id: true } })).id,
      pincode: "122001",
      requestedDate: new Date(),
      slot: "MORNING",
      expectedPackages: 6,
      createdById: admin.id,
    },
  });
  check("a pickup was raised", Boolean(request.number), request.number);

  const assignment = await prisma.pickupAssignment.create({
    data: {
      orgId: admin.orgId,
      pickupRequestId: request.id,
      assignedToId: agent.id,
      assignedById: admin.id,
    },
  });
  await prisma.pickupRequest.update({
    where: { id: request.id },
    data: { status: "ASSIGNED" },
  });

  // The same event `assignPickup` raises. Without it the shipment is still
  // BOOKED, and the state machine refuses PICKUP_ATTEMPTED from there — the
  // attempt below would be silently dropped and this script would be
  // testing nothing.
  await appendShipmentEvent(
    {
      shipmentId: booking.shipmentId,
      eventType: "PICKUP_ASSIGNED",
      branchId: branch.id,
      payload: { pickupNumber: request.number, assignedToId: agent.id },
    },
    admin,
  );

  check("and assigned to the executive", Boolean(assignment.id));

  // ── On the way ────────────────────────────────────────────
  console.log("\nOn the way");

  const started = await startPickup({ assignmentId: assignment.id }, agent);
  check("starting the run is accepted", started.ok, started.ok ? "" : started.error);

  const afterStart = await prisma.pickupRequest.findUniqueOrThrow({
    where: { id: request.id },
    select: { status: true },
  });
  check("the request reads as in progress", afterStart.status === "IN_PROGRESS", afterStart.status);

  // ── Nobody there ──────────────────────────────────────────
  console.log("\nNobody there");

  const closed = await prisma.reasonCode.findFirstOrThrow({
    where: { code: "PF-CLOSED" },
    select: { id: true },
  });

  const failedKey = field();
  const failed = await recordPickupFailed(
    {
      assignmentId: assignment.id,
      reasonCodeId: closed.id,
      remarks: "Shutter down",
      ...failedKey,
    },
    agent,
  );
  check("a failed attempt is accepted", failed.ok, failed.ok ? "" : failed.error);
  check(
    "and is the first attempt",
    failed.ok && failed.attemptNumber === 1,
    failed.ok ? `attempt ${failed.attemptNumber}` : "",
  );

  const afterFail = await prisma.pickupRequest.findUniqueOrThrow({
    where: { id: request.id },
    select: { status: true, requestedDate: true },
  });
  check(
    "the pickup returns to the executive rather than being written off",
    afterFail.status === "ASSIGNED",
    afterFail.status,
  );
  check(
    "and is scheduled for the next day",
    afterFail.requestedDate > request.requestedDate,
    afterFail.requestedDate.toDateString(),
  );

  const replayFail = await recordPickupFailed(
    {
      assignmentId: assignment.id,
      reasonCodeId: closed.id,
      remarks: "Shutter down",
      ...failedKey,
    },
    agent,
  );
  check(
    "replaying that attempt records nothing new",
    replayFail.ok && replayFail.alreadyRecorded === true,
    replayFail.ok ? `attempt ${replayFail.attemptNumber}` : replayFail.error,
  );

  // ── Somebody else's stop ──────────────────────────────────
  console.log("\nSomebody else's stop");

  const other = await prisma.user.findFirst({
    where: {
      isFieldUser: true,
      status: "ACTIVE",
      id: { not: agent.id },
      roles: { some: { role: { code: "DELIVERY_AGENT" } } },
    },
    select: { mobile: true },
  });

  if (!other) {
    console.log("  [SKIP] no second field user to try it with");
  } else {
    const intruder = await loadActor(other.mobile);
    const stolen = await recordPickupCollected(
      { assignmentId: assignment.id, packagesCollected: 6, ...field() },
      intruder,
    );
    check(
      "another agent cannot complete this pickup",
      !stolen.ok,
      stolen.ok ? "IT WAS ALLOWED" : stolen.error,
    );
  }

  // ── Collected, and short ──────────────────────────────────
  console.log("\nCollected");

  const collected = await recordPickupCollected(
    {
      assignmentId: assignment.id,
      packagesCollected: 5,
      weightCollected: 26.5,
      receiverName: "Verify Pickup Consignor",
      ...field(),
    },
    agent,
  );
  check("the collection is accepted", collected.ok, collected.ok ? "" : collected.error);
  check(
    "and is the second attempt, the first still standing",
    collected.ok && collected.attemptNumber === 2,
    collected.ok ? `attempt ${collected.attemptNumber}` : "",
  );

  const attempts = await prisma.pickupAttempt.findMany({
    where: { assignmentId: assignment.id },
    orderBy: { attemptNumber: "asc" },
    select: { attemptNumber: true, outcome: true, packagesCollected: true },
  });
  check(
    "both visits are on the record",
    attempts.length === 2 &&
      attempts[0].outcome === "FAILED" &&
      attempts[1].outcome === "COLLECTED",
    attempts.map((a) => `${a.attemptNumber}:${a.outcome}`).join(" "),
  );
  check(
    "the shortfall is recorded as counted, not as booked",
    attempts[1]?.packagesCollected === 5 && request.expectedPackages === 6,
    `collected ${attempts[1]?.packagesCollected} of ${request.expectedPackages}`,
  );

  const done = await prisma.pickupRequest.findUniqueOrThrow({
    where: { id: request.id },
    select: { status: true },
  });
  check("the request is complete", done.status === "COMPLETED", done.status);

  // ── The story the shipment tells ──────────────────────────
  console.log("\nThe event log");

  const events = await prisma.shipmentEvent.findMany({
    where: { shipmentId: booking.shipmentId },
    orderBy: { occurredAt: "asc" },
    select: { eventType: true },
  });
  const types = events.map((e) => e.eventType);

  check(
    "the attempt was recorded without claiming a collection",
    types.includes("PICKUP_ATTEMPTED"),
    types.join(", "),
  );
  check("the collection was recorded", types.includes("PICKUP_COMPLETED"));

  const replay = await replayStatus(booking.shipmentId);
  check(
    "the stored status is what the log projects to",
    replay.matches,
    `${replay.replayed} vs ${replay.stored}`,
  );

  // ── The consignor who telephones ──────────────────────────
  //
  // Everything above starts from a booking. The third way a pickup comes
  // into existence — somebody rings the branch and asks for a collection —
  // had a validated server action and no caller anywhere in the product,
  // so nothing here or on any screen had ever raised one.
  //
  // This posts what the create dialog posts, as strings, through the same
  // schema the action parses with: if the two ever drift, this is where it
  // shows.
  console.log("\nRaised by hand");

  const posted = {
    shipmentId: "",
    customerId: "",
    branchId: branch.id,
    contactName: "Telephoned Consignor",
    phone: "9800000013",
    address: "Shop 7, Old Market",
    cityId: gurugram.id,
    pincode: "122001",
    landmark: "Opposite the bank",
    requestedDate: todayValue(),
    slot: "AFTERNOON",
    priority: "0",
    expectedPackages: "2",
    expectedWeight: "8.5",
    goodsDescription: "Two cartons of spares",
    notes: "Gate code 4821 — ask for the store manager",
  };

  const parsed = pickupRequestSchema.safeParse(posted);
  check(
    "what the dialog posts is what the action accepts",
    parsed.success,
    parsed.success ? "" : JSON.stringify(parsed.error.issues.map((i) => i.path)),
  );
  if (!parsed.success) return;

  const byHand = await raisePickupRequest(parsed.data, admin);
  check(
    "a pickup is raised by hand",
    byHand.ok,
    byHand.ok ? byHand.number : byHand.error,
  );
  if (!byHand.ok) return;

  const blind = await prisma.pickupRequest.findUniqueOrThrow({
    where: { id: byHand.id },
    select: { shipmentId: true, requestedDate: true, notes: true },
  });
  check(
    "it carries no consignment — nothing is booked yet",
    blind.shipmentId === null,
    blind.shipmentId ?? "null",
  );

  // Asked for the way `/pickups` asks for it, because this is where the
  // `date` column bites. Prisma narrows a filter on a `@db.Date` field to
  // the UTC calendar day of whatever it is given, so a window built from
  // local midnight at +5:30 asks for yesterday: the desk was querying
  // `>= 30 August AND < 31 August` while meaning the 31st, and every pickup
  // raised for today was invisible until the following morning.
  const [dayStart, dayEnd] = deskWindow();
  const onTheDesk = await prisma.pickupRequest.findFirst({
    where: { id: byHand.id, requestedDate: { gte: dayStart, lt: dayEnd } },
    select: { id: true },
  });
  check(
    "and lands on the day the desk is looking at",
    onTheDesk !== null,
    `${blind.requestedDate.toISOString()} in [${dayStart.toISOString()}, ${dayEnd.toISOString()})`,
  );

  // It has no shipment to lean on, so every step below is the pickup
  // module standing on its own.
  const blindAssignment = await prisma.pickupAssignment.create({
    data: {
      orgId: admin.orgId,
      pickupRequestId: byHand.id,
      assignedToId: agent.id,
      assignedById: admin.id,
    },
  });
  await prisma.pickupRequest.update({
    where: { id: byHand.id },
    data: { status: "ASSIGNED" },
  });

  const blindCollected = await recordPickupCollected(
    {
      assignmentId: blindAssignment.id,
      packagesCollected: 2,
      weightCollected: 8.5,
      receiverName: "Telephoned Consignor",
      ...field(),
    },
    agent,
  );
  check(
    "a pickup with no consignment behind it still runs to collection",
    blindCollected.ok,
    blindCollected.ok ? "" : blindCollected.error,
  );

  // ── Called off ────────────────────────────────────────────
  console.log("\nCalled off");

  const second = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: service.id,
      bookingBranchId: branch.id,
      originBranchId: branch.id,
      destinationBranchId: destination.id,

      consignorName: "Verify Cancel Consignor",
      consignorPhone: "9800000014",
      consignorAddress: "Plot 9, Sector 18",
      consignorCityId: gurugram.id,
      consignorPincode: "122015",

      consigneeName: "Verify Cancel Consignee",
      consigneePhone: "9800000015",
      consigneeAddress: "44 Station Road",
      consigneeCityId: jaipur.id,
      consigneePincode: "302013",

      packageCount: 2,
      packageTypeId: packageType.id,
      actualWeight: 10,
      goodsDescription: "Cancellation verification — auto-generated",
      declaredValue: 4000,
      packages: [
        { lengthCm: 30, breadthCm: 30, heightCm: 20 },
        { lengthCm: 30, breadthCm: 30, heightCm: 20 },
      ],
      paymentType: "PAID",
      pickupRequired: true,
    },
    admin,
  );

  if (!second.ok) {
    check("a second consignment was booked", false, second.error);
    return;
  }

  const branchNote = "Loading bay at the rear — the front shutter is welded";
  const raised = await raisePickupRequest(
    {
      ...parsed.data,
      shipmentId: second.shipmentId,
      contactName: "Verify Cancel Consignor",
      phone: "9800000014",
      notes: branchNote,
    },
    admin,
  );
  if (!raised.ok) {
    check("a pickup was raised against it", false, raised.error);
    return;
  }

  const doomed = await prisma.pickupAssignment.create({
    data: {
      orgId: admin.orgId,
      pickupRequestId: raised.id,
      assignedToId: agent.id,
      assignedById: admin.id,
    },
  });
  await prisma.pickupRequest.update({
    where: { id: raised.id },
    data: { status: "ASSIGNED" },
  });
  await appendShipmentEvent(
    {
      shipmentId: second.shipmentId,
      eventType: "PICKUP_ASSIGNED",
      branchId: branch.id,
      payload: { pickupNumber: raised.number, assignedToId: agent.id },
    },
    admin,
  );

  const reason = "Consignor postponed to next week";
  const cancelled = await cancelPickupRequest(
    { pickupRequestId: raised.id, reason },
    admin,
  );
  check(
    "the cancellation is accepted",
    cancelled.ok,
    cancelled.ok ? raised.number : cancelled.error,
  );

  const afterCancel = await prisma.pickupRequest.findUniqueOrThrow({
    where: { id: raised.id },
    select: { status: true, notes: true, cancelReason: true, cancelledById: true },
  });

  // The bug this replaces wrote the reason into `notes`, over the top of
  // whatever the branch had put there for the executive.
  check(
    "the branch's own notes survive it",
    afterCancel.notes === branchNote,
    afterCancel.notes ?? "null",
  );
  check(
    "and the reason is kept in its own column, against whoever gave it",
    afterCancel.cancelReason === reason && afterCancel.cancelledById === admin.id,
    afterCancel.cancelReason ?? "null",
  );

  // The executive's day list, spelled the way `(field)/pickups/today`
  // spells it. A cancelled pickup that stayed on it is somebody driving to
  // a door for nothing.
  const stillOnTheRun = await prisma.pickupAssignment.findMany({
    where: {
      supersededAt: null,
      status: { in: ["ASSIGNED", "IN_PROGRESS"] },
      assignedToId: agent.id,
      request: { status: { notIn: ["CANCELLED", "COMPLETED"] } },
      pickupRequestId: raised.id,
    },
    select: { id: true },
  });
  check(
    "the stop leaves the executive's run",
    stillOnTheRun.length === 0,
    `${stillOnTheRun.length} still assigned`,
  );

  const superseded = await prisma.pickupAssignment.findUniqueOrThrow({
    where: { id: doomed.id },
    select: { supersededAt: true, status: true },
  });
  check(
    "the assignment is superseded rather than deleted — who was sent survives",
    superseded.supersededAt !== null && superseded.status === "CANCELLED",
    `${superseded.status} at ${superseded.supersededAt?.toISOString() ?? "null"}`,
  );

  // The offline queue replays. A phone holding this stop must not be able
  // to post a collection against a pickup the branch called off.
  const zombie = await recordPickupCollected(
    { assignmentId: doomed.id, packagesCollected: 2, ...field() },
    agent,
  );
  check(
    "and a stale phone cannot complete it after the fact",
    !zombie.ok,
    zombie.ok ? "IT WAS ALLOWED" : zombie.error,
  );

  // There is no PICKUP_CANCELLED in the state machine and no rule that
  // takes a consignment back out of PICKUP_ASSIGNED, so this is
  // BOOKING_AMENDED: recorded, status untouched. The consignment reads as
  // still assigned, which is honest about the log but not about the world —
  // see the note in `lib/pickup/cancel.ts`.
  const cancelEvents = await prisma.shipmentEvent.findMany({
    where: { shipmentId: second.shipmentId },
    orderBy: { occurredAt: "asc" },
    select: { eventType: true, payload: true },
  });
  const told = cancelEvents.some(
    (e) =>
      e.eventType === "BOOKING_AMENDED" &&
      (e.payload as { pickupCancelled?: boolean } | null)?.pickupCancelled === true,
  );
  check(
    "the consignment is told the collection was called off",
    told,
    cancelEvents.map((e) => e.eventType).join(", "),
  );

  const cancelReplay = await replayStatus(second.shipmentId);
  check(
    "and it is left where its own log says it is",
    cancelReplay.matches && cancelReplay.stored === "PICKUP_ASSIGNED",
    `${cancelReplay.replayed} vs ${cancelReplay.stored}`,
  );
}

/** Today, as an `<input type="date">` spells it. */
function todayValue(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** The window `/pickups` builds for "today" — the UTC calendar day. */
function deskWindow(): [Date, Date] {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0),
  );
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return [start, end];
}

async function main() {
  const tenant = await actingTenant();
  console.log(`\nPickup cycle — ${tenant.slug}\n`);
  await runWithTenant(tenant, () => run());
  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "PASS\n" : "FAIL\n");
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("\nThe pickup cycle could not run:\n", error);
  await prisma.$disconnect();
  process.exit(1);
});
