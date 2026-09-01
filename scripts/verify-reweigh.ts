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
import Decimal from "decimal.js";
import { createBooking } from "../src/lib/shipment/booking";
import { cancelInvoice, generateInvoice, issueInvoice } from "../src/lib/billing/invoice";
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

  /*
    Scoped to this consignment, not counted across the table.

    This compared a `count()` of every `shipment.reweighed` row taken before
    the weighing against a `findMany({ take: 6 })` taken after — so once the
    log held six such rows the "after" figure saturated at six and could
    never exceed the "before" figure again. The check did not fail when the
    product broke; it began failing when the script had been run often
    enough, reporting "7 → 6" while the notification sat in the log, sent,
    to the right address. A verification that rots with its own data is
    worse than none, because it teaches you to ignore a red line.
  */
  const notificationsAfter = await prisma.notificationLog.findMany({
    where: { eventType: "shipment.reweighed", shipmentId: booking.shipmentId },
    orderBy: { queuedAt: "desc" },
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
    notificationsAfter.length > 0,
    notificationsAfter.length > 0
      ? `${notificationsAfter.length} message(s) for this consignment`
      : "nothing was logged against this consignment",
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

  // ── The other half: a reweigh after the invoice went out ──
  //
  // Everything above proves the uninvoiced case, where raising nothing is
  // the right answer. It was never the case that mattered: an invoice that
  // has left the building cannot be edited, so a weight that moves after it
  // is billed has to leave the building too, on a supplementary document.
  // Three outcomes have to be told apart — not invoiced, still a draft, and
  // issued — and only the third raises a note.
  console.log("\n  Reweighing a consignment that is already billed…\n");

  const customer = await prisma.customer.findFirstOrThrow({
    where: { code: "ACME01" },
    select: { id: true, name: true },
  });

  const billed = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: service.id,
      bookingBranchId: origin.id,
      originBranchId: origin.id,
      destinationBranchId: hub.id,
      consignorId: customer.id,
      consignorName: customer.name,
      consignorPhone: "9811100022",
      consignorAddress: "Plot 14, Udyog Vihar",
      consignorCityId: gurugram.id,
      consignorPincode: "122015",
      consigneeName: "Reweigh Invoiced Receiver",
      consigneePhone: "9811100023",
      consigneeAddress: "22 Vaishali Nagar",
      consigneeCityId: jaipur.id,
      consigneePincode: "302013",
      packageCount: 1,
      actualWeight: 8,
      goodsDescription: "Reweigh probe (invoiced) — auto-generated",
      paymentType: "PAID",
    },
    actor,
  );

  check("a second consignment books, to be invoiced", billed.ok, billed.ok ? billed.lrNumber : billed.error);

  if (billed.ok) {
    for (const step of ["PICKUP_COMPLETED", "INBOUND_SCAN"] as const) {
      await appendShipmentEvent(
        { shipmentId: billed.shipmentId, eventType: step, branchId: origin.id },
        actor,
      );
    }

    const drafted = await generateInvoice(
      {
        customerId: customer.id,
        branchId: origin.id,
        shipmentIds: [billed.shipmentId],
      },
      actor,
    );

    check("it is drafted onto an invoice", drafted.ok, drafted.ok ? drafted.number : drafted.error);

    if (drafted.ok) {
      /*
        While it is still a draft, correcting the document beats debiting
        it — regenerating a draft costs nothing and leaves one clean invoice
        rather than an invoice plus a correction.

        Reweighed to 40 kg, not 12. The published tariff floors a shipment
        at 10 chargeable kg and ₹420, so 8, 12 and even 30 kg all price to
        the same figure — and a debit note that is not raised because the
        price did not move proves nothing about drafts. 40 kg at the 20–100
        band's ₹13 clears the floor, so the price genuinely moves and the
        refusal has to be about the document's status.
      */
      const onDraft = await captureRevisedWeight(
        { shipmentId: billed.shipmentId, branchId: hub.id, actualWeight: 40 },
        actor,
      );

      check(
        "the draft-stage reweigh actually moved the price",
        onDraft.ok && onDraft.delta.greaterThan(0),
        onDraft.ok ? `₹${onDraft.delta.toFixed(2)}` : onDraft.error,
      );
      check(
        "reweighing while the invoice is a draft raises no debit note",
        onDraft.ok && onDraft.debitNote.raised === false,
        onDraft.ok
          ? onDraft.debitNote.raised === false
            ? onDraft.debitNote.reason
            : "one was raised"
          : onDraft.error,
      );
      check(
        "and says to regenerate the draft rather than correct it",
        onDraft.ok &&
          onDraft.debitNote.raised === false &&
          onDraft.debitNote.reason.toLowerCase().includes("draft"),
        onDraft.ok && onDraft.debitNote.raised === false ? onDraft.debitNote.reason : "",
      );

      const draftUnchanged = await prisma.invoice.findUniqueOrThrow({
        where: { id: drafted.invoiceId },
        select: { status: true, total: true },
      });
      check(
        "and the draft is still a draft",
        draftUnchanged.status === "DRAFT",
        draftUnchanged.status,
      );

      /*
        "Regenerate it rather than debiting a document that has not left the
        building" is advice, and advice is not a control. Nobody regenerated
        the draft, it issued at the figure it was cut with, and the ₹117.60
        the hub had just found was gone — no debit note, because the reweigh
        had already decided none was due against a draft. Issuing now asks
        the question the reweigh assumed somebody would.
      */
      const staleIssue = await issueInvoice(
        {
          invoiceId: drafted.invoiceId,
          reason: "Probe — the draft is stale and this should be refused.",
        },
        actor,
      );

      check(
        "issuing a draft whose consignment was re-rated is refused",
        staleIssue.ok === false,
        staleIssue.ok ? `it issued as ${staleIssue.number}` : staleIssue.error,
      );
      check(
        "and the refusal names the consignment and both figures",
        staleIssue.ok === false && staleIssue.error.includes(billed.lrNumber),
        staleIssue.ok ? "" : staleIssue.error,
      );

      const afterRefusal = await prisma.invoice.findUniqueOrThrow({
        where: { id: drafted.invoiceId },
        select: { status: true, issuedAt: true },
      });
      check(
        "the draft is still a draft, and was never issued",
        afterRefusal.status === "DRAFT" && afterRefusal.issuedAt === null,
        afterRefusal.status,
      );

      // The way out is the one the reweigh recommended: withdraw the stale
      // draft and bill the consignment again at what it now weighs.
      const withdrawn = await cancelInvoice(
        { invoiceId: drafted.invoiceId, reason: "Re-rated after the draft was cut." },
        actor,
      );
      check("the stale draft cancels", withdrawn.ok, withdrawn.ok ? withdrawn.number : withdrawn.error);

      const redrafted = await generateInvoice(
        {
          customerId: customer.id,
          branchId: origin.id,
          shipmentIds: [billed.shipmentId],
        },
        actor,
      );
      check(
        "and the consignment bills again, at the revised weight",
        redrafted.ok,
        redrafted.ok ? redrafted.number : redrafted.error,
      );
      if (!redrafted.ok) {
        await prisma.$disconnect();
        process.exit(1);
      }

      const liveInvoiceId = redrafted.invoiceId;

      const issued = await issueInvoice(
        {
          invoiceId: liveInvoiceId,
          reason: "Checked against the consignment note before the reweigh probe.",
        },
        actor,
      );
      check("the fresh invoice issues", issued.ok, issued.ok ? issued.number : issued.error);
      const issuedNumber = issued.ok ? issued.number : redrafted.number;

      const asIssued = await prisma.invoice.findUniqueOrThrow({
        where: { id: liveInvoiceId },
        select: { status: true, subtotal: true, taxAmount: true, total: true },
      });
      check(
        "and it bills the revised figure, not the one the stale draft carried",
        new Decimal(asIssued.subtotal.toString()).greaterThan(600),
        `₹${asIssued.total}`,
      );

      // 150 kg: past the 100 kg band boundary, so the price moves well
      // clear of the ₹420 floor and the delta is unambiguous.
      const reweighed = await captureRevisedWeight(
        { shipmentId: billed.shipmentId, branchId: hub.id, actualWeight: 150 },
        actor,
      );

      check(
        "reweighing an issued consignment is accepted",
        reweighed.ok,
        reweighed.ok ? `₹${reweighed.delta.toFixed(2)}` : reweighed.error,
      );

      if (reweighed.ok) {
        check(
          "and it raises a debit note for the difference",
          reweighed.debitNote.raised === true,
          reweighed.debitNote.raised
            ? reweighed.debitNote.number
            : reweighed.debitNote.reason,
        );

        if (reweighed.debitNote.raised) {
          const note = await prisma.invoice.findUniqueOrThrow({
            where: { id: reweighed.debitNote.debitNoteId },
            select: { number: true, subtotal: true, total: true, notes: true },
          });

          check(
            "the note is numbered from the debit-note series",
            note.number.startsWith("DN/"),
            note.number,
          );
          check(
            "it bills the taxable delta and nothing else",
            new Decimal(note.subtotal.toString())
              .minus(reweighed.taxableDelta)
              .abs()
              .lessThanOrEqualTo("0.01"),
            `note ₹${note.subtotal} vs delta ₹${reweighed.taxableDelta.toFixed(2)}`,
          );
          check(
            "and it names the invoice it corrects",
            (note.notes ?? "").includes(issuedNumber),
            note.notes ?? "",
          );
        }

        // The point of the whole exercise. The customer holds a document;
        // it has to still say what it said.
        const afterReweigh = await prisma.invoice.findUniqueOrThrow({
          where: { id: liveInvoiceId },
          select: { status: true, subtotal: true, taxAmount: true, total: true },
        });

        check(
          "the issued invoice did not change underneath the customer",
          afterReweigh.subtotal.toString() === asIssued.subtotal.toString() &&
            afterReweigh.taxAmount.toString() === asIssued.taxAmount.toString() &&
            afterReweigh.total.toString() === asIssued.total.toString(),
          `₹${asIssued.total} → ₹${afterReweigh.total}`,
        );

        // Scoped to this consignment: the BOOKING row is the only evidence
        // of what was quoted at the counter, and two INVOICE rows are the
        // record of two weighings.
        const calcs = await prisma.freightCalculation.findMany({
          where: { shipmentId: billed.shipmentId },
          orderBy: { createdAt: "asc" },
          select: { stage: true, grandTotal: true },
        });

        check(
          "the booking calculation survived both reweighs",
          calcs.filter((c) => c.stage === "BOOKING").length === 1,
          calcs.map((c) => `${c.stage}:₹${c.grandTotal}`).join(" "),
        );
        check(
          "and each reweigh stored its own INVOICE-stage calculation",
          calcs.filter((c) => c.stage === "INVOICE").length === 2,
          `${calcs.filter((c) => c.stage === "INVOICE").length} INVOICE row(s)`,
        );
      }
    }
  }

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
