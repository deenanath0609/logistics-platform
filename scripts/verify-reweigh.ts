/**
 * Does a hub weighing actually move the money?
 *
 *   npx tsx scripts/verify-reweigh.ts [tenant-subdomain]
 *
 * `captureRevisedWeight` was written with nothing calling it, which is the
 * same as not existing: a consignment declared at 5 kg and weighing 45 kg
 * was invoiced at 5. The hub weighment screen now calls it. This drives the
 * whole chain against the real database — book, weigh, and then check that
 * the price moved, a second calculation was stored, the booking one
 * survived, the timeline carries the event, and the customer was told.
 *
 * The outbox is deliberately left to the RUNNING SERVER's drain, for the
 * reason given in verify-notifications.ts: handlers live in the server
 * process, so a script that drains its own outbox proves nothing.
 */
import "dotenv/config";
import { basePrisma, prisma } from "../src/lib/prisma";
import {
  runWithTenant,
  tenantContextFor,
  type TenantContext,
} from "../src/lib/tenant";
import type { SessionUser } from "../src/lib/auth/session";
import { createBooking } from "../src/lib/shipment/booking";
import { captureRevisedWeight } from "../src/lib/hub/weight";
import { appendShipmentEvent } from "../src/lib/shipment/events";
import { dispatchEvent } from "../src/lib/notifications/dispatch";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForOutboxIdle(seconds = 25): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    await sleep(1000);
    const busy = await prisma.outboxEvent.count({
      where: { status: { in: ["PENDING", "PROCESSING"] } },
    });
    if (busy === 0) {
      await sleep(500);
      return true;
    }
  }
  return false;
}

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
async function actingTenant(): Promise<TenantContext> {
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
  return tenant;
}

