/**
 * Drives a consignment's own lifecycle, the way the detail page does.
 *
 *   npx tsx scripts/verify-shipment-lifecycle.ts [tenant-subdomain]
 *
 * Five event types sat in the state machine with no caller anywhere in the
 * product — `CANCELLED`, `HELD`, `HOLD_RELEASED`, `BOOKING_AMENDED` and
 * `STATUS_CORRECTED`. Every one had a rule with a `from`, a `to`, a
 * permission and a `requires`, and nothing in the product could reach any of
 * them: a branch could not un-book a duplicate, a hub holding freight for a
 * payment dispute had nowhere to say so — the detail page has always
 * rendered an on-hold badge that nothing could set — and a scan onto the
 * wrong LR was permanent.
 *
 * What this proves, in order:
 *
 *   · a booking cancels while it is still only a booking, taking its
 *     collection with it, and refuses once the goods are with us — the
 *     return of somebody's freight is an RTO, not a Cancel button;
 *   · a hold stops a consignment without moving it, and a release is
 *     refused unless somebody says what changed;
 *   · an amendment corrects the whole booking before pickup and only the
 *     details that describe people afterwards, because the count and the
 *     weight stop being typeable the moment we are the ones holding the box;
 *   · a status correction needs its own sensitive permission, a reason and a
 *     written explanation, cannot be used to assert a delivery, and can pull
 *     a consignment back out of a terminal status — which is the only thing
 *     in the product that can;
 *   · every refusal above writes nothing at all. A refused transition that
 *     silently swallows the event is how `PICKUP_ATTEMPTED` was lost for
 *     months, so each refusal is checked against the event count either
 *     side of it; and
 *   · the shipment's own event log projects back to the status that is
 *     stored.
 *
 * It calls the services the screens call. Like `verify-pickup-cycle.ts` it
 * books its own consignments and leaves everything behind: the event log is
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
  amendBooking,
  cancelShipment,
  correctShipmentStatus,
  holdShipment,
  releaseHold,
} from "../src/lib/shipment/lifecycle";

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

/** Event count, which is what "wrote nothing" is measured against. */
async function events(shipmentId: string): Promise<number> {
  return prisma.shipmentEvent.count({ where: { shipmentId } });
}

async function eventTypes(shipmentId: string): Promise<string[]> {
  const rows = await prisma.shipmentEvent.findMany({
    where: { shipmentId },
    orderBy: [{ occurredAt: "asc" }, { recordedAt: "asc" }],
    select: { eventType: true },
  });
  return rows.map((row) => row.eventType);
}

/**
 * Asserts that a refusal was a refusal and that it left no trace.
 *
 * Both halves matter. A refusal that still writes is worse than one that
 * throws, because nothing on the screen says the log now disagrees with the
 * status.
 */
async function refuses(
  label: string,
  shipmentId: string,
  act: () => Promise<{ ok: boolean; error?: string }>,
) {
  const before = await events(shipmentId);
  const result = await act();
  const after = await events(shipmentId);

  check(label, !result.ok, result.ok ? "IT WAS ALLOWED" : (result.error ?? ""));
  check(
    "  …and wrote nothing",
    after === before,
    after === before ? "" : `${before} → ${after} events`,
  );
}

type Fixtures = Awaited<ReturnType<typeof loadFixtures>>;

async function loadFixtures(branchId: string) {
  const [destination, service, packageType, gurugram, jaipur, customer] =
    await Promise.all([
      prisma.branch.findFirstOrThrow({
        where: { isActive: true, id: { not: branchId } },
        orderBy: { code: "asc" },
        select: { id: true, code: true },
      }),
      prisma.serviceType.findFirstOrThrow({ where: { code: "PTL-EXP" }, select: { id: true } }),
      prisma.packageType.findFirstOrThrow({ where: { code: "CARTON" }, select: { id: true } }),
      prisma.city.findFirstOrThrow({ where: { code: "GGN" }, select: { id: true } }),
      prisma.city.findFirstOrThrow({ where: { code: "JAI" }, select: { id: true } }),
      prisma.customer.findFirst({ select: { id: true } }),
    ]);

  return { destination, service, packageType, gurugram, jaipur, customer };
}

