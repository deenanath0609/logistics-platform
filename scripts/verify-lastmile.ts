/**
 * The last mile and COD, from the door to the branch safe.
 *
 *   npx tsx scripts/verify-lastmile.ts [--base http://localhost:3010]
 *
 * `verify-field-cycle.ts` proves one delivery survives an offline queue.
 * This proves the rest of the module: that there is a way in to every
 * screen, that the attempt ladder actually ends somewhere, that the money
 * an agent is accountable for closes at day end, and that a refusal is a
 * refusal — nothing written on either side of it.
 *
 * What it asserts, in order:
 *
 *   · the ops screens and the field screens render for the people who hold
 *     the permission, and the controls behind `delivery.rto` and
 *     `delivery.reassign` appear for them and for nobody else;
 *   · `runDate` and `depositDate` are `@db.Date` columns and store the day
 *     that was actually asked for — the fifth outing for a bug that has now
 *     cost this repository four fixes elsewhere;
 *   · three failed attempts exhaust the allowance, the decision turns to
 *     RTO, and a person holding `delivery.rto` can take it;
 *   · a stop with an outcome refuses a second one, and stores nothing;
 *   · COD closes: collected at the door, deposited at the branch, counted
 *     by the branch — and a short deposit leaves the collections open, the
 *     shortfall stored, and an exception raised;
 *   · every write is branch-scoped, not only every list.
 *
 * Nothing here counts whole tables. `verify-reweigh.ts` compared a
 * `count()` against a `findMany({ take: 6 })` and started failing the day
 * the table held six rows; every assertion below is scoped to the rows this
 * run created.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { basePrisma, prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor, type TenantContext } from "../src/lib/tenant";
import type { SessionUser } from "../src/lib/auth/session";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";
import { createBooking } from "../src/lib/shipment/booking";
import { appendShipmentEvent } from "../src/lib/shipment/events";
import {
  addShipmentsToRun,
  completeRun,
  createDeliveryRun,
  removeTaskFromRun,
  startRun,
} from "../src/lib/delivery/runs";
import {
  initiateRto,
  recordDelivery,
  recordFailedAttempt,
} from "../src/lib/delivery/execute";
import {
  agentCodPositions,
  createCodDeposit,
  verifyCodDeposit,
} from "../src/lib/delivery/cod";
import { nextAction } from "../src/lib/delivery/attempts";
import { storedIsoDay, storedToday } from "../src/lib/delivery/calendar";
import { createComplaint, transitionComplaint } from "../src/lib/complaints/service";
import type { ShipmentEventType, ShipmentStatus } from "../src/generated/prisma/client";

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

const ADMIN_MOBILE = args.get("admin") ?? process.env.SMOKE_ADMIN_MOBILE ?? "9999999999";
/** Jaipur: its delivery agent, and the manager who plans their day. */
const AGENT_MOBILE = args.get("agent") ?? "9444000006";
const MANAGER_MOBILE = args.get("manager") ?? "9444000001";
/** Somebody with the same role at a branch that is none of Jaipur's business. */
const STRANGER_MOBILE = args.get("stranger") ?? "9555000001";

/** A one-pixel PNG — the smallest thing that passes for a scrawl on glass. */
const PIXEL_PNG =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

// ────────────────────────────────────────────────────────────
// Signing in, and reading a page
// ────────────────────────────────────────────────────────────

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

type Page = { status: number; body: string; finalPath: string };

/**
 * A page, once it has actually rendered.
 *
 * `next dev` answers a request for a route it has not compiled yet with a
 * shell, so a first read can be a 200 with none of the content on it.
 * Asserting on that reads as a missing control when the only thing missing
 * is the compile. `expect` is the marker that says the render is real.
 */
async function open(
  jar: CookieJar,
  path: string,
  expect?: string,
  attempts = 6,
): Promise<Page> {
  let last: Page = { status: 0, body: "", finalPath: path };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await hostFollow(HOST, PORT, path, jar);
    last = {
      status: response.status,
      body: response.body,
      finalPath: response.finalPath,
    };
    if (last.status === 200 && (!expect || last.body.includes(expect))) return last;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  return last;
}

function renders(label: string, page: Page, marker?: string) {
  check(
    label,
    page.status === 200 &&
      !page.finalPath.includes("/login") &&
      !page.finalPath.includes("/not-on-plan") &&
      (!marker || page.body.includes(marker)),
    `HTTP ${page.status} at ${page.finalPath}${
      marker && !page.body.includes(marker) ? ` — "${marker}" not on the page` : ""
    }`,
  );
}

// ────────────────────────────────────────────────────────────
// Actors
// ────────────────────────────────────────────────────────────

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

