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

  const before = await prisma.notificationLog.count();

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

  const queued = await prisma.outboxEvent.count({ where: { status: "PENDING" } });
  check("the booking queued an outbox event", queued > 0, `${queued} pending`);

  // The server drains on a 5s timer. Give it two cycles plus slack.
  console.log("\n  waiting for the server's drain…");
  const drained = await waitForOutboxIdle();

  check("the server drained it (not this script)", drained);

  const after = await prisma.notificationLog.count();
  check(
    "notification rows were written",
    after > before,
    `${before} → ${after}`,
  );

  const rows = await prisma.notificationLog.findMany({
    where: { shipmentId: booking.shipmentId },
    select: {
      channel: true,
      status: true,
      recipient: true,
      eventType: true,
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

  // Replaying must not double-send. The dedupe key is derived from the
  // event id, so a second drain of the same event is a no-op.
  const beforeReplay = await prisma.notificationLog.count();
  await prisma.outboxEvent.updateMany({
    where: { aggregateId: booking.shipmentId, status: "DONE" },
    data: { status: "PENDING", nextAttemptAt: new Date() },
  });

  console.log("\n  replaying the same events…");
  await waitForOutboxIdle();

  const afterReplay = await prisma.notificationLog.count();
  check(
    "a replay does not send twice",
    afterReplay === beforeReplay,
    `${beforeReplay} → ${afterReplay}`,
  );

  console.log(failures === 0 ? "\nPipeline works.\n" : `\n${failures} failed.\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
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
