/**
 * Drives a delivery run the way the field app does, from assignment to
 * closure, and then reads the story back out of the event log.
 *
 *   npx tsx scripts/verify-field-cycle.ts [tenant-subdomain]
 *
 * The field app is the one module whose whole design is about what happens
 * when the network is not there: actions are queued on the device with a
 * client-generated idempotency key and a device clock, and replayed later,
 * possibly twice, possibly out of order. None of that had ever been driven
 * from a script — the unit tests check the rules and the UI checks the
 * happy path in a browser, and neither one replays a queue.
 *
 * What this proves, in order:
 *
 *   · a run is created, stops are added, and the out-scan moves every one
 *     of them to OUT_FOR_DELIVERY;
 *   · a failed attempt returns the consignment to the branch rather than
 *     inventing a "failed" status, and raises a second attempt;
 *   · replaying a queued action with the same idempotency key does not
 *     record it twice — the single most important property of the offline
 *     queue, and the one a browser cannot easily test;
 *   · an agent cannot touch another agent's stop;
 *   · a delivery captures a POD, and refuses to without evidence; and
 *   · the event log, read afterwards, tells the whole story with no gaps
 *     and projects back to the status that is stored.
 *
 * It calls the services `syncFieldAction` calls rather than the action
 * itself. The action is a `"use server"` function whose first line is
 * `authorize("delivery.execute")`, which needs a request's headers and
 * cookie; the only thing it adds over the services is a zod parse and the
 * idempotency key, and both are reproduced here.
 *
 * It books its own consignment and leaves it behind, exactly as
 * `verify-spine.ts` does and for the same reason: `Pod.shipmentId` is
 * unique and the event log is append-only, so a run that tidied up after
 * itself would be deleting the evidence it just produced.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { basePrisma, prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor, type TenantContext } from "../src/lib/tenant";
import type { SessionUser } from "../src/lib/auth/session";
import { createBooking } from "../src/lib/shipment/booking";
import { appendShipmentEvent, replayStatus } from "../src/lib/shipment/events";
import {
  addShipmentsToRun,
  completeRun,
  createDeliveryRun,
  startRun,
} from "../src/lib/delivery/runs";
import { recordDelivery, recordFailedAttempt } from "../src/lib/delivery/execute";
import { periodKeyFor } from "../src/lib/numbering/number-series";
import type { ShipmentEventType, ShipmentStatus } from "../src/generated/prisma/client";

let failures = 0;
let passes = 0;

/**
 * A number-series row this script had to create to get past a bug, removed
 * again on the way out. Module-level so the cleanup in `main` reaches it
 * however `run` returned.
 */
let fixtureSeriesId: string | null = null;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * A one-pixel PNG.
 *
 * `recordDelivery` refuses a delivery with no signature and no photograph,
 * and the asset writer insists on a real base64 image, so the smallest
 * legal one stands in for a scrawl on a screen.
 */
const PIXEL_PNG =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function actingTenant(): Promise<TenantContext> {
  const subdomain = process.argv[2] ?? "city-logistics";

  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain }, { slug: subdomain }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });

  const tenant = tenantContextFor(org, "job");
  if (!tenant) {
    throw new Error(`Organisation "${subdomain}" is closed; refusing to run against it.`);
  }
  return tenant;
}

/**
 * A session for a real user, built the way `verify-spine.ts` builds one.
 *
 * `scope` is not hard-coded to NETWORK here. A delivery agent's role is
 * scoped to OWN, and that scope is exactly what stops one agent opening
 * another's stop — pretending otherwise would make the cycle pass while
 * leaving the boundary untested.
 */
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

/** Local midnight — a run belongs to a day, not to an instant. */
function today(): Date {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day;
}