async function book(
  label: string,
  branchId: string,
  fixtures: Fixtures,
  actor: SessionUser,
  overrides: { packageCount?: number; actualWeight?: number; pickupRequired?: boolean } = {},
) {
  const packageCount = overrides.packageCount ?? 3;

  const result = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: fixtures.service.id,
      bookingBranchId: branchId,
      originBranchId: branchId,
      destinationBranchId: fixtures.destination.id,

      consignorName: `Lifecycle ${label} Consignor`,
      consignorPhone: "9800000021",
      consignorAddress: "Plot 9, Sector 18",
      consignorCityId: fixtures.gurugram.id,
      consignorPincode: "122015",

      consigneeName: `Lifecycle ${label} Consignee`,
      consigneePhone: "9800000022",
      consigneeAddress: "44 Station Road",
      consigneeCityId: fixtures.jaipur.id,
      consigneePincode: "302013",

      packageCount,
      packageTypeId: fixtures.packageType.id,
      actualWeight: overrides.actualWeight ?? 24,
      goodsDescription: "Lifecycle verification — auto-generated",
      declaredValue: 8000,
      packages: Array.from({ length: packageCount }, () => ({
        lengthCm: 30,
        breadthCm: 30,
        heightCm: 20,
      })),
      paymentType: "PAID",
      pickupRequired: overrides.pickupRequired ?? true,
    },
    actor,
  );

  if (!result.ok) throw new Error(`Booking ${label} failed: ${result.error}`);
  return result;
}

/** Puts a consignment in our hands, which is where several rules change. */
async function collect(shipmentId: string, branchId: string, actor: SessionUser) {
  const event = await appendShipmentEvent(
    {
      shipmentId,
      eventType: "PICKUP_COMPLETED",
      branchId,
      idempotencyKey: randomUUID(),
      payload: { source: "verify-shipment-lifecycle" },
    },
    actor,
  );
  if (!event.ok) throw new Error(`Could not collect the consignment: ${event.error}`);
}

