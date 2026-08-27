/**
 * Walks a real shipment through its whole life against the real database.
 *
 *   npx tsx scripts/verify-spine.ts
 *
 * This is the check that matters for Phase 2: it proves status is a
 * projection of the event log, that a failed delivery attempt behaves
 * correctly, that retries are idempotent, and that illegal transitions
 * are refused.
 *
 * It leaves its shipments behind on purpose — they are useful demo data
 * while the UI is being built, and the event log is append-only by
 * design, so tidying up would mean defeating the guarantee under test.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import type { SessionUser } from "../src/lib/auth/session";
import { createBooking } from "../src/lib/shipment/booking";
import { appendShipmentEvent, replayStatus } from "../src/lib/shipment/events";
import { drainOutbox } from "../src/server/services/outbox";
import type { ShipmentEventType, ShipmentStatus } from "../src/generated/prisma/client";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function loadActor(mobile: string): Promise<SessionUser> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { mobile },
    include: {
      primaryBranch: { select: { id: true, code: true, name: true } },
      roles: {
        include: {
          role: {
            include: { permissions: { include: { permission: true } } },
          },
        },
      },
    },
  });

  const permissions = new Set<string>();
  for (const link of user.roles) {
    for (const rp of link.role.permissions) permissions.add(rp.permission.code);
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
    scope: "NETWORK",
    branchIds: null,
  };
}

async function main() {
  console.log("\nShipment spine — end to end\n");

  const admin = await loadActor("9999999999");

  const [origin, hub, service, packageType, reasons] = await Promise.all([
    prisma.branch.findFirstOrThrow({ where: { code: "BR-GGN" } }),
    prisma.branch.findFirstOrThrow({ where: { code: "HUB-JAI" } }),
    prisma.serviceType.findFirstOrThrow({ where: { code: "PTL-EXP" } }),
    prisma.packageType.findFirstOrThrow({ where: { code: "CARTON" } }),
    prisma.reasonCode.findMany({
      where: { code: { in: ["DF-UNAVAILABLE", "CN-CUSTOMER"] } },
    }),
  ]);

  const deliveryFailure = reasons.find((r) => r.code === "DF-UNAVAILABLE")!;
  const cancelReason = reasons.find((r) => r.code === "CN-CUSTOMER")!;

  const gurugram = await prisma.city.findFirstOrThrow({ where: { code: "GGN" } });
  const jaipur = await prisma.city.findFirstOrThrow({ where: { code: "JAI" } });

  // ── Booking ───────────────────────────────────────────────
  console.log("Booking");
  const booking = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: service.id,
      bookingBranchId: origin.id,
      originBranchId: origin.id,
      destinationBranchId: hub.id,

      consignorName: "Verification Consignor",
      consignorPhone: "9811100001",
      consignorAddress: "Plot 14, Udyog Vihar Phase IV",
      consignorCityId: gurugram.id,
      consignorPincode: "122015",

      consigneeName: "Verification Consignee",
      consigneePhone: "9811100002",
      consigneeAddress: "22 Vaishali Nagar",
      consigneeCityId: jaipur.id,
      consigneePincode: "302013",

      packageCount: 3,
      packageTypeId: packageType.id,
      actualWeight: 12,
      goodsDescription: "Spine verification — auto-generated",
      declaredValue: 25000,
      // Light and bulky, so volumetric weight should win.
      packages: [
        { lengthCm: 100, breadthCm: 50, heightCm: 40 },
        { lengthCm: 50, breadthCm: 50, heightCm: 20 },
        { lengthCm: 40, breadthCm: 40, heightCm: 40 },
      ],
      paymentType: "PAID",
      pickupRequired: true,
    },
    admin,
  );

  if (!booking.ok) {
    check("booking succeeds", false, booking.error);
    process.exit(1);
  }

  check("booking succeeds", true, booking.lrNumber);
  check(
    "LR number matches the configured pattern",
    /^CL\d{12}$/.test(booking.lrNumber),
    booking.lrNumber,
  );
  check("one barcode per package", booking.barcodes.length === 3, booking.barcodes.join(", "));
  check(
    "barcodes are derived from the LR number",
    booking.barcodes[0] === `${booking.lrNumber}-01`,
  );

  const booked = await prisma.shipment.findUniqueOrThrow({
    where: { id: booking.shipmentId },
    include: { packages: true },
  });

  check("status starts at BOOKED", booked.currentStatus === "BOOKED");
  check("package rows created", booked.packages.length === 3);

  // Derived from the service's own divisor rather than hardcoded, so
  // changing PTL-EXP from 4500 to 5000 does not silently break the test.
  const expectedVolumetric =
    (100 * 50 * 40 + 50 * 50 * 20 + 40 * 40 * 40) / service.volumetricDivisor;
  const expectedChargeable = Math.ceil(expectedVolumetric / 0.5) * 0.5;

  check(
    "volumetric weight beat actual weight",
    Number(booked.chargeableWeight) === expectedChargeable,
    `actual ${booked.actualWeight}, volumetric ${booked.volumetricWeight}, chargeable ${booked.chargeableWeight} (divisor ${service.volumetricDivisor})`,
  );
  check(
    "the customer is billed on the heavier figure",
    Number(booked.chargeableWeight) > Number(booked.actualWeight),
  );

  // ── Lifecycle ─────────────────────────────────────────────
  console.log("\nLifecycle");

  const journey: Array<{
    event: ShipmentEventType;
    branchId?: string;
    reasonCodeId?: string;
    expect: ShipmentStatus;
  }> = [
    { event: "PICKUP_ASSIGNED", expect: "PICKUP_ASSIGNED" },
    { event: "PICKUP_COMPLETED", branchId: origin.id, expect: "PICKED_UP" },
    { event: "INBOUND_SCAN", branchId: origin.id, expect: "RECEIVED_AT_ORIGIN" },
    { event: "WEIGHT_CAPTURED", branchId: origin.id, expect: "RECEIVED_AT_ORIGIN" },
    { event: "SORTED", branchId: origin.id, expect: "PROCESSED" },
    { event: "MANIFEST_ADDED", expect: "MANIFESTED" },
    { event: "LOADED", expect: "MANIFESTED" },
    { event: "GATE_OUT", branchId: origin.id, expect: "DISPATCHED" },
    { event: "GEOFENCE_EXIT", expect: "IN_TRANSIT" },
    { event: "GATE_IN", branchId: hub.id, expect: "ARRIVED_AT_HUB" },
    { event: "INBOUND_SCAN", branchId: hub.id, expect: "RECEIVED_AT_HUB" },
    { event: "DELIVERY_ASSIGNED", branchId: hub.id, expect: "ASSIGNED_FOR_DELIVERY" },
    { event: "RUN_STARTED", branchId: hub.id, expect: "OUT_FOR_DELIVERY" },
  ];

  for (const step of journey) {
    const result = await appendShipmentEvent(
      {
        shipmentId: booking.shipmentId,
        eventType: step.event,
        branchId: step.branchId,
        reasonCodeId: step.reasonCodeId,
      },
      admin,
    );

    check(
      `${step.event} → ${step.expect}`,
      result.ok && result.currentStatus === step.expect,
      result.ok ? "" : result.error,
    );
  }

  // ── The failed attempt ────────────────────────────────────
  console.log("\nFailed delivery attempt");

  const attempt = await appendShipmentEvent(
    {
      shipmentId: booking.shipmentId,
      eventType: "DELIVERY_ATTEMPTED",
      branchId: hub.id,
      reasonCodeId: deliveryFailure.id,
      remarks: "Consignee not available",
    },
    admin,
  );

  check(
    "returns to the hub rather than a dead-end status",
    attempt.ok && attempt.currentStatus === "RECEIVED_AT_HUB",
    attempt.ok ? "" : attempt.error,
  );

  const afterAttempt = await prisma.shipment.findUniqueOrThrow({
    where: { id: booking.shipmentId },
  });
  check("attempt counter incremented", afterAttempt.attemptCount === 1);

  const attemptEvent = await prisma.shipmentEvent.findFirstOrThrow({
    where: { shipmentId: booking.shipmentId, eventType: "DELIVERY_ATTEMPTED" },
    include: { reasonCode: { select: { code: true } } },
  });
  check(
    "the failure reason is preserved on the event",
    attemptEvent.reasonCode?.code === "DF-UNAVAILABLE",
    attemptEvent.reasonCode?.code ?? "none recorded",
  );
  check(
    "the remarks the agent typed survive",
    attemptEvent.remarks === "Consignee not available",
  );

  // ── Second attempt succeeds ───────────────────────────────
  console.log("\nSecond attempt");
  for (const step of [
    { event: "DELIVERY_ASSIGNED" as const, expect: "ASSIGNED_FOR_DELIVERY" as const },
    { event: "RUN_STARTED" as const, expect: "OUT_FOR_DELIVERY" as const },
    { event: "DELIVERED" as const, expect: "DELIVERED" as const },
    { event: "POD_SYNCED" as const, expect: "POD_UPLOADED" as const },
    { event: "CLOSED" as const, expect: "CLOSED" as const },
  ]) {
    const result = await appendShipmentEvent(
      { shipmentId: booking.shipmentId, eventType: step.event, branchId: hub.id },
      admin,
    );
    check(
      `${step.event} → ${step.expect}`,
      result.ok && result.currentStatus === step.expect,
      result.ok ? "" : result.error,
    );
  }

  // ── Guarantees ────────────────────────────────────────────
  console.log("\nGuarantees");

  const replay = await replayStatus(booking.shipmentId);
  check(
    "replaying the event log reproduces the stored status",
    replay.matches,
    `stored ${replay.stored}, replayed ${replay.replayed}`,
  );

  const terminal = await appendShipmentEvent(
    { shipmentId: booking.shipmentId, eventType: "INBOUND_SCAN", branchId: hub.id },
    admin,
  );
  check(
    "a closed shipment accepts no further events",
    !terminal.ok,
    terminal.ok ? "it was accepted" : terminal.error,
  );

  // Idempotency: the offline queue will retry, and must not double-write.
  const key = `verify-idempotency-${booking.lrNumber}`;
  const first = await appendShipmentEvent(
    {
      shipmentId: booking.shipmentId,
      eventType: "STATUS_CORRECTED",
      reasonCodeId: (await prisma.reasonCode.findFirstOrThrow({ where: { code: "SC-MISSCAN" } })).id,
      remarks: "Idempotency probe",
      correctedTo: "CLOSED",
      idempotencyKey: key,
    },
    admin,
  );
  const repeat = await appendShipmentEvent(
    {
      shipmentId: booking.shipmentId,
      eventType: "STATUS_CORRECTED",
      reasonCodeId: (await prisma.reasonCode.findFirstOrThrow({ where: { code: "SC-MISSCAN" } })).id,
      remarks: "Idempotency probe",
      correctedTo: "CLOSED",
      idempotencyKey: key,
    },
    admin,
  );

  check("first write of a keyed event is accepted", first.ok && !first.duplicate);
  check(
    "a retry with the same key is recognised, not duplicated",
    repeat.ok && repeat.duplicate,
  );

  const eventCount = await prisma.shipmentEvent.count({
    where: { shipmentId: booking.shipmentId, idempotencyKey: key },
  });
  check("only one row exists for that key", eventCount === 1, `found ${eventCount}`);

  // ── Permissions ───────────────────────────────────────────
  console.log("\nPermissions");

  const clerk = await loadActor("9999900003"); // Booking Executive

  // Deliberately on a fresh BOOKED shipment attempting a legal transition:
  // testing this against the closed one would pass on the terminal-state
  // rule and prove nothing about permissions.
  const probe = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: service.id,
      bookingBranchId: origin.id,
      originBranchId: origin.id,
      destinationBranchId: hub.id,
      consignorName: "Permission Probe",
      consignorPhone: "9811100005",
      consignorAddress: "Plot 14, Udyog Vihar",
      consignorCityId: gurugram.id,
      consignorPincode: "122015",
      consigneeName: "Permission Probe",
      consigneePhone: "9811100006",
      consigneeAddress: "22 Vaishali Nagar",
      consigneeCityId: jaipur.id,
      consigneePincode: "302013",
      packageCount: 1,
      actualWeight: 5,
      goodsDescription: "Permission probe — auto-generated",
      paymentType: "PAID",
    },
    admin,
  );

  if (probe.ok) {
    const denied = await appendShipmentEvent(
      {
        shipmentId: probe.shipmentId,
        eventType: "CANCELLED",
        reasonCodeId: cancelReason.id,
      },
      clerk,
    );
    check(
      "a booking clerk cannot cancel a shipment",
      !denied.ok && denied.code === "FORBIDDEN",
      denied.ok ? "it was accepted" : denied.error,
    );

    const allowed = await appendShipmentEvent(
      {
        shipmentId: probe.shipmentId,
        eventType: "CANCELLED",
        reasonCodeId: cancelReason.id,
      },
      admin,
    );
    check(
      "the same action succeeds for someone who holds the permission",
      allowed.ok && allowed.currentStatus === "CANCELLED",
      allowed.ok ? "" : allowed.error,
    );
  } else {
    check("permission probe booking succeeds", false, probe.error);
  }

  // ── Cancellation is time-limited ──────────────────────────
  console.log("\nCancellation window");

  const second = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: service.id,
      bookingBranchId: origin.id,
      originBranchId: origin.id,
      destinationBranchId: hub.id,
      consignorName: "Cancellation Probe",
      consignorPhone: "9811100003",
      consignorAddress: "Plot 14, Udyog Vihar",
      consignorCityId: gurugram.id,
      consignorPincode: "122015",
      consigneeName: "Cancellation Probe",
      consigneePhone: "9811100004",
      consigneeAddress: "22 Vaishali Nagar",
      consigneeCityId: jaipur.id,
      consigneePincode: "302013",
      packageCount: 1,
      actualWeight: 5,
      goodsDescription: "Cancellation probe — auto-generated",
      paymentType: "PAID",
    },
    admin,
  );

  if (second.ok) {
    const cancelled = await appendShipmentEvent(
      {
        shipmentId: second.shipmentId,
        eventType: "CANCELLED",
        reasonCodeId: cancelReason.id,
      },
      admin,
    );
    check(
      "a booked shipment can be cancelled",
      cancelled.ok && cancelled.currentStatus === "CANCELLED",
      cancelled.ok ? "" : cancelled.error,
    );
    check(
      "two bookings received different LR numbers",
      second.lrNumber !== booking.lrNumber,
      `${booking.lrNumber} vs ${second.lrNumber}`,
    );
  } else {
    check("second booking succeeds", false, second.error);
  }

  // ── Outbox ────────────────────────────────────────────────
  console.log("\nOutbox");

  const pendingBefore = await prisma.outboxEvent.count({ where: { status: "PENDING" } });
  check("events were queued for downstream delivery", pendingBefore > 0, `${pendingBefore} pending`);

  const drained = await drainOutbox(200);
  check("drain processes them without error", drained.failed === 0, `${drained.processed} processed`);

  const pendingAfter = await prisma.outboxEvent.count({ where: { status: "PENDING" } });
  check("queue is empty afterwards", pendingAfter === 0, `${pendingAfter} left`);

  // ── Timeline ──────────────────────────────────────────────
  const events = await prisma.shipmentEvent.findMany({
    where: { shipmentId: booking.shipmentId },
    orderBy: { occurredAt: "asc" },
    select: { eventType: true, resultingStatus: true },
  });

  console.log(`\nTimeline for ${booking.lrNumber} — ${events.length} events`);
  for (const event of events) {
    console.log(
      `  ${event.eventType.padEnd(20)} ${event.resultingStatus ?? "(no status change)"}`,
    );
  }

  console.log(
    failures === 0
      ? "\nAll checks passed.\n"
      : `\n${failures} check(s) failed.\n`,
  );

  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("\nVerification crashed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