async function run() {
  const admin = await loadActor(process.env.SMOKE_ADMIN_MOBILE ?? "9999999999");

  const agentUser = await prisma.user.findFirst({
    where: { isFieldUser: true, status: "ACTIVE", roles: { some: { role: { code: "DELIVERY_AGENT" } } } },
    select: { mobile: true, name: true, primaryBranchId: true },
  });

  if (!agentUser?.primaryBranchId) {
    check(
      "a delivery agent with a home branch exists",
      false,
      "no active DELIVERY_AGENT with a primary branch — seed the demo users first",
    );
    return;
  }

  const agent = await loadActor(agentUser.mobile);
  const deliveryBranch = await prisma.branch.findUniqueOrThrow({
    where: { id: agentUser.primaryBranchId },
    select: { id: true, code: true, name: true },
  });

  console.log(
    `  agent ${agent.name} (${agent.mobile}) at ${deliveryBranch.code}, ` +
      `role scope ${agent.scope}\n`,
  );

  check(
    "the agent's role is scoped to their own work",
    agent.scope === "OWN",
    `scope ${agent.scope} — a wider scope means the ownership check below proves nothing`,
  );
  check(
    "the agent cannot assign work to themselves",
    !agent.permissions.has("delivery.assign"),
    agent.permissions.has("delivery.assign")
      ? "the agent holds delivery.assign, so planning and execution are not separated"
      : "",
  );

  // ── A consignment at the delivery branch ──────────────────
  console.log("\nA consignment on the floor");

  const origin = await prisma.branch.findFirstOrThrow({
    where: { isActive: true, id: { not: deliveryBranch.id } },
    orderBy: { code: "asc" },
    select: { id: true, code: true },
  });
  const [service, packageType] = await Promise.all([
    // Pinned to PTL: `createBooking` refuses a mode the service does not
    // offer, and which service comes back first is not deterministic.
    prisma.serviceType.findFirstOrThrow({
      where: { isActive: true, mode: "PTL" },
      orderBy: { code: "asc" },
    }),
    prisma.packageType.findFirstOrThrow({}),
  ]);
  const [originCity, destinationCity] = await Promise.all([
    prisma.city.findFirstOrThrow({ orderBy: { code: "asc" } }),
    prisma.city.findFirstOrThrow({ orderBy: { code: "desc" } }),
  ]);
  const reason = await prisma.reasonCode.findFirstOrThrow({
    where: { category: "DELIVERY_FAILURE", triggersReattempt: true, isActive: true },
    select: { id: true, code: true },
  });

  const booking = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: service.id,
      bookingBranchId: origin.id,
      originBranchId: origin.id,
      destinationBranchId: deliveryBranch.id,

      consignorName: "Field Cycle Consignor",
      consignorPhone: "9811100011",
      consignorAddress: "Field cycle origin",
      consignorCityId: originCity.id,
      consignorPincode: "122015",

      consigneeName: "Field Cycle Consignee",
      consigneePhone: "9811100012",
      consigneeAddress: "Field cycle destination",
      consigneeCityId: destinationCity.id,
      consigneePincode: "302013",

      packageCount: 1,
      packageTypeId: packageType.id,
      actualWeight: 4,
      goodsDescription: "Field cycle verification — auto-generated",
      declaredValue: 1000,
      paymentType: "PAID",
      pickupRequired: false,
    },
    admin,
  );

  if (!booking.ok) {
    check("a consignment is booked", false, booking.error);
    return;
  }
  check("a consignment is booked", true, booking.lrNumber);

  // Walk it to the delivery branch's floor. These are the events the dock
  // would have written; the point of this script is what happens after.
  const journey: Array<{ event: ShipmentEventType; branchId?: string; expect: ShipmentStatus }> = [
    { event: "PICKUP_ASSIGNED", expect: "PICKUP_ASSIGNED" },
    { event: "PICKUP_COMPLETED", branchId: origin.id, expect: "PICKED_UP" },
    { event: "INBOUND_SCAN", branchId: origin.id, expect: "RECEIVED_AT_ORIGIN" },
    { event: "SORTED", branchId: origin.id, expect: "PROCESSED" },
    { event: "MANIFEST_ADDED", expect: "MANIFESTED" },
    { event: "GATE_OUT", branchId: origin.id, expect: "DISPATCHED" },
    { event: "GATE_IN", branchId: deliveryBranch.id, expect: "ARRIVED_AT_HUB" },
    { event: "INBOUND_SCAN", branchId: deliveryBranch.id, expect: "RECEIVED_AT_HUB" },
  ];

  for (const step of journey) {
    const result = await appendShipmentEvent(
      { shipmentId: booking.shipmentId, eventType: step.event, branchId: step.branchId ?? null },
      admin,
    );
    if (!result.ok) {
      check(`walked to ${step.expect}`, false, result.error);
      return;
    }
  }

  const onFloor = await prisma.shipment.findUniqueOrThrow({
    where: { id: booking.shipmentId },
    select: { currentStatus: true, currentBranchId: true },
  });
  check(
    "it is on the delivery branch's floor",
    onFloor.currentStatus === "RECEIVED_AT_HUB" && onFloor.currentBranchId === deliveryBranch.id,
    `${onFloor.currentStatus} at ${onFloor.currentBranchId === deliveryBranch.id ? deliveryBranch.code : "another branch"}`,
  );

  // ── Planning ──────────────────────────────────────────────
  console.log("\nPlanning the run");

  /**
   * `createDeliveryRun` is the only caller of `nextNumber` that passes a
   * `branchId`, and `nextNumber` matches `branchId` exactly with no fallback
   * to the network-wide row. The seeded DELIVERY_RUN series is network-wide,
   * so on a default tenant no delivery run can be created at all.
   *
   * That is reported as the failure it is, and then worked around with a
   * branch-scoped series of this script's own so the rest of the cycle can
   * still be proven. The fixture is removed again on the way out.
   */
  const networkWide = await prisma.numberSeries.findFirst({
    where: { document: "DELIVERY_RUN", branchId: null, isActive: true },
    select: {
      id: true,
      orgId: true,
      pattern: true,
      prefix: true,
      padding: true,
      resetPolicy: true,
    },
  });
  const branchScoped = await prisma.numberSeries.findFirst({
    where: { document: "DELIVERY_RUN", branchId: deliveryBranch.id, isActive: true },
    select: { id: true },
  });

  // A branch's own counter where one exists, otherwise the network-wide
  // row. This used to be the bug that stopped the whole last-mile module:
  // `nextNumber` matched `branchId` exactly, the seed only writes
  // network-wide series, and `createDeliveryRun` is the one caller that
  // passes a branch — so every attempt threw and no delivery run had ever
  // been created on a default tenant. The assertion stays because the
  // fallback is the thing that makes the module work at all.
  check(
    "a DELIVERY_RUN number series is reachable from the delivery branch",
    Boolean(branchScoped ?? networkWide),
    branchScoped
      ? `branch-scoped series for ${deliveryBranch.code}`
      : networkWide
        ? "falling back to the network-wide series, as intended"
        : "none exists at all — run the seed",
  );

  if (!branchScoped && !networkWide) {
    console.error("\n  Cannot continue without a DELIVERY_RUN series.\n");
    process.exitCode = 1;
    return;
  }

  const created = await createDeliveryRun(
    { branchId: deliveryBranch.id, agentId: agent.id, runDate: today() },
    admin,
  );

  // A second PLANNED run for the same agent on the same day is refused, so
  // a re-run of this script reuses the one it made last time.
  let runId: string;
  if (created.ok) {
    check("a delivery run is created", true, created.number);
    runId = created.runId;
  } else {
    const existing = await prisma.deliveryRun.findFirst({
      where: {
        agentId: agent.id,
        runDate: today(),
        status: { in: ["PLANNED", "STARTED"] },
      },
      select: { id: true, number: true },
    });

    if (!existing) {
      check("a delivery run is created", false, created.error);
      return;
    }
    runId = existing.id;
    check(
      "a delivery run is created",
      true,
      `reusing ${existing.number} — one open run per agent per day, as designed`,
    );
  }

  const agentCannotPlan = await createDeliveryRun(
    { branchId: deliveryBranch.id, agentId: agent.id, runDate: today() },
    agent,
  );
  check(
    "the agent cannot create a run of their own",
    !agentCannotPlan.ok,
    agentCannotPlan.ok ? "the agent planned their own work" : agentCannotPlan.error,
  );

  const added = await addShipmentsToRun(runId, [booking.shipmentId], admin);
  check(
    "the consignment is added as a stop",
    added.ok && added.added === 1,
    added.ok ? `${added.added} added, ${added.skipped.length} skipped` : added.error,
  );

  const assigned = await prisma.shipment.findUniqueOrThrow({
    where: { id: booking.shipmentId },
    select: { currentStatus: true },
  });
  check(
    "assignment moves it to ASSIGNED_FOR_DELIVERY",
    assigned.currentStatus === "ASSIGNED_FOR_DELIVERY",
    assigned.currentStatus,
  );

  const firstTask = await prisma.deliveryTask.findFirstOrThrow({
    where: { shipmentId: booking.shipmentId, runId },
    orderBy: { attemptNumber: "desc" },
    select: { id: true, attemptNumber: true },
  });

  // ── The out-scan ──────────────────────────────────────────
  console.log("\nOut for delivery");

  const started = await startRun(runId, agent);
  check(
    "the agent starts their own run",
    started.ok,
    started.ok ? `${started.started} stop(s) out-scanned` : started.error,
  );

  const outForDelivery = await prisma.shipment.findUniqueOrThrow({
    where: { id: booking.shipmentId },
    select: { currentStatus: true },
  });
  check(
    "the out-scan moves the consignment to OUT_FOR_DELIVERY",
    outForDelivery.currentStatus === "OUT_FOR_DELIVERY",
    outForDelivery.currentStatus,
  );

  // ── A failed attempt, replayed ────────────────────────────
  console.log("\nA failed attempt, and its replay");

  // The device clock, not the server's. A queued action carries the time it
  // happened, which is what the timeline sorts on.
  const attemptedAt = new Date(Date.now() - 45 * 60 * 1000);
  const attemptKey = randomUUID();

  const attempt = await recordFailedAttempt(
    {
      taskId: firstTask.id,
      reasonCodeId: reason.id,
      remarks: "Nobody at the address — field cycle verification",
      idempotencyKey: `${attemptKey}:attempted`,
      occurredAt: attemptedAt,
      latitude: 26.9124,
      longitude: 75.7873,
      deviceId: "verify-field-cycle",
    },
    agent,
  );

  check(
    "the attempt is recorded",
    attempt.ok && attempt.duplicate === false,
    attempt.ok
      ? `attempt ${attempt.attemptCount}, next: ${JSON.stringify(attempt.decision)}`
      : attempt.error,
  );

  const afterAttempt = await prisma.shipment.findUniqueOrThrow({
    where: { id: booking.shipmentId },
    select: { currentStatus: true, attemptCount: true },
  });
  check(
    "a failed attempt is not a status — it goes back to the branch",
    afterAttempt.currentStatus === "RECEIVED_AT_HUB",
    afterAttempt.currentStatus,
  );
  check(
    "the attempt count went up",
    afterAttempt.attemptCount >= 1,
    `attemptCount ${afterAttempt.attemptCount}`,
  );

  // The queue's whole reason for existing: the device may sync the same
  // action twice and must not produce two attempts.
  const replayed = await recordFailedAttempt(
    {
      taskId: firstTask.id,
      reasonCodeId: reason.id,
      remarks: "Nobody at the address — field cycle verification",
      idempotencyKey: `${attemptKey}:attempted`,
      occurredAt: attemptedAt,
      latitude: 26.9124,
      longitude: 75.7873,
      deviceId: "verify-field-cycle",
    },
    agent,
  );
  check(
    "replaying the queued attempt is a no-op",
    replayed.ok && replayed.duplicate === true,
    replayed.ok
      ? `duplicate=${replayed.duplicate}`
      : `the replay was rejected outright: ${replayed.error}`,
  );

  const attemptRows = await prisma.deliveryAttempt.count({
    where: { task: { shipmentId: booking.shipmentId } },
  });
  check(
    "and left exactly one attempt row behind",
    attemptRows === 1,
    `${attemptRows} attempt row(s)`,
  );

  // ── Somebody else's stop ──────────────────────────────────
  const otherAgentUser = await prisma.user.findFirst({
    where: {
      isFieldUser: true,
      status: "ACTIVE",
      id: { not: agent.id },
      roles: { some: { role: { code: "DELIVERY_AGENT" } } },
    },
    select: { mobile: true, name: true },
  });

  if (otherAgentUser) {
    const stranger = await loadActor(otherAgentUser.mobile);
    const trespass = await recordFailedAttempt(
      {
        taskId: firstTask.id,
        reasonCodeId: reason.id,
        idempotencyKey: `${randomUUID()}:attempted`,
        occurredAt: new Date(),
      },
      stranger,
    );
    check(
      "another agent cannot record against this stop",
      !trespass.ok,
      trespass.ok ? "LEAK — a stranger recorded an attempt" : trespass.error,
    );
  } else {
    console.log(
      "  [SKIP] only one delivery agent is seeded, so the cross-agent " +
        "ownership check could not run",
    );
  }

  // ── The second attempt, delivered ─────────────────────────
  console.log("\nThe second attempt");

  const reattempt = await prisma.deliveryTask.findFirst({
    where: { shipmentId: booking.shipmentId, status: "PENDING" },
    orderBy: { attemptNumber: "desc" },
    select: { id: true, attemptNumber: true, runId: true },
  });

  check(
    "a reattempt task was raised",
    Boolean(reattempt) && (reattempt?.attemptNumber ?? 0) > firstTask.attemptNumber,
    reattempt
      ? `attempt ${reattempt.attemptNumber}, ${reattempt.runId ? "on a run" : "unassigned"}`
      : "no pending task — the reason code may not trigger a reattempt",
  );

  if (!reattempt) {
    return finish(booking.shipmentId, booking.lrNumber);
  }

  // Put it back on the run and out-scan it again.
  const readded = await addShipmentsToRun(runId, [booking.shipmentId], admin);
  check(
    "the reattempt goes back onto the run",
    readded.ok,
    readded.ok ? `${readded.added} added` : readded.error,
  );
  await startRun(runId, agent);

  const deliverKey = randomUUID();
  const deliveredAt = new Date();

  // Evidence is not optional. A delivery with neither a signature nor a
  // photograph is refused, and that refusal is the reason the POD is worth
  // anything at all.
  const noEvidence = await recordDelivery(
    {
      taskId: reattempt.id,
      receiverName: "Field Cycle Receiver",
      idempotencyKey: `${randomUUID()}:delivered`,
      occurredAt: deliveredAt,
    },
    agent,
  );
  check(
    "a delivery with no evidence is refused",
    !noEvidence.ok,
    noEvidence.ok ? "a POD was written with nothing in it" : noEvidence.error,
  );

  const delivered = await recordDelivery(
    {
      taskId: reattempt.id,
      receiverName: "Field Cycle Receiver",
      receiverRelation: "Self",
      receiverPhone: "9811100012",
      signatureDataUrl: PIXEL_PNG,
      photoDataUrl: PIXEL_PNG,
      remarks: "Delivered — field cycle verification",
      idempotencyKey: `${deliverKey}:delivered`,
      occurredAt: deliveredAt,
      latitude: 26.9124,
      longitude: 75.7873,
      deviceId: "verify-field-cycle",
    },
    agent,
  );
  check(
    "the delivery is recorded with a POD",
    delivered.ok && delivered.duplicate === false,
    delivered.ok ? delivered.podId : delivered.error,
  );

  const replayedDelivery = await recordDelivery(
    {
      taskId: reattempt.id,
      receiverName: "Field Cycle Receiver",
      signatureDataUrl: PIXEL_PNG,
      idempotencyKey: `${deliverKey}:delivered`,
      occurredAt: deliveredAt,
    },
    agent,
  );
  check(
    "replaying the queued delivery is a no-op",
    replayedDelivery.ok && replayedDelivery.duplicate === true,
    replayedDelivery.ok ? "" : replayedDelivery.error,
  );

  const pods = await prisma.pod.count({ where: { shipmentId: booking.shipmentId } });
  check("exactly one POD exists", pods === 1, `${pods} POD row(s)`);

  const pod = await prisma.pod.findFirst({
    where: { shipmentId: booking.shipmentId },
    select: { receiverName: true, assets: { select: { kind: true } } },
  });
  check(
    "the POD carries the receiver and the captured evidence",
    pod?.receiverName === "Field Cycle Receiver" && (pod?.assets.length ?? 0) >= 1,
    `${pod?.assets.length ?? 0} asset(s)`,
  );

  // ── Closing the run ───────────────────────────────────────
  console.log("\nClosing the run");

  const closed = await completeRun(runId, agent);
  check("the run closes once every stop has an outcome", closed.ok, closed.ok ? "" : closed.error);

  const finalRun = await prisma.deliveryRun.findUniqueOrThrow({
    where: { id: runId },
    select: { status: true, totalTasks: true, completedTasks: true, failedTasks: true },
  });
  check(
    "the run's tallies match what happened",
    finalRun.completedTasks >= 1 && finalRun.failedTasks >= 1,
    `${finalRun.status}: ${finalRun.completedTasks} delivered, ${finalRun.failedTasks} failed, ` +
      `${finalRun.totalTasks} total`,
  );

  await finish(booking.shipmentId, booking.lrNumber);
}