async function run() {
  const admin = await loadActor(process.env.SMOKE_ADMIN_MOBILE ?? "9999999999");
  const branch =
    admin.primaryBranch ??
    (await prisma.branch.findFirstOrThrow({
      where: { isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }));

  console.log(`  acting as ${admin.name} (${admin.mobile}) at ${branch.code}\n`);

  // ── Who may do what ───────────────────────────────────────
  console.log("Who may do what");

  check(
    "the administrator may correct a status",
    admin.permissions.has("shipment.correct_status"),
  );
  check("and may cancel a booking", admin.permissions.has("shipment.cancel"));
  check("and may hold one", admin.permissions.has("shipment.hold"));

  // Somebody who runs operations but does not hold the escape hatch. The
  // seeded roles give `shipment.correct_status` to nobody but SUPER_ADMIN,
  // which is the point of the permission.
  const operations = await prisma.user.findFirst({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      mobile: { not: admin.mobile },
      roles: { some: { role: { code: { in: ["OPS_MANAGER", "BRANCH_MANAGER"] } } } },
    },
    select: { mobile: true },
  });

  const manager = operations ? await loadActor(operations.mobile) : null;

  if (!manager) {
    console.log("  [SKIP] no operations manager to try a correction with");
  } else {
    check(
      `${manager.name} may cancel and hold`,
      manager.permissions.has("shipment.cancel") && manager.permissions.has("shipment.hold"),
    );
    check(
      "but may not correct a status",
      !manager.permissions.has("shipment.correct_status"),
      manager.permissions.has("shipment.correct_status") ? "THEY CAN" : "",
    );
  }

  const fixtures = await loadFixtures(branch.id);

  const [cancellation, wrongDrawer, hold, correction] = await Promise.all([
    prisma.reasonCode.findFirstOrThrow({
      where: { category: "CANCELLATION", isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true },
    }),
    prisma.reasonCode.findFirstOrThrow({
      where: { category: "DELIVERY_FAILURE", isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true },
    }),
    prisma.reasonCode.findFirstOrThrow({
      where: { category: "HOLD", isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true },
    }),
    prisma.reasonCode.findFirstOrThrow({
      where: { category: "STATUS_CORRECTION", isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true },
    }),
  ]);

  // ── A booking that should not exist ───────────────────────
  console.log("\nCancelling a booking that should not exist");

  const wrong = await book("A", branch.id, fixtures, admin);
  check("a consignment was booked", true, wrong.lrNumber);
  check(
    "with a collection raised behind it",
    Boolean(wrong.pickupNumber),
    wrong.pickupNumber ?? "none",
  );

  await refuses("cancelling without a reason is refused", wrong.shipmentId, () =>
    cancelShipment({ shipmentId: wrong.shipmentId, reasonCodeId: "" }, admin),
  );

  await refuses(
    "a reason from the wrong drawer is refused",
    wrong.shipmentId,
    () =>
      cancelShipment(
        { shipmentId: wrong.shipmentId, reasonCodeId: wrongDrawer.id },
        admin,
      ),
  );

  const cancelled = await cancelShipment(
    {
      shipmentId: wrong.shipmentId,
      reasonCodeId: cancellation.id,
      remarks: "Duplicate of the consignment booked minutes earlier.",
    },
    admin,
  );
  check("the cancellation is accepted", cancelled.ok, cancelled.ok ? "" : cancelled.error);

  const afterCancel = await prisma.shipment.findUniqueOrThrow({
    where: { id: wrong.shipmentId },
    select: { currentStatus: true, cancelledAt: true, cancelReasonId: true },
  });
  check(
    "the consignment reads as cancelled",
    afterCancel.currentStatus === "CANCELLED",
    afterCancel.currentStatus,
  );
  check(
    "with the reason and the moment on the record",
    afterCancel.cancelReasonId === cancellation.id && afterCancel.cancelledAt !== null,
    cancellation.code,
  );

  const collections = await prisma.pickupRequest.findMany({
    where: { shipmentId: wrong.shipmentId },
    select: { status: true },
  });
  check(
    "the collection was called off with it",
    collections.length > 0 && collections.every((p) => p.status === "CANCELLED"),
    collections.map((p) => p.status).join(", ") || "no pickup",
  );

  await refuses("cancelling it a second time is refused", wrong.shipmentId, () =>
    cancelShipment(
      { shipmentId: wrong.shipmentId, reasonCodeId: cancellation.id },
      admin,
    ),
  );

  // ── Once the goods are ours ───────────────────────────────
  console.log("\nCancelling once the goods are with us");

  const moved = await book("B", branch.id, fixtures, admin);
  await collect(moved.shipmentId, branch.id, admin);

  const collectedStatus = await prisma.shipment.findUniqueOrThrow({
    where: { id: moved.shipmentId },
    select: { currentStatus: true },
  });
  check(
    "the consignment was collected",
    collectedStatus.currentStatus === "PICKED_UP",
    collectedStatus.currentStatus,
  );

  await refuses(
    "a collected consignment cannot be cancelled",
    moved.shipmentId,
    () =>
      cancelShipment(
        { shipmentId: moved.shipmentId, reasonCodeId: cancellation.id },
        admin,
      ),
  );

  // ── Held at a branch ──────────────────────────────────────
  console.log("\nHolding freight at a branch");

  await refuses("a hold without a reason is refused", moved.shipmentId, () =>
    holdShipment({ shipmentId: moved.shipmentId, reasonCodeId: "" }, admin),
  );

  await refuses(
    "a cancellation reason cannot be used to hold",
    moved.shipmentId,
    () =>
      holdShipment(
        { shipmentId: moved.shipmentId, reasonCodeId: cancellation.id },
        admin,
      ),
  );

  const held = await holdShipment(
    {
      shipmentId: moved.shipmentId,
      reasonCodeId: hold.id,
      remarks: "Consignor's account is past terms — accounts asked for it to be stopped.",
    },
    admin,
  );
  check("the hold is accepted", held.ok, held.ok ? "" : held.error);

  const onHold = await prisma.shipment.findUniqueOrThrow({
    where: { id: moved.shipmentId },
    select: { isOnHold: true, holdReasonId: true, currentStatus: true },
  });
  check("the consignment reads as on hold", onHold.isOnHold);
  check("with the reason that stopped it", onHold.holdReasonId === hold.id, hold.code);
  check(
    "and has not moved — a hold is not a status",
    onHold.currentStatus === "PICKED_UP",
    onHold.currentStatus,
  );

  await refuses("holding it twice is refused", moved.shipmentId, () =>
    holdShipment({ shipmentId: moved.shipmentId, reasonCodeId: hold.id }, admin),
  );

  await refuses(
    "releasing without saying what changed is refused",
    moved.shipmentId,
    () => releaseHold({ shipmentId: moved.shipmentId, remarks: "" }, admin),
  );

  const released = await releaseHold(
    {
      shipmentId: moved.shipmentId,
      remarks: "Payment received against the outstanding invoice. Accounts confirmed release.",
    },
    admin,
  );
  check("the release is accepted", released.ok, released.ok ? "" : released.error);

  const offHold = await prisma.shipment.findUniqueOrThrow({
    where: { id: moved.shipmentId },
    select: { isOnHold: true, holdReasonId: true },
  });
  check(
    "the hold and its reason are cleared",
    !offHold.isOnHold && offHold.holdReasonId === null,
    `isOnHold=${offHold.isOnHold} reason=${offHold.holdReasonId ?? "null"}`,
  );

  await refuses("releasing a consignment that is not held is refused", moved.shipmentId, () =>
    releaseHold({ shipmentId: moved.shipmentId, remarks: "Nothing to release." }, admin),
  );

  // ── Correcting the booking ────────────────────────────────
  console.log("\nAmending a booking");

  const amendable = await book("C", branch.id, fixtures, admin, {
    packageCount: 3,
    actualWeight: 24,
  });

  await refuses("an amendment that changes nothing is refused", amendable.shipmentId, () =>
    amendBooking(
      { shipmentId: amendable.shipmentId, consigneeName: "Lifecycle C Consignee" },
      admin,
    ),
  );

  const amended = await amendBooking(
    {
      shipmentId: amendable.shipmentId,
      consigneeName: "Lifecycle C Consignee (corrected)",
      consigneePhone: "9800000099",
      consigneeAddress: "44 Station Road, second floor",
      packageCount: 5,
      actualWeight: 41,
      remarks: "Consignor rang — two more cartons and the weight was taken down wrong.",
    },
    admin,
  );
  check("the amendment is accepted", amended.ok, amended.ok ? "" : amended.error);
  check(
    "and names every field it touched",
    amended.ok &&
      ["consigneeName", "consigneePhone", "consigneeAddress", "packageCount", "actualWeight"].every(
        (field) => amended.changed.includes(field),
      ),
    amended.ok ? amended.changed.join(", ") : "",
  );

  const afterAmend = await prisma.shipment.findUniqueOrThrow({
    where: { id: amendable.shipmentId },
    select: {
      consigneeName: true,
      consigneePhone: true,
      packageCount: true,
      actualWeight: true,
      chargeableWeight: true,
      packages: { orderBy: { sequence: "asc" }, select: { sequence: true, barcode: true } },
    },
  });

  check(
    "the consignee is corrected",
    afterAmend.consigneeName.endsWith("(corrected)") &&
      afterAmend.consigneePhone === "9800000099",
    `${afterAmend.consigneeName} · ${afterAmend.consigneePhone}`,
  );
  check(
    "the package rows follow the count",
    afterAmend.packageCount === 5 && afterAmend.packages.length === 5,
    `${afterAmend.packages.length} rows for ${afterAmend.packageCount} packages`,
  );
  check(
    "the new boxes carry their own barcodes",
    afterAmend.packages.at(-1)?.barcode === `${amendable.lrNumber}-05`,
    afterAmend.packages.map((p) => p.barcode).join(" "),
  );
  check(
    "the chargeable weight was recomputed, not left behind",
    Number(afterAmend.actualWeight) === 41 && Number(afterAmend.chargeableWeight) >= 41,
    `actual ${Number(afterAmend.actualWeight)} kg, chargeable ${Number(afterAmend.chargeableWeight)} kg`,
  );

  const amendEvent = await prisma.shipmentEvent.findFirstOrThrow({
    where: { shipmentId: amendable.shipmentId, eventType: "BOOKING_AMENDED" },
    orderBy: { recordedAt: "desc" },
    select: { payload: true, resultingStatus: true },
  });
  const payload = amendEvent.payload as {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  } | null;

  check(
    "the event carries the old value beside the new",
    String(payload?.before?.consigneePhone) === "9800000022" &&
      String(payload?.after?.consigneePhone) === "9800000099",
    `${payload?.before?.consigneePhone} → ${payload?.after?.consigneePhone}`,
  );
  check(
    "and did not move the status",
    amendEvent.resultingStatus === null,
    String(amendEvent.resultingStatus),
  );

  console.log("\nAmending once the goods are with us");

  await collect(amendable.shipmentId, branch.id, admin);

  await refuses("the weight cannot be amended after collection", amendable.shipmentId, () =>
    amendBooking({ shipmentId: amendable.shipmentId, actualWeight: 60 }, admin),
  );

  await refuses("nor the package count", amendable.shipmentId, () =>
    amendBooking({ shipmentId: amendable.shipmentId, packageCount: 9 }, admin),
  );

  await refuses("nor the address the van already went to", amendable.shipmentId, () =>
    amendBooking(
      { shipmentId: amendable.shipmentId, consignorAddress: "Somewhere else entirely" },
      admin,
    ),
  );

  const stillAmendable = await amendBooking(
    {
      shipmentId: amendable.shipmentId,
      consigneePhone: "9800000098",
      remarks: "Consignee gave a different number for the delivery call.",
    },
    admin,
  );
  check(
    "but the consignee's phone still can be — that is how the box arrives",
    stillAmendable.ok,
    stillAmendable.ok ? stillAmendable.changed.join(", ") : stillAmendable.error,
  );

  const untouchedWeight = await prisma.shipment.findUniqueOrThrow({
    where: { id: amendable.shipmentId },
    select: { actualWeight: true, packageCount: true },
  });
  check(
    "and the refused figures are exactly as they were",
    Number(untouchedWeight.actualWeight) === 41 && untouchedWeight.packageCount === 5,
    `${Number(untouchedWeight.actualWeight)} kg, ${untouchedWeight.packageCount} packages`,
  );

  // ── The escape hatch ──────────────────────────────────────
  console.log("\nCorrecting a status");

  if (manager) {
    await refuses(
      "an operations manager cannot correct a status",
      amendable.shipmentId,
      () =>
        correctShipmentStatus(
          {
            shipmentId: amendable.shipmentId,
            correctedTo: "RECEIVED_AT_ORIGIN",
            reasonCodeId: correction.id,
            remarks: "The scan at the dock was made against the wrong consignment note.",
          },
          manager,
        ),
    );
  }

  await refuses("a correction with no explanation is refused", amendable.shipmentId, () =>
    correctShipmentStatus(
      {
        shipmentId: amendable.shipmentId,
        correctedTo: "RECEIVED_AT_ORIGIN",
        reasonCodeId: correction.id,
        remarks: "typo",
      },
      admin,
    ),
  );

  await refuses("a correction with no reason code is refused", amendable.shipmentId, () =>
    correctShipmentStatus(
      {
        shipmentId: amendable.shipmentId,
        correctedTo: "RECEIVED_AT_ORIGIN",
        reasonCodeId: "",
        remarks: "The scan at the dock was made against the wrong consignment note.",
      },
      admin,
    ),
  );

  await refuses("a correction cannot assert a delivery", amendable.shipmentId, () =>
    correctShipmentStatus(
      {
        shipmentId: amendable.shipmentId,
        correctedTo: "DELIVERED",
        reasonCodeId: correction.id,
        remarks: "The consignee says they have it, so mark it delivered.",
      },
      admin,
    ),
  );

  await refuses("nor a status the consignment is already in", amendable.shipmentId, () =>
    correctShipmentStatus(
      {
        shipmentId: amendable.shipmentId,
        correctedTo: "PICKED_UP",
        reasonCodeId: correction.id,
        remarks: "It is already picked up, so this changes nothing at all.",
      },
      admin,
    ),
  );

  const corrected = await correctShipmentStatus(
    {
      shipmentId: amendable.shipmentId,
      correctedTo: "RECEIVED_AT_ORIGIN",
      reasonCodeId: correction.id,
      remarks: "The inbound scan at the origin dock went onto the wrong LR. This one is here.",
    },
    admin,
  );
  check("the correction is accepted", corrected.ok, corrected.ok ? "" : corrected.error);
  check(
    "and moved the consignment where it was told to",
    corrected.ok &&
      corrected.previousStatus === "PICKED_UP" &&
      corrected.currentStatus === "RECEIVED_AT_ORIGIN",
    corrected.ok ? `${corrected.previousStatus} → ${corrected.currentStatus}` : "",
  );

  const correctionEvent = await prisma.shipmentEvent.findFirstOrThrow({
    where: { shipmentId: amendable.shipmentId, eventType: "STATUS_CORRECTED" },
    orderBy: { recordedAt: "desc" },
    select: { resultingStatus: true, reasonCodeId: true, remarks: true, userId: true, payload: true },
  });
  const correctionPayload = correctionEvent.payload as { correctedFrom?: string } | null;

  check(
    "the timeline names the person, the reason, the explanation and both statuses",
    correctionEvent.userId === admin.id &&
      correctionEvent.reasonCodeId === correction.id &&
      Boolean(correctionEvent.remarks) &&
      correctionEvent.resultingStatus === "RECEIVED_AT_ORIGIN" &&
      correctionPayload?.correctedFrom === "PICKED_UP",
    `${correctionPayload?.correctedFrom} → ${correctionEvent.resultingStatus}`,
  );

  // The one thing in the product that reaches into a terminal status.
  const revived = await correctShipmentStatus(
    {
      shipmentId: wrong.shipmentId,
      correctedTo: "BOOKED",
      reasonCodeId: correction.id,
      remarks: "Cancelled in error — it was the other consignment that was the duplicate.",
    },
    admin,
  );
  check(
    "a cancelled consignment can be brought back",
    revived.ok,
    revived.ok ? `${revived.previousStatus} → ${revived.currentStatus}` : revived.error,
  );

  // ── The story each one tells ──────────────────────────────
  console.log("\nThe event log");

  const wrongTypes = await eventTypes(wrong.shipmentId);
  check(
    "the cancelled booking records the cancellation and the correction that undid it",
    wrongTypes.includes("CANCELLED") && wrongTypes.includes("STATUS_CORRECTED"),
    wrongTypes.join(", "),
  );

  const movedTypes = await eventTypes(moved.shipmentId);
  check(
    "the held consignment records the hold and its release",
    movedTypes.includes("HELD") && movedTypes.includes("HOLD_RELEASED"),
    movedTypes.join(", "),
  );
  check(
    "and nothing else — no refused attempt left a mark",
    movedTypes.filter((type) => type === "HELD").length === 1 &&
      movedTypes.filter((type) => type === "HOLD_RELEASED").length === 1,
    movedTypes.join(", "),
  );

  const amendTypes = await eventTypes(amendable.shipmentId);
  check(
    "the amended consignment records both amendments and one correction",
    amendTypes.filter((type) => type === "BOOKING_AMENDED").length === 2 &&
      amendTypes.filter((type) => type === "STATUS_CORRECTED").length === 1,
    amendTypes.join(", "),
  );

  for (const [label, shipmentId] of [
    ["cancelled", wrong.shipmentId],
    ["held", moved.shipmentId],
    ["amended", amendable.shipmentId],
  ] as const) {
    const replay = await replayStatus(shipmentId);
    check(
      `the ${label} consignment's stored status is what its log projects to`,
      replay.matches,
      `${replay.replayed} vs ${replay.stored}`,
    );
  }
}

async function main() {
  const tenant = await actingTenant();
  console.log(`\nShipment lifecycle — ${tenant.slug}\n`);
  await runWithTenant(tenant, () => run());
  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "PASS\n" : "FAIL\n");
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("\nThe lifecycle could not run:\n", error);
  await prisma.$disconnect();
  process.exit(1);
});
