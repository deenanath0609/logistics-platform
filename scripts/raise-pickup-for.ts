/**
 * Raises a collection for a consignment that was booked without one.
 *
 *   npx tsx scripts/raise-pickup-for.ts CL202608310001 [--assign 9999900007]
 *
 * Booking raises its own pickup now, but only for consignments booked after
 * that landed — and only when "Needs pickup" was left on. A consignor who
 * said they would drop it at the counter and then rang to ask for a van is
 * an ordinary Tuesday, and until the operations screen grows a create
 * control there is no way to serve them.
 *
 * So this is a stopgap with a short life, and it is written as one: it takes
 * an LR number, copies the consignor's own details off the consignment
 * exactly as `createBooking` does, and stops if a pickup already exists
 * rather than raising a second van to the same door.
 */
import "dotenv/config";
import { basePrisma, prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor } from "../src/lib/tenant";
import { nextNumber } from "../src/lib/numbering/number-series";
import { appendShipmentEvent } from "../src/lib/shipment/events";
import type { SessionUser } from "../src/lib/auth/session";

const args = process.argv.slice(2);
const lrNumber = args.find((a) => !a.startsWith("--"));
const assignTo = args.includes("--assign")
  ? args[args.indexOf("--assign") + 1]
  : null;
const subdomain =
  (args.includes("--tenant") ? args[args.indexOf("--tenant") + 1] : null) ??
  "city-logistics";

if (!lrNumber) {
  console.error("Give the LR number:  npx tsx scripts/raise-pickup-for.ts CL2026...");
  process.exit(2);
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
    roles: user.roles.map((r) => ({ code: r.role.code, name: r.role.name, scope: r.role.scope })),
    permissions,
    scope: "NETWORK",
    branchIds: null,
  };
}

async function main() {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain }, { slug: subdomain }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${subdomain}" is closed.`);

  await runWithTenant(tenant, async () => {
    const shipment = await prisma.shipment.findFirstOrThrow({
      where: { lrNumber, deletedAt: null },
      select: {
        id: true,
        lrNumber: true,
        bookingBranchId: true,
        consignorId: true,
        consignorName: true,
        consignorPhone: true,
        consignorAddress: true,
        consignorCityId: true,
        consignorPincode: true,
        packageCount: true,
        actualWeight: true,
        goodsDescription: true,
        currentStatus: true,
        bookingBranch: { select: { code: true } },
      },
    });

    const existing = await prisma.pickupRequest.findFirst({
      where: { shipmentId: shipment.id },
      select: { number: true, status: true },
    });

    if (existing) {
      console.log(
        `  ${shipment.lrNumber} already has ${existing.number} (${existing.status}). Nothing to do.`,
      );
      return;
    }

    const admin = await loadActor(process.env.SMOKE_ADMIN_MOBILE ?? "9999999999");

    const request = await prisma.pickupRequest.create({
      data: {
        orgId: org.id,
        number: await nextNumber({ document: "PICKUP" }),
        branchId: shipment.bookingBranchId,
        shipmentId: shipment.id,
        customerId: shipment.consignorId,
        contactName: shipment.consignorName,
        phone: shipment.consignorPhone,
        address: shipment.consignorAddress,
        cityId: shipment.consignorCityId,
        pincode: shipment.consignorPincode,
        requestedDate: new Date(),
        slot: "ANYTIME",
        expectedPackages: shipment.packageCount,
        expectedWeight: shipment.actualWeight,
        goodsDescription: shipment.goodsDescription,
        createdById: admin.id,
      },
    });

    console.log(
      `  raised ${request.number} at ${shipment.bookingBranch.code} for ${shipment.lrNumber}`,
    );

    if (!assignTo) {
      console.log("  left unassigned — assign it from /pickups");
      return;
    }

    const executive = await prisma.user.findFirstOrThrow({
      where: { mobile: assignTo, isFieldUser: true, status: "ACTIVE" },
      select: { id: true, name: true, primaryBranch: { select: { code: true } } },
    });

    await prisma.pickupAssignment.create({
      data: {
        orgId: org.id,
        pickupRequestId: request.id,
        assignedToId: executive.id,
        assignedById: admin.id,
      },
    });
    await prisma.pickupRequest.update({
      where: { id: request.id },
      data: { status: "ASSIGNED" },
    });

    // The same event the assign screen raises. Without it the consignment
    // stays BOOKED and the pickup's own attempt cannot be recorded — the
    // state machine only allows PICKUP_ATTEMPTED from PICKUP_ASSIGNED.
    const event = await appendShipmentEvent(
      {
        shipmentId: shipment.id,
        eventType: "PICKUP_ASSIGNED",
        branchId: shipment.bookingBranchId,
        payload: { pickupNumber: request.number, assignedToId: executive.id },
      },
      admin,
    );

    console.log(
      `  assigned to ${executive.name} (${executive.primaryBranch?.code ?? "no branch"})` +
        (event.ok ? "" : ` — the shipment event was refused: ${event.error}`),
    );

    if (executive.primaryBranch?.code !== shipment.bookingBranch.code) {
      console.log(
        `\n  Note: the pickup is at ${shipment.bookingBranch.code} and ${executive.name} ` +
          `covers ${executive.primaryBranch?.code ?? "no branch"}. Unless their role is ` +
          "network-scoped, this will not appear on their list — the field screen shows " +
          "only stops at branches they cover, because the stop screen refuses the rest.",
      );
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("\nCould not raise the pickup:\n", error);
    await prisma.$disconnect();
    process.exit(1);
  });