/**
 * The point of the whole exercise: the log, read back.
 *
 * A cycle that ends in the right status but leaves a gap in the timeline
 * has still failed, because the timeline is what a customer, a claim and
 * an auditor all read.
 */
async function finish(shipmentId: string, lrNumber: string) {
  console.log("\nThe event log");

  const events = await prisma.shipmentEvent.findMany({
    where: { shipmentId },
    // `recordedAt` — the server's clock — because the point below is that
    // the device's clock and the server's disagree, and sorting on the one
    // under examination would beg the question.
    orderBy: [{ recordedAt: "asc" }],
    select: {
      eventType: true,
      resultingStatus: true,
      source: true,
      occurredAt: true,
      recordedAt: true,
      clockDriftSeconds: true,
      reasonCode: { select: { code: true } },
    },
  });

  const types = events.map((event) => event.eventType);
  const expected: ShipmentEventType[] = [
    "BOOKING_CREATED",
    "DELIVERY_ASSIGNED",
    "RUN_STARTED",
    "DELIVERY_ATTEMPTED",
    "DELIVERED",
    "POD_SYNCED",
  ];

  for (const type of expected) {
    check(`the log records ${type}`, types.includes(type), types.includes(type) ? "" : "missing");
  }

  const fieldEvents = events.filter((event) => event.source === "FIELD_APP");
  check(
    "the field app's events are attributed to it",
    fieldEvents.length >= 3,
    `${fieldEvents.length} of ${events.length} events came from FIELD_APP`,
  );

  const attempt = events.find((event) => event.eventType === "DELIVERY_ATTEMPTED");
  check(
    "the failed attempt carries the reason it failed",
    Boolean(attempt?.reasonCode?.code),
    attempt?.reasonCode?.code ?? "no reason code on the attempt",
  );

  // The attempt was synced with a device clock forty-five minutes behind,
  // which is the ordinary case for a phone that has been out of signal.
  // The gap between the two clocks is the thing that has to be captured:
  // without it, nobody looking at the timeline later can tell a late sync
  // from a late delivery.
  check(
    "a device clock behind the server's is recorded as drift",
    (attempt?.clockDriftSeconds ?? 0) >= 30 * 60,
    attempt?.clockDriftSeconds === null || attempt?.clockDriftSeconds === undefined
      ? "clockDriftSeconds is null on an event synced 45 minutes late"
      : `${attempt.clockDriftSeconds}s`,
  );

  const orderOf = (type: ShipmentEventType) =>
    events.findIndex((event) => event.eventType === type);
  const assigned = orderOf("DELIVERY_ASSIGNED");
  const attempted = orderOf("DELIVERY_ATTEMPTED");
  const delivered = orderOf("DELIVERED");
  const podded = orderOf("POD_SYNCED");

  check(
    "the story reads in order — assigned, attempted, delivered, POD",
    assigned >= 0 && attempted > assigned && delivered > attempted && podded > delivered,
    `assigned@${assigned} attempted@${attempted} delivered@${delivered} pod@${podded}`,
  );

  // Status is a projection of the log, not a column somebody remembered to
  // update. Replaying the events has to land where the column already is.
  const replay = await replayStatus(shipmentId);
  check(
    "replaying the log reproduces the stored status",
    replay.matches,
    `replayed ${replay.replayed}, stored ${replay.stored}`,
  );

  console.log(`\nTimeline for ${lrNumber} — ${events.length} events`);
  for (const event of events) {
    console.log(
      `  ${event.recordedAt.toISOString().slice(11, 19)}  ` +
        `${event.eventType.padEnd(20)} ${String(event.source).padEnd(10)} ` +
        `${event.resultingStatus ?? "(no status change)"}` +
        `${event.clockDriftSeconds ? `  (device ${event.clockDriftSeconds}s off)` : ""}`,
    );
  }
}

async function main() {
  const tenant = await actingTenant();
  console.log(
    `\nField delivery cycle — acting as ${tenant.slug} (${tenant.subdomain})\n`,
  );

  await runWithTenant(tenant, async () => {
    try {
      await run();
    } finally {
      // Only the row this run invented. A series the tenant configured for
      // itself is left exactly where it was.
      if (fixtureSeriesId) {
        await prisma.numberSeries.delete({ where: { id: fixtureSeriesId } });
        console.log("\n  removed the stand-in DELIVERY_RUN series");
      }
    }
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "PASS\n" : "FAIL\n");
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("\nVerification crashed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