/**
 * The same person, holding a permission their seeded role does not.
 *
 * Roles are rows, not code — a carrier can mint "Branch Supervisor" with
 * `delivery.execute` on a single branch any afternoon. The permission gate
 * and the branch gate are separate guards, and testing the second one needs
 * an actor who is past the first. This is that actor, and nothing else.
 */
function withPermissions(actor: SessionUser, grants: string[]): SessionUser {
  return { ...actor, permissions: new Set([...actor.permissions, ...grants]) };
}

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

type Fixture = { shipmentId: string; lrNumber: string };

/** A consignment standing on the delivery branch's floor, ready to go out. */
async function consignmentOnFloor(
  admin: SessionUser,
  deliveryBranchId: string,
  label: string,
  cod: number | null,
  /** Kept off the origin so a scope check cannot pass by coincidence. */
  notOrigin: string[] = [],
): Promise<Fixture | null> {
  const origin = await prisma.branch.findFirstOrThrow({
    where: {
      isActive: true,
      deletedAt: null,
      id: { notIn: [deliveryBranchId, ...notOrigin] },
    },
    orderBy: { code: "asc" },
    select: { id: true },
  });

  const [service, packageType, originCity, destinationCity] = await Promise.all([
    prisma.serviceType.findFirstOrThrow({
      where: { isActive: true, mode: "PTL", ...(cod ? { allowsCod: true } : {}) },
      orderBy: { code: "asc" },
      select: { id: true, maxDeliveryAttempts: true },
    }),
    prisma.packageType.findFirstOrThrow({ select: { id: true } }),
    prisma.city.findFirstOrThrow({ orderBy: { code: "asc" }, select: { id: true } }),
    prisma.city.findFirstOrThrow({ orderBy: { code: "desc" }, select: { id: true } }),
  ]);

  const booking = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: service.id,
      bookingBranchId: origin.id,
      originBranchId: origin.id,
      destinationBranchId: deliveryBranchId,

      consignorName: `Last mile ${label} consignor`,
      consignorPhone: "9811100021",
      consignorAddress: "Last-mile verification origin",
      consignorCityId: originCity.id,
      consignorPincode: "122015",

      consigneeName: `Last mile ${label} consignee`,
      consigneePhone: "9811100022",
      consigneeAddress: "Last-mile verification destination",
      consigneeCityId: destinationCity.id,
      consigneePincode: "302013",

      packageCount: 1,
      packageTypeId: packageType.id,
      actualWeight: 3,
      goodsDescription: "Last-mile verification — auto-generated",
      declaredValue: 2000,
      paymentType: cod ? "COD" : "PAID",
      codAmount: cod ?? undefined,
      pickupRequired: false,
    },
    admin,
  );

  if (!booking.ok) {
    check(`a ${label} consignment is booked`, false, booking.error);
    return null;
  }

  const journey: Array<{ event: ShipmentEventType; branchId?: string; expect: ShipmentStatus }> = [
    { event: "PICKUP_ASSIGNED", expect: "PICKUP_ASSIGNED" },
    { event: "PICKUP_COMPLETED", branchId: origin.id, expect: "PICKED_UP" },
    { event: "INBOUND_SCAN", branchId: origin.id, expect: "RECEIVED_AT_ORIGIN" },
    { event: "SORTED", branchId: origin.id, expect: "PROCESSED" },
    { event: "MANIFEST_ADDED", expect: "MANIFESTED" },
    { event: "GATE_OUT", branchId: origin.id, expect: "DISPATCHED" },
    { event: "GATE_IN", branchId: deliveryBranchId, expect: "ARRIVED_AT_HUB" },
    { event: "INBOUND_SCAN", branchId: deliveryBranchId, expect: "RECEIVED_AT_HUB" },
  ];

  for (const step of journey) {
    const result = await appendShipmentEvent(
      {
        shipmentId: booking.shipmentId,
        eventType: step.event,
        branchId: step.branchId ?? null,
      },
      admin,
    );
    if (!result.ok) {
      check(`the ${label} consignment reaches the delivery branch`, false, result.error);
      return null;
    }
  }

  return { shipmentId: booking.shipmentId, lrNumber: booking.lrNumber };
}

/** Puts a stop on the run and out-scans it. */
async function sendOut(
  runId: string,
  shipmentId: string,
  planner: SessionUser,
  agent: SessionUser,
): Promise<{ taskId: string; attemptNumber: number } | null> {
  // `added === 0` is not a failure here: a stop already sitting on this run
  // from an earlier step is exactly what we want out-scanned.
  const added = await addShipmentsToRun(runId, [shipmentId], planner);
  if (!added.ok) return null;
  await startRun(runId, agent);

  const task = await prisma.deliveryTask.findFirst({
    where: { shipmentId, runId, status: "OUT_FOR_DELIVERY" },
    orderBy: { attemptNumber: "desc" },
    select: { id: true, attemptNumber: true },
  });

  return task ? { taskId: task.id, attemptNumber: task.attemptNumber } : null;
}

