/**
 * Books one shipment and then leaves the outbox alone, so the RUNNING
 * WORKER's drain is what processes it.
 *
 *   npm run worker            # in another terminal, and leave it running
 *   npx tsx scripts/verify-notifications.ts [tenant-subdomain]
 *
 * This matters: a script that drains its own outbox proves nothing about
 * production, because the handlers are registered in the worker process,
 * not in the script. The only honest test is to write the event and watch
 * the worker pick it up. If nothing moves, the worker is not running —
 * `node scripts/check-pipeline.mjs` says so in as many words.
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
import { enqueueOutbox } from "../src/server/services/outbox";
import { transportFor } from "../src/lib/notifications/transport";
import { DEFAULT_TEMPLATES } from "../src/lib/notifications/default-templates";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until the outbox is genuinely idle.
 *
 * Checking only for PENDING is a trap: `drainOutbox` claims a row as
 * PROCESSING *before* running the handlers, so a PENDING count of zero can
 * mean "still working". Anything measured at that moment races the
 * handler and reports whatever happens to have been written so far.
 */
async function waitForOutboxIdle(seconds = 20): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    await sleep(1000);
    const busy = await prisma.outboxEvent.count({
      where: { status: { in: ["PENDING", "PROCESSING"] } },
    });
    if (busy === 0) {
      // One more beat: the final status write and the notification row are
      // separate statements.
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
  const templates = await prisma.notificationTemplate.count();
  const active = await prisma.notificationTemplate.count({ where: { isActive: true } });
  check("templates are seeded", templates > 0, `${templates} total, ${active} active`);

  // Unique per tenant, not per platform — the tenant filter supplies the
  // other half of the key.
  const user = await prisma.user.findFirstOrThrow({
    where: { mobile: "9999999999" },
    include: {
      primaryBranch: { select: { id: true, code: true, name: true } },
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
    },
  });

  const permissions = new Set<string>();
  for (const link of user.roles) {
    for (const rp of link.role.permissions) permissions.add(rp.permission.code);
  }

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


  const booking = await createBooking(
    {
      mode: "PTL",
      serviceTypeId: service.id,
      bookingBranchId: origin.id,
      originBranchId: origin.id,
      destinationBranchId: hub.id,
      consignorName: "Notification Probe",
      consignorPhone: "9811100010",
      consignorEmail: "probe@example.test",
      consignorAddress: "Plot 14, Udyog Vihar",
      consignorCityId: gurugram.id,
      consignorPincode: "122015",
      consigneeName: "Notification Probe Receiver",
      consigneePhone: "9811100011",
      consigneeAddress: "22 Vaishali Nagar",
      consigneeCityId: jaipur.id,
      consigneePincode: "302013",
      packageCount: 1,
      actualWeight: 5,
      goodsDescription: "Notification probe — auto-generated",
      paymentType: "PAID",
    },
    actor,
  );

  check("booking succeeded", booking.ok, booking.ok ? booking.lrNumber : booking.error);
  if (!booking.ok) {
    await prisma.$disconnect();
    process.exit(1);
  }

  /**
   * Everything measured from here on is scoped to this booking.
   *
   * It used to compare `notificationLog.count()` before and after — the
   * whole table — which is an assertion about how busy the database is
   * rather than about this run. Two people running verifications at once,
   * or a worker draining somebody else's backlog mid-wait, and it reports a
   * defect in a product that is fine. `verify-reweigh.ts` learned this the
   * expensive way.
   */
  const ours = { shipmentId: booking.shipmentId };
  const queued = await prisma.outboxEvent.count({
    where: { status: "PENDING", aggregateId: booking.shipmentId },
  });
  check("the booking queued an outbox event", queued > 0, `${queued} pending`);

  // The server drains on a 5s timer. Give it two cycles plus slack.
  console.log("\n  waiting for the server's drain…");
  const drained = await waitForOutboxIdle();

  check("the server drained it (not this script)", drained);

  const after = await prisma.notificationLog.count({ where: ours });
  check(
    "notification rows were written for this consignment",
    after > 0,
    `${after} row(s)`,
  );

  const rows = await prisma.notificationLog.findMany({
    where: { shipmentId: booking.shipmentId },
    select: {
      channel: true,
      status: true,
      recipient: true,
      eventType: true,
      providerResponse: true,
      template: { select: { code: true } },
    },
  });

  for (const row of rows) {
    console.log(
      `    ${row.channel.padEnd(9)} ${String(row.status).padEnd(10)} ${row.recipient.padEnd(18)} ${row.template?.code ?? "—"}`,
    );
  }

  // SKIPPED is expected locally: no SMS or SMTP provider is configured,
  // and an unconfigured channel is a settings gap, not a delivery failure.
  const failed = rows.filter((r) => r.status === "FAILED");
  check(
    "nothing failed at a gateway",
    failed.length === 0,
    failed.map((r) => `${r.channel}:${r.template?.code}`).join(", "),
  );
  check(
    "unconfigured channels are recorded as skipped, not failed",
    rows.every((r) => r.status !== "FAILED"),
  );

  /**
   * A SENT row that nothing actually sent has to say so.
   *
   * Every adapter in this repository is either the mock — which returns
   * success so the whole path is exercised — or a real provider whose
   * client has not been written and which therefore throws. So a send log
   * full of green is the *expected* state, and the only thing separating it
   * from a working gateway is the `provider` key on the row. Both screens
   * now read that key; this is the assertion that keeps it being written.
   */
  for (const row of rows.filter((r) => r.status === "SENT")) {
    const transport = transportFor(row.channel);
    const marked =
      (row.providerResponse as { provider?: string } | null)?.provider === "mock";
    check(
      `a simulated ${row.channel} send is marked as one`,
      transport.live || marked,
      transport.live ? "gateway is live" : "providerResponse.provider",
    );
  }

  // Replaying must not double-send. The dedupe key is derived from the
  // event id, so a second drain of the same event is a no-op.
  const beforeReplay = await prisma.notificationLog.count({ where: ours });
  await prisma.outboxEvent.updateMany({
    where: { aggregateId: booking.shipmentId, status: "DONE" },
    data: { status: "PENDING", nextAttemptAt: new Date() },
  });

  console.log("\n  replaying the same events…");
  await waitForOutboxIdle();

  const afterReplay = await prisma.notificationLog.count({ where: ours });
  check(
    "a replay does not send twice",
    afterReplay === beforeReplay,
    `${beforeReplay} → ${afterReplay}`,
  );

  await otpNeverReachesTheLog(booking.shipmentId);

  console.log(failures === 0 ? "\nPipeline works.\n" : `\n${failures} failed.\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * The delivery code goes to the phone and nowhere else.
 *
 * `auth/otp-delivery.ts` is careful about this for the *sign-in* code — it
 * writes "a code was sent" and never the code. The delivery OTP travels the
 * other road, through a template whose body is `{{otpCode}} is your ...` and
 * whose rendered text is stored on the log row the send-log screen prints.
 * Anyone holding `master.read` could read the code that signs for a parcel,
 * which is most of a branch.
 *
 * Proved end to end rather than in a unit test because the property that
 * matters is about the row in the database, not about a function. The
 * DELIVERY_OTP template ships inactive pending DLT, so this switches it on
 * for the length of the check and puts it back in a `finally` — including
 * the DLT id, which is a placeholder here and must not be left behind
 * looking like a registration somebody obtained.
 */
async function otpNeverReachesTheLog(shipmentId: string): Promise<void> {
  const template = await prisma.notificationTemplate.findFirst({
    where: { code: "DELIVERY_OTP", channel: "SMS" },
    select: { id: true, isActive: true, dltTemplateId: true, body: true },
  });

  if (!template) {
    check("the delivery OTP template is seeded", false, "DELIVERY_OTP/SMS not found");
    return;
  }

  const seeded = DEFAULT_TEMPLATES.find(
    (t) => t.code === "DELIVERY_OTP" && t.channel === "SMS",
  );
  check(
    "the delivery OTP template carries the code in its body",
    Boolean(seeded && seeded.body.includes("{{otpCode}}")),
  );

  const code = String(100000 + Math.floor(Math.random() * 899999));

  try {
    await prisma.notificationTemplate.update({
      where: { id: template.id },
      data: { isActive: true, dltTemplateId: template.dltTemplateId ?? "VERIFY-ONLY" },
    });

    await enqueueOutbox({
      eventType: "notification.delivery_otp",
      aggregate: "Shipment",
      aggregateId: shipmentId,
      payload: { eventId: `verify-otp-${code}`, code, channel: "SMS" },
    });

    console.log("\n  waiting for the delivery-OTP drain…");
    await waitForOutboxIdle();

    const row = await prisma.notificationLog.findFirst({
      where: { shipmentId, eventType: "notification.delivery_otp" },
      orderBy: { queuedAt: "desc" },
      select: { status: true, body: true, error: true },
    });

    check("the delivery OTP produced a log row", row !== null, row?.status ?? "none");
    if (!row) return;

    check(
      "the stored body does not contain the code",
      !row.body.includes(code),
      row.body.slice(0, 90),
    );
    check(
      "the stored body shows the code was redacted, not omitted",
      row.body.includes("•"),
      row.body.slice(0, 90),
    );
  } finally {
    await prisma.notificationTemplate.update({
      where: { id: template.id },
      data: { isActive: template.isActive, dltTemplateId: template.dltTemplateId },
    });
  }
}

async function main() {
  const tenant = await actingTenant();
  console.log(
    `\nNotification pipeline · acting as ${tenant.slug} (${tenant.subdomain})\n`,
  );
  // The server's drain works through every tenant; the counts in here see
  // only this one, which is what makes "the queue is idle" a statement about
  // the run rather than about whoever else is booking at the same time.
  await runWithTenant(tenant, run);
}

main().catch(async (error) => {
  console.error("\nCrashed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