async function run() {
  // Unique per tenant, not per platform — the tenant filter supplies the
  // other half of the key.
  const user = await prisma.user.findFirstOrThrow({
    where: { mobile: "9999999999" },
    include: {
      primaryBranch: { select: { id: true, code: true, name: true } },
      roles: {
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      },
    },
  });

  const permissions = new Set<string>();
  for (const link of user.roles) {
    for (const rp of link.role.permissions) permissions.add(rp.permission.code);
  }

  check(
    "the owner role carries weight.capture",
    permissions.has("weight.capture"),
    permissions.has("weight.capture") ? "" : "nobody can weigh anything",
  );

  const actor: SessionUser = {
    id: user.id,
    orgId: user.orgId,
    name: user.name,
    mobile: user.mobile,
    email: user.email,
    isFieldUser: user.isFieldUser,
    mustChangePassword: user.mustChangePassword,
    primaryBranch: user.primaryBranch,
    roles: [],
    permissions,
    scope: "NETWORK",
    branchIds: null,
  };

  const [origin, hub, service, gurugram, jaipur] = await Promise.all([
    prisma.branch.findFirstOrThrow({ where: { code: "BR-GGN" } }),
    prisma.branch.findFirstOrThrow({ where: { code: "HUB-JAI" } }),
    prisma.serviceType.findFirstOrThrow({ where: { code: "PTL-EXP" } }),
    prisma.city.findFirstOrThrow({ where: { code: "GGN" } }),
    prisma.city.findFirstOrThrow({ where: { code: "JAI" } }),
  ]);

  // Booked light, on the consignor's word.
  const booking = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: service.id,
      bookingBranchId: origin.id,
      originBranchId: origin.id,
      destinationBranchId: hub.id,
      consignorName: "Reweigh Probe",
      consignorPhone: "9811100020",
      consignorEmail: "reweigh@example.test",
      consignorAddress: "Plot 14, Udyog Vihar",
      consignorCityId: gurugram.id,
      consignorPincode: "122015",
      consigneeName: "Reweigh Probe Receiver",
      consigneePhone: "9811100021",
      consigneeAddress: "22 Vaishali Nagar",
      consigneeCityId: jaipur.id,
      consigneePincode: "302013",
      packageCount: 2,
      actualWeight: 5,
      goodsDescription: "Reweigh probe — auto-generated",
      paymentType: "PAID",
    },
    actor,
  );

  check("booking succeeded", booking.ok, booking.ok ? booking.lrNumber : booking.error);
  if (!booking.ok) {
    await prisma.$disconnect();
    process.exit(1);
  }

  const booked = await prisma.shipment.findUniqueOrThrow({
    where: { id: booking.shipmentId },
    select: { chargeableWeight: true, chargesTotal: true, grandTotal: true },
  });

  console.log(
    `\n  booked at ${booked.chargeableWeight} kg, ₹${booked.grandTotal}\n`,
  );

  check(
    "the booking priced against the published tariff",
    Number(booked.grandTotal) > 0,
    "a zero here means no rate card resolved",
  );

  // ── A consignment still on the road cannot be weighed ──────
  const premature = await captureRevisedWeight(
    { shipmentId: booking.shipmentId, branchId: hub.id, actualWeight: 45 },
    actor,
  );

  check(
    "weighing a consignment that has not been received is refused",
    premature.ok === false,
    premature.ok ? "it was accepted" : premature.error,
  );

  const stillBooked = await prisma.shipment.findUniqueOrThrow({
    where: { id: booking.shipmentId },
    select: { chargeableWeight: true, grandTotal: true },
  });

  check(
    "and the refusal moved no money",
    Number(stillBooked.grandTotal) === Number(booked.grandTotal) &&
      Number(stillBooked.chargeableWeight) === Number(booked.chargeableWeight),
    `${stillBooked.chargeableWeight} kg, ₹${stillBooked.grandTotal}`,
  );

  // Into the network, the way a real consignment gets there.
  for (const step of ["PICKUP_COMPLETED", "INBOUND_SCAN"] as const) {
    const moved = await appendShipmentEvent(
      { shipmentId: booking.shipmentId, eventType: step, branchId: origin.id },
      actor,
    );
    check(`${step} accepted`, moved.ok, moved.ok ? "" : moved.error);
  }

  await waitForOutboxIdle();
  const notificationsBefore = await prisma.notificationLog.count({
    where: { eventType: "shipment.reweighed" },
  });

  // ── The weighing ──────────────────────────────────────────
  const weighed = await captureRevisedWeight(
    {
      shipmentId: booking.shipmentId,
      branchId: hub.id,
      actualWeight: 45,
      reference: "WB-PROBE-001",
    },
    actor,
  );

  check(
    "the weighing was accepted",
    weighed.ok,
    weighed.ok ? "" : weighed.error,
  );
  if (!weighed.ok) {
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(
    `  weighed ${weighed.previousChargeableWeight.toFixed(3)} → ` +
      `${weighed.revisedChargeableWeight.toFixed(3)} kg, ` +
      `₹${weighed.previousTotal.toFixed(2)} → ₹${weighed.revisedTotal.toFixed(2)} ` +
      `(${weighed.deltaPercent.toFixed(2)}%)\n`,
  );

  for (const warning of weighed.warnings) console.log(`    ! ${warning}`);

  check(
    "the price moved with the weight",
    weighed.revisedTotal.greaterThan(weighed.previousTotal),
    `₹${weighed.delta.toFixed(2)}`,
  );
  check(
    "a 9× weight is past tolerance",
    weighed.exceedsTolerance,
    `tolerance ${weighed.tolerancePercent.toFixed(2)}%`,
  );
  check(
    "an exception was opened",
    weighed.exceptionNumber !== null,
    weighed.exceptionNumber ?? "none",
  );

  // ── The stored evidence ───────────────────────────────────
  const calculations = await prisma.freightCalculation.findMany({
    where: { shipmentId: booking.shipmentId },
    orderBy: { createdAt: "asc" },
    select: { id: true, stage: true, grandTotal: true, chargeableWeight: true },
  });

  check(
    "the booking calculation was not overwritten",
    calculations.some(
      (c) => c.stage === "BOOKING" && Number(c.grandTotal) === Number(booked.grandTotal),
    ),
    calculations.map((c) => `${c.stage}:₹${c.grandTotal}`).join(" "),
  );
  check(
    "a second calculation was stored at INVOICE stage",
    calculations.some((c) => c.stage === "INVOICE" && c.id === weighed.calculationId),
  );

  const applied = await prisma.shipment.findUniqueOrThrow({
    where: { id: booking.shipmentId },
    select: { chargeableWeight: true, actualWeight: true, grandTotal: true },
  });

  check(
    "the shipment now bills on the weighed figure",
    Number(applied.chargeableWeight) === Number(weighed.revisedChargeableWeight),
    `${applied.chargeableWeight} kg, ₹${applied.grandTotal}`,
  );

  const event = await prisma.shipmentEvent.findFirst({
    where: { shipmentId: booking.shipmentId, eventType: "WEIGHT_CAPTURED" },
    orderBy: { recordedAt: "desc" },
  });

  check("the timeline carries WEIGHT_CAPTURED", event !== null);
  check(
    "the event carries the weighbridge reference",
    (event?.payload as Record<string, unknown> | null)?.reference === "WB-PROBE-001",
  );

  // Not checked here: the audit row. `recordAudit` reads request headers
  // for the IP and user agent, which do not exist in a script — it logs
  // "headers was called outside a request scope" and returns. That is a
  // property of this harness, not of the code path; the screen writes it.

  // Not invoiced, so there is nothing to debit — the invoice will simply
  // bill the revised figure. That is the correct outcome, not a failure.
  check(
    "no debit note on an uninvoiced consignment",
    weighed.debitNote.raised === false,
    weighed.debitNote.raised === false ? weighed.debitNote.reason : "one was raised",
  );

  // ── The customer ──────────────────────────────────────────
  console.log("\n  waiting for the server's drain…");
  const drained = await waitForOutboxIdle();
  check("the server drained the reweigh event", drained);

  const notificationsAfter = await prisma.notificationLog.findMany({
    where: { eventType: "shipment.reweighed" },
    orderBy: { queuedAt: "desc" },
    take: 6,
    select: {
      channel: true,
      status: true,
      recipient: true,
      body: true,
      template: { select: { code: true } },
    },
  });

  check(
    "the consignor was told about the revision",
    notificationsAfter.length > notificationsBefore,
    `${notificationsBefore} → ${notificationsAfter.length}`,
  );

  for (const row of notificationsAfter.slice(0, 3)) {
    console.log(
      `    ${row.channel.padEnd(9)} ${String(row.status).padEnd(10)} ` +
        `${row.recipient.padEnd(20)} ${row.template?.code ?? "—"}`,
    );
  }

  // ── The render ────────────────────────────────────────────
  // Re-dispatched in *this* process, not the server's. The server
  // registered its handlers at boot, so a change to the variable resolver
  // does not reach it until it restarts — a dev-only artifact that would
  // otherwise make a correct template look broken. Re-attempting a FAILED
  // row is explicitly allowed by rules.ts, so this is not a second send.
  const outboxRow = await prisma.outboxEvent.findFirst({
    where: { eventType: "shipment.reweighed", aggregateId: booking.shipmentId },
    orderBy: { createdAt: "desc" },
  });

  if (outboxRow) {
    await dispatchEvent({
      outboxId: outboxRow.id,
      eventType: outboxRow.eventType,
      aggregate: outboxRow.aggregate,
      aggregateId: outboxRow.aggregateId,
      payload: (outboxRow.payload ?? {}) as Record<string, unknown>,
    });
  }

  const final = await prisma.notificationLog.findFirst({
    where: { eventType: "shipment.reweighed", shipmentId: booking.shipmentId },
    orderBy: { queuedAt: "desc" },
    select: { body: true, subject: true, status: true, error: true },
  });

  const rendered = `${final?.subject ?? ""}\n${final?.body ?? ""}`;

  check(
    "the message renders every placeholder",
    rendered.trim().length > 0 && !rendered.includes("{{"),
    rendered.includes("{{")
      ? (final?.error ?? rendered.slice(0, 160))
      : "",
  );

  if (final?.body) {
    console.log(
      "\n" +
        final.body
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
    );
  }

  // ── Idempotency ───────────────────────────────────────────
  // The offline queue retries. The same physical weighing must not bill twice.
  const replay = await captureRevisedWeight(
    {
      shipmentId: booking.shipmentId,
      branchId: hub.id,
      actualWeight: 45,
      reference: "WB-PROBE-001",
      idempotencyKey: "probe-weighing-1",
    },
    actor,
  );

  const eventsNow = await prisma.shipmentEvent.count({
    where: { shipmentId: booking.shipmentId, eventType: "WEIGHT_CAPTURED" },
  });

  check(
    "re-weighing to the same figure does not move the price again",
    replay.ok && replay.delta.abs().lessThan(0.01),
    replay.ok ? `₹${replay.delta.toFixed(2)}` : replay.error,
  );
  check(
    "and does not raise a second tolerance exception",
    replay.ok && replay.exceedsTolerance === false,
  );

  console.log(`\n  WEIGHT_CAPTURED events on the timeline: ${eventsNow}`);

  console.log(
    failures === 0
      ? "\nWeighment moves the money.\n"
      : `\n${failures} failed.\n`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  const tenant = await actingTenant();
  console.log(
    "\nHub weighment → re-rate → debit note → notification · " +
      `acting as ${tenant.slug} (${tenant.subdomain})\n`,
  );
  await runWithTenant(tenant, run);
}

main().catch(async (error) => {
  console.error("\nCrashed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