// ────────────────────────────────────────────────────────────

async function run() {
  const admin = await loadActor(ADMIN_MOBILE);
  const agent = await loadActor(AGENT_MOBILE);
  const manager = await loadActor(MANAGER_MOBILE);
  const stranger = await loadActor(STRANGER_MOBILE);

  const branchId = agent.primaryBranch?.id;
  if (!branchId) {
    check("the delivery agent has a home branch", false, `${AGENT_MOBILE} has no primary branch`);
    return;
  }

  const branch = await prisma.branch.findUniqueOrThrow({
    where: { id: branchId },
    select: { id: true, code: true, name: true },
  });

  console.log(
    `  agent ${agent.name} (${agent.scope}) and manager ${manager.name} ` +
      `at ${branch.code}; ${stranger.name} at ${stranger.primaryBranch?.code ?? "?"}\n`,
  );

  check(
    "the agent works to their own scope",
    agent.scope === "OWN" && agent.permissions.has("delivery.execute"),
    `scope ${agent.scope}`,
  );
  check(
    "the manager plans but does not deliver",
    manager.permissions.has("delivery.assign") && !manager.permissions.has("delivery.execute"),
    "planning and execution are separate permissions",
  );
  check(
    "the stranger is scoped to another branch",
    Boolean(stranger.branchIds?.length) && !stranger.branchIds?.includes(branchId),
    `${stranger.primaryBranch?.code ?? "no branch"} — the cross-branch checks below need this`,
  );

  // ══ The day's run ═════════════════════════════════════════
  console.log("\nThe day's run");

  const runDay = storedToday();
  const created = await createDeliveryRun(
    { branchId, agentId: agent.id, runDate: runDay },
    manager,
  );

  let runId: string;
  let runNumber: string;
  if (created.ok) {
    runId = created.runId;
    runNumber = created.number;
    check("the branch manager builds the agent's run", true, created.number);
  } else {
    const existing = await prisma.deliveryRun.findFirst({
      where: { agentId: agent.id, runDate: runDay, status: { in: ["PLANNED", "STARTED"] } },
      select: { id: true, number: true },
    });
    if (!existing) {
      check("the branch manager builds the agent's run", false, created.error);
      return;
    }
    runId = existing.id;
    runNumber = existing.number;
    check(
      "the branch manager builds the agent's run",
      true,
      `reusing ${existing.number} — one open run per agent per day, as designed`,
    );
  }

  // ── The `@db.Date` columns ────────────────────────────────
  //
  // `runDate` and `depositDate` keep the UTC calendar day. Written from
  // local midnight they landed on the day before at IST, which is how the
  // SLA shortfall detector — which matches `depositDate` at UTC midnight,
  // correctly — could never find a deposit at all.
  const storedRun = await prisma.deliveryRun.findUniqueOrThrow({
    where: { id: runId },
    select: { runDate: true },
  });
  check(
    "the run is filed under the day it was asked for",
    storedIsoDay(storedRun.runDate) === storedIsoDay(runDay),
    `asked for ${storedIsoDay(runDay)}, stored ${storedIsoDay(storedRun.runDate)}`,
  );

  // ══ Screens ═══════════════════════════════════════════════
  console.log("\nA way in — the ops screens");

  const managerJar = await signIn(MANAGER_MOBILE, "/delivery/runs");
  const adminJar = await signIn(ADMIN_MOBILE, "/delivery/runs");
  const agentJar = await signIn(AGENT_MOBILE, "/delivery");

  const runsList = await open(managerJar, "/delivery/runs", "Delivery runs");
  renders("the delivery runs list renders for the branch manager", runsList, "Delivery runs");
  check(
    "and offers a way to build one",
    runsList.body.includes("New run"),
    "the create control is on the page",
  );
  check(
    "the list is dated by the day the run was actually filed under",
    runsList.body.includes(runNumber),
    `${runNumber} is on today's page`,
  );

  const codScreen = await open(managerJar, "/delivery/cod", "COD day end");
  renders("the COD day-end screen renders", codScreen, "COD day end");
  check(
    "and is reachable from the runs list without knowing the URL",
    runsList.body.includes("/delivery/cod"),
    "the day-end link is on the runs page",
  );

  const complaints = await open(managerJar, "/complaints", "Complaints");
  renders("the complaints desk renders", complaints);

  const fieldToday = await open(agentJar, "/delivery");
  renders("the agent's own day renders", fieldToday, runNumber);

  // ── The controls on a stop ────────────────────────────────
  //
  // Both of these server actions existed with no control anywhere in the
  // product. They are asserted here, while a stop is still pending and its
  // consignment can still legally be turned around, because that is the
  // only moment either control is honest.
  const codAmount = 1750;
  const codShipment = await consignmentOnFloor(admin, branchId, "cod", codAmount, stranger.branchIds ?? []);
  if (!codShipment) return;

  const staged = await addShipmentsToRun(runId, [codShipment.shipmentId], manager);
  check(
    "a COD consignment is put on the run",
    staged.ok,
    staged.ok
      ? `₹${codAmount} on ${codShipment.lrNumber}`
      : staged.error,
  );

  const runPageAdmin = await open(adminJar, `/delivery/runs/${runId}`, codShipment.lrNumber);
  renders("the run opens", runPageAdmin, runNumber);
  check(
    "and offers the return to somebody holding delivery.rto",
    runPageAdmin.body.includes("back to the sender"),
    "the RTO control is on the stop",
  );

  const runPageManager = await open(managerJar, `/delivery/runs/${runId}`, codShipment.lrNumber);
  renders("the branch manager may read the same run", runPageManager, runNumber);
  check(
    "but is not offered the return — a permission, not decoration",
    !runPageManager.body.includes("back to the sender"),
    "the branch manager does not hold delivery.rto",
  );
  check(
    "and is offered the control that is theirs — taking a stop off the run",
    runPageManager.body.includes("off this run"),
    "the remove-stop control is on the row",
  );

  // ══ The door ══════════════════════════════════════════════
  console.log("\nThe door — three attempts and a return");

  const ladder = await consignmentOnFloor(admin, branchId, "attempt-ladder", null, stranger.branchIds ?? []);
  if (!ladder) return;
  check("a consignment is standing on the branch floor", true, ladder.lrNumber);

  const service = await prisma.shipment.findUniqueOrThrow({
    where: { id: ladder.shipmentId },
    select: { serviceType: { select: { code: true, maxDeliveryAttempts: true } } },
  });
  const allowance = service.serviceType.maxDeliveryAttempts;

  const failureReason = await prisma.reasonCode.findFirstOrThrow({
    where: { category: "DELIVERY_FAILURE", triggersReattempt: true, isActive: true },
    select: { id: true, code: true, name: true },
  });

  let lastDecision = "";
  let firstTaskId = "";

  for (let visit = 1; visit <= allowance; visit += 1) {
    const stop = await sendOut(runId, ladder.shipmentId, manager, agent);
    if (!stop) {
      check(`visit ${visit} goes out on the run`, false, "the stop could not be put on the run");
      return;
    }
    if (visit === 1) firstTaskId = stop.taskId;

    const attempt = await recordFailedAttempt(
      {
        taskId: stop.taskId,
        reasonCodeId: failureReason.id,
        remarks: `Nobody at the address — last-mile verification, visit ${visit}`,
        idempotencyKey: randomUUID(),
        occurredAt: new Date(),
        deviceId: "verify-lastmile",
      },
      agent,
    );

    if (!attempt.ok) {
      check(`visit ${visit} is recorded as a failed attempt`, false, attempt.error);
      return;
    }

    lastDecision = attempt.decision.action;

    check(
      `visit ${visit} of ${allowance} is recorded, and the count goes up`,
      attempt.attemptCount === visit,
      `attemptCount ${attempt.attemptCount}, next action ${attempt.decision.action}`,
    );

    const after = await prisma.shipment.findUniqueOrThrow({
      where: { id: ladder.shipmentId },
      select: { currentStatus: true, attemptCount: true },
    });
    check(
      `and it is back at the branch, not in a "failed" status`,
      after.currentStatus === "RECEIVED_AT_HUB" && after.attemptCount === visit,
      `${after.currentStatus}, attemptCount ${after.attemptCount}`,
    );
  }

  check(
    "the allowance spent, the decision turns to a return to origin",
    lastDecision === "RTO",
    `after ${allowance} attempts the policy says ${lastDecision}`,
  );

  // The pure policy agrees, whatever the reason row says about reattempts.
  check(
    "and would say so for any reason once the allowance is spent",
    nextAction(
      { attemptCount: allowance },
      {
        triggersReattempt: true,
        triggersException: false,
        isChargeable: false,
        notifiesConsignor: false,
        notifiesConsignee: false,
        requiresPhoto: false,
        requiresRemarks: false,
      },
      { maxDeliveryAttempts: allowance },
    ).action === "RTO",
    "the attempt allowance is checked before the reason's own automation",
  );

  // A reason code is not optional, and a refusal writes nothing.
  const attemptsBefore = await prisma.deliveryAttempt.count({
    where: { shipmentId: ladder.shipmentId },
  });
  const reasonless = await recordFailedAttempt(
    {
      taskId: firstTaskId,
      reasonCodeId: "not-a-reason-code",
      idempotencyKey: randomUUID(),
      occurredAt: new Date(),
    },
    agent,
  );
  const attemptsAfter = await prisma.deliveryAttempt.count({
    where: { shipmentId: ladder.shipmentId },
  });
  check(
    "an attempt with no valid reason is refused",
    !reasonless.ok,
    reasonless.ok ? "LEAK — recorded without a reason" : reasonless.error,
  );
  check(
    "and the refusal wrote nothing",
    attemptsBefore === attemptsAfter,
    `${attemptsBefore} attempt row(s) before and after`,
  );

  // ── Taking the return ─────────────────────────────────────
  const rtoReason = await prisma.reasonCode.findFirstOrThrow({
    where: { category: "RTO", isActive: true },
    select: { id: true, code: true },
  });

  const agentCannotReturn = await initiateRto(
    ladder.shipmentId,
    rtoReason.id,
    agent,
    "the agent should not be able to do this",
  );
  check(
    "the agent at the door cannot decide a return",
    !agentCannotReturn.ok,
    agentCannotReturn.ok ? "LEAK — the agent turned it around" : agentCannotReturn.error,
  );

  const strangerCannotReturn = await initiateRto(
    ladder.shipmentId,
    rtoReason.id,
    withPermissions(stranger, ["delivery.rto"]),
    "another branch should not be able to do this",
  );
  check(
    "nor may a branch the consignment has nothing to do with",
    !strangerCannotReturn.ok,
    strangerCannotReturn.ok
      ? "LEAK — another branch turned it around"
      : strangerCannotReturn.error,
  );

  const stillHere = await prisma.shipment.findUniqueOrThrow({
    where: { id: ladder.shipmentId },
    select: { currentStatus: true },
  });
  check(
    "and neither refusal moved it",
    stillHere.currentStatus === "RECEIVED_AT_HUB",
    stillHere.currentStatus,
  );

  const returned = await initiateRto(
    ladder.shipmentId,
    rtoReason.id,
    admin,
    "Maximum attempts exhausted — last-mile verification",
  );
  check(
    "somebody holding delivery.rto can take the return",
    returned.ok,
    returned.ok ? rtoReason.code : returned.error,
  );

  const afterRto = await prisma.shipment.findUniqueOrThrow({
    where: { id: ladder.shipmentId },
    select: { currentStatus: true },
  });
  check(
    "the consignment is on its way back to the sender",
    afterRto.currentStatus === "RTO_INITIATED",
    afterRto.currentStatus,
  );

  const openStops = await prisma.deliveryTask.count({
    where: { shipmentId: ladder.shipmentId, status: { in: ["PENDING", "OUT_FOR_DELIVERY"] } },
  });
  check(
    "and no stop is still owed a delivery",
    openStops === 0,
    `${openStops} open stop(s) on this consignment`,
  );

  // ══ A stop with an outcome ════════════════════════════════
  console.log("\nA stop that already has an outcome");

  const settled = await recordDelivery(
    {
      taskId: firstTaskId,
      receiverName: "Should Not Happen",
      signatureDataUrl: PIXEL_PNG,
      idempotencyKey: randomUUID(),
      occurredAt: new Date(),
    },
    agent,
  );
  check(
    "a delivery against a stop already closed out is refused",
    !settled.ok,
    settled.ok ? "LEAK — delivered twice" : settled.error,
  );

  const podRows = await prisma.pod.count({ where: { taskId: firstTaskId } });
  const assetRows = await prisma.fileAsset.count({
    where: { ownerEntity: "Shipment", ownerId: ladder.shipmentId, kind: "POD_SIGNATURE" },
  });
  check(
    "and nothing was written — no POD, and no evidence left orphaned",
    podRows === 0 && assetRows === 0,
    `${podRows} POD row(s), ${assetRows} signature asset(s) for this consignment`,
  );

  // ══ COD ═══════════════════════════════════════════════════
  console.log("\nCOD — the day closes");

  const codStop = await sendOut(runId, codShipment.shipmentId, manager, agent);
  if (!codStop) {
    check("the COD consignment goes out on the run", false, "it could not be out-scanned");
    return;
  }
  check("the COD consignment goes out on the run", true, `₹${codAmount} on ${codShipment.lrNumber}`);

  // ── The door, as the agent sees it ────────────────────────
  const doorScreen = await open(agentJar, `/delivery/task/${codStop.taskId}`, codShipment.lrNumber);
  renders("the agent's stop opens on their phone", doorScreen, codShipment.lrNumber);
  check(
    "and offers both outcomes",
    doorScreen.body.includes("Deliver") && doorScreen.body.includes("Could not deliver"),
    "the two door actions are on the screen",
  );
  check(
    "with the money the agent must take before handing over",
    doorScreen.body.includes("Collect before handing over") &&
      doorScreen.body.includes(codAmount.toLocaleString("en-IN")),
    `₹${codAmount} is on the door screen`,
  );
  check(
    "and the reasons a failure has to carry",
    doorScreen.body.includes(failureReason.name),
    failureReason.name,
  );

  // Another agent's stop is not reachable by guessing the id.
  const strangerAgent = await prisma.user.findFirst({
    where: {
      isFieldUser: true,
      status: "ACTIVE",
      id: { not: agent.id },
      roles: { some: { role: { code: "DELIVERY_AGENT" } } },
    },
    select: { mobile: true },
  });

  if (!strangerAgent) {
    console.log("  [SKIP] only one delivery agent is seeded, so the door-screen boundary is untested");
  } else {
    const otherJar = await signIn(strangerAgent.mobile, "/delivery");
    const trespass = await open(otherJar, `/delivery/task/${codStop.taskId}`, undefined, 2);
    check(
      "another agent cannot open it",
      trespass.status === 404 || !trespass.body.includes(codShipment.lrNumber),
      `HTTP ${trespass.status} for ${strangerAgent.mobile}`,
    );
  }

  const shortPay = await recordDelivery(
    {
      taskId: codStop.taskId,
      receiverName: "Last Mile Receiver",
      signatureDataUrl: PIXEL_PNG,
      idempotencyKey: randomUUID(),
      occurredAt: new Date(),
      cod: { amountCollected: codAmount - 250, mode: "CASH", reference: null },
    },
    agent,
  );
  check(
    "the goods are not released for a part payment",
    !shortPay.ok,
    shortPay.ok ? "LEAK — handed over ₹250 short" : shortPay.error,
  );

  const collectionsAfterRefusal = await prisma.codCollection.count({
    where: { shipmentId: codShipment.shipmentId },
  });
  check(
    "and the refusal took no money",
    collectionsAfterRefusal === 0,
    `${collectionsAfterRefusal} collection row(s) for this consignment`,
  );

  const deliveryKey = randomUUID();
  const delivered = await recordDelivery(
    {
      taskId: codStop.taskId,
      receiverName: "Last Mile Receiver",
      receiverRelation: "Self",
      signatureDataUrl: PIXEL_PNG,
      idempotencyKey: deliveryKey,
      occurredAt: new Date(),
      cod: { amountCollected: codAmount, mode: "CASH", reference: null },
    },
    agent,
  );
  check(
    "paid in full, it is delivered",
    delivered.ok && delivered.duplicate === false,
    delivered.ok ? delivered.podId : delivered.error,
  );

  const replay = await recordDelivery(
    {
      taskId: codStop.taskId,
      receiverName: "Last Mile Receiver",
      receiverRelation: "Self",
      signatureDataUrl: PIXEL_PNG,
      idempotencyKey: deliveryKey,
      occurredAt: new Date(),
      cod: { amountCollected: codAmount, mode: "CASH", reference: null },
    },
    agent,
  );
  check(
    "the queue's replay confirms rather than collecting twice",
    replay.ok && replay.duplicate === true,
    replay.ok ? `duplicate=${replay.duplicate}` : replay.error,
  );

  const collections = await prisma.codCollection.findMany({
    where: { shipmentId: codShipment.shipmentId },
    select: { id: true, amountCollected: true, state: true, agentId: true },
  });
  check(
    "exactly one collection is on the ledger",
    collections.length === 1 &&
      new Decimal(collections[0].amountCollected.toString()).equals(codAmount),
    `${collections.length} row(s), ₹${collections[0]?.amountCollected ?? 0}`,
  );

  // ── What the POD claims it stored ─────────────────────────
  const pod = await prisma.pod.findUnique({
    where: { taskId: codStop.taskId },
    select: {
      receiverName: true,
      receiverRelation: true,
      signatureAssetId: true,
      deliveredAt: true,
      agentId: true,
      assets: { select: { kind: true, fileAssetId: true } },
    },
  });
  check(
    "the POD stores what it claims to — receiver, evidence, and who took it",
    Boolean(pod) &&
      pod!.receiverName === "Last Mile Receiver" &&
      pod!.receiverRelation === "Self" &&
      Boolean(pod!.signatureAssetId) &&
      pod!.agentId === agent.id &&
      pod!.assets.some((asset) => asset.kind === "SIGNATURE"),
    pod ? `${pod.assets.length} asset(s), signed for by ${pod.receiverName}` : "no POD",
  );

  const podPage = await open(adminJar, `/delivery/pod/${codShipment.shipmentId}`, codShipment.lrNumber);
  renders("the proof of delivery renders as a document", podPage, codShipment.lrNumber);
  check(
    "and names who received it",
    podPage.body.includes("Last Mile Receiver"),
    "the receiver is on the printed proof",
  );

  // ── The run's own accountability ──────────────────────────
  const runTotals = await prisma.deliveryRun.findUniqueOrThrow({
    where: { id: runId },
    select: { codExpected: true, codCollected: true },
  });
  check(
    "the run's COD accountability matches what was taken at the doors",
    new Decimal(runTotals.codCollected.toString()).greaterThanOrEqualTo(codAmount) &&
      new Decimal(runTotals.codExpected.toString()).greaterThanOrEqualTo(codAmount),
    `₹${runTotals.codCollected} collected of ₹${runTotals.codExpected} due`,
  );

  // ── Day end ───────────────────────────────────────────────
  const positionsBefore = await agentCodPositions(branchId, new Date(), manager);
  const mine = positionsBefore.find((row) => row.agentId === agent.id);
  check(
    "the day-end screen shows the agent holding the cash",
    Boolean(mine) &&
      new Decimal(mine!.collected).greaterThanOrEqualTo(codAmount) &&
      new Decimal(mine!.shortfall).greaterThanOrEqualTo(codAmount),
    mine
      ? `₹${mine.collected} collected, ₹${mine.deposited} deposited, ₹${mine.shortfall} short`
      : "the agent is not on the day-end list",
  );
  check(
    "and names the run they are accountable for",
    Boolean(mine?.runNumbers.includes(runNumber)),
    mine?.runNumbers.join(", ") ?? "no runs",
  );

  // A branch that is not this one gets nothing back, whatever id it asks.
  const strangerPositions = await agentCodPositions(branchId, new Date(), stranger);
  check(
    "another branch's manager sees none of this branch's day end",
    strangerPositions.length === 0,
    `${strangerPositions.length} agent position(s) returned to ${stranger.primaryBranch?.code}`,
  );

  // ── The handover, deliberately short ──────────────────────
  const held = 250;
  const declared = codAmount - held;

  const strangerDeposit = await createCodDeposit(
    {
      branchId,
      agentId: agent.id,
      depositDate: new Date(),
      amountDeclared: declared,
      mode: "CASH",
      collectionIds: [collections[0].id],
    },
    stranger,
  );
  check(
    "another branch cannot take this branch's handover",
    !strangerDeposit.ok,
    strangerDeposit.ok ? "LEAK — a stranger banked the cash" : strangerDeposit.error,
  );

  const depositsAfterRefusal = await prisma.codDeposit.count({
    where: { branchId, agentId: agent.id, depositDate: storedToday() },
  });

  const deposit = await createCodDeposit(
    {
      branchId,
      agentId: agent.id,
      depositDate: new Date(),
      amountDeclared: declared,
      mode: "CASH",
      collectionIds: [collections[0].id],
    },
    manager,
  );
  check(
    "the branch manager takes the handover",
    deposit.ok,
    deposit.ok ? `₹${declared} declared, ₹${deposit.shortfall} short` : deposit.error,
  );
  if (!deposit.ok) return;

  const depositsNow = await prisma.codDeposit.count({
    where: { branchId, agentId: agent.id, depositDate: storedToday() },
  });
  check(
    "the refused handover left no deposit behind, and the real one did",
    depositsNow === depositsAfterRefusal + 1,
    `${depositsAfterRefusal} before the refusal, ${depositsNow} after the real one`,
  );

  check(
    "the shortfall is stored against what was collected, not what was declared",
    new Decimal(deposit.shortfall).equals(held),
    `₹${deposit.shortfall}`,
  );

  const storedDeposit = await prisma.codDeposit.findUniqueOrThrow({
    where: { id: deposit.depositId },
    select: { depositDate: true, status: true },
  });
  check(
    "and it is filed under the day it was handed in",
    storedIsoDay(storedDeposit.depositDate) === storedIsoDay(storedToday()),
    `stored ${storedIsoDay(storedDeposit.depositDate)}, today ${storedIsoDay(storedToday())}`,
  );

  // §A.11 — a shortfall at day end is somebody's problem the same day.
  const raised = await prisma.outboxEvent.findFirst({
    where: { eventType: "cod.shortfall", aggregateId: deposit.depositId },
    select: { id: true },
  });
  check(
    "a shortfall raises an exception rather than being absorbed",
    Boolean(raised),
    raised ? "cod.shortfall queued on the outbox" : "nothing was raised",
  );

  // ── The count ─────────────────────────────────────────────
  const counted = await verifyCodDeposit(deposit.depositId, declared, admin);
  check(
    "the branch counts exactly what was declared",
    counted.ok && new Decimal(counted.miscount).isZero(),
    counted.ok ? `miscount ₹${counted.miscount}` : counted.error,
  );
  check(
    "but the deposit is not reconciled, because money is still missing",
    counted.ok && counted.disputed && new Decimal(counted.shortfall).equals(held),
    counted.ok
      ? `disputed=${counted.disputed}, ₹${counted.shortfall} still out`
      : counted.error,
  );

  const collectionState = await prisma.codCollection.findUniqueOrThrow({
    where: { id: collections[0].id },
    select: { state: true },
  });
  check(
    "and the collection stays open rather than being marked settled",
    collectionState.state === "DEPOSITED",
    `state ${collectionState.state} — RECONCILED here would settle money nobody has`,
  );

  const positionsAfter = await agentCodPositions(branchId, new Date(), manager);
  const still = positionsAfter.find((row) => row.agentId === agent.id);
  check(
    "the day-end screen still shows somebody is short",
    Boolean(still) && new Decimal(still!.shortfall).greaterThanOrEqualTo(held),
    still ? `₹${still.shortfall} short after the count` : "the agent fell off the list",
  );

  const codScreenAfter = await open(managerJar, "/delivery/cod", "COD day end");
  check(
    "and says so on the screen a branch actually reads",
    codScreenAfter.body.includes("outstanding across"),
    "the shortfall banner is rendered",
  );

  // ══ Branch scope on the writes ════════════════════════════
  console.log("\nBranch scope on the writes, not only on the lists");

  const outsider = withPermissions(stranger, ["delivery.execute"]);

  const strangerStart = await startRun(runId, outsider);
  check(
    "another branch cannot out-scan this branch's run",
    !strangerStart.ok,
    strangerStart.ok ? "LEAK — a stranger started the run" : strangerStart.error,
  );

  const strangerClose = await completeRun(runId, outsider);
  check(
    "nor close it",
    !strangerClose.ok,
    strangerClose.ok ? "LEAK — a stranger closed the run" : strangerClose.error,
  );

  const runStillOpen = await prisma.deliveryRun.findUniqueOrThrow({
    where: { id: runId },
    select: { status: true },
  });
  check(
    "and neither refusal touched the run",
    runStillOpen.status !== "COMPLETED" && runStillOpen.status !== "CANCELLED",
    `status ${runStillOpen.status}`,
  );

  const strangerRemove = await removeTaskFromRun(
    codStop.taskId,
    withPermissions(stranger, ["delivery.reassign"]),
  );
  check(
    "nor take a stop off it",
    !strangerRemove.ok,
    strangerRemove.ok ? "LEAK — a stranger unassigned a stop" : strangerRemove.error,
  );

  const strangerVerify = await verifyCodDeposit(
    deposit.depositId,
    declared,
    withPermissions(stranger, ["cod.reconcile"]),
  );
  check(
    "nor count this branch's cash",
    !strangerVerify.ok,
    strangerVerify.ok ? "LEAK — a stranger reconciled the deposit" : strangerVerify.error,
  );

  // ── Complaints ────────────────────────────────────────────
  const complaint = await createComplaint(
    {
      category: "DELAY",
      priority: "NORMAL",
      subject: "Last-mile verification — auto-generated",
      description: "Raised by scripts/verify-lastmile.ts to prove the write path is scoped.",
      shipmentId: codShipment.shipmentId,
    },
    manager,
  );
  check(
    "a complaint about this branch's consignment is logged",
    complaint.ok,
    complaint.ok ? complaint.data.number : complaint.error,
  );

  if (complaint.ok) {
    const trespass = await transitionComplaint(
      { complaintId: complaint.data.id, to: "RESOLVED", note: "Closed by another branch" },
      stranger,
    );
    check(
      "and another branch cannot resolve it",
      !trespass.ok,
      trespass.ok ? "LEAK — a stranger resolved it" : trespass.error,
    );

    const untouched = await prisma.complaint.findUniqueOrThrow({
      where: { id: complaint.data.id },
      select: { status: true, resolvedAt: true, messages: { select: { id: true } } },
    });
    check(
      "the refusal changed nothing and left no message on the thread",
      untouched.status === "OPEN" &&
        untouched.resolvedAt === null &&
        untouched.messages.length === 0,
      `status ${untouched.status}, ${untouched.messages.length} message(s)`,
    );

    const detail = await open(managerJar, `/complaints/${complaint.data.id}`, complaint.data.number);
    renders("the complaint opens for the branch that owns it", detail, complaint.data.number);
  }
}

async function main() {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });

  const tenant: TenantContext | null = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${SUBDOMAIN}" is closed.`);

  console.log(`\nLast mile and COD — ${org.slug} on ${HOST}:${PORT}\n`);

  await runWithTenant(tenant, () => run());

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} check(s) held, ${failures} failed.\n`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("\nThe last-mile check could not run:\n", error);
  await prisma.$disconnect();
  process.exit(1);
});
