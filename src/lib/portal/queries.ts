import { prisma } from "@/lib/prisma";
import type { CustomerSession } from "@/lib/auth/customer-session";
import type { ShipmentStatus } from "@/generated/prisma/client";
import {
  CUSTOMER_STATUS_LABELS,
  STATUS_GROUPS,
} from "@/lib/shipment/state-machine";
import {
  customerShipmentFilter,
  toPublicTimeline,
  toneFor,
  type PublicMilestone,
  type PublicTone,
} from "./visibility";
import { countOpenPortalComplaints } from "./complaints";
import { portalOutstandingSummary } from "./billing";

/**
 * Every read the portal makes.
 *
 * All of them start from `customerShipmentFilter(session)`, which is what
 * makes the Phase 5 acceptance test — "a customer user cannot see another
 * account's shipment through the UI or the API" — hold in the data layer
 * rather than in a template. Nothing in `src/app/(portal)` queries
 * `prisma.shipment` directly.
 */

const IN_FLIGHT = [
  ...STATUS_GROUPS.pending,
  ...STATUS_GROUPS.inNetwork,
  ...STATUS_GROUPS.moving,
  ...STATUS_GROUPS.lastMile,
];

export type PortalDashboard = {
  inFlight: number;
  deliveredThisMonth: number;
  pendingPod: number;
  /**
   * Owed right now, as a fixed-2 string. Null when billing could not
   * answer — which renders as "coming soon" rather than as a confident
   * zero. See `src/lib/portal/billing.ts`.
   */
  outstanding: string | null;
  /** True when any of it is past its due date. */
  hasOverdue: boolean;
  recent: PortalShipmentRow[];
  openPickups: number;
  openComplaints: number;
};

export async function getPortalDashboard(
  session: CustomerSession,
): Promise<PortalDashboard> {
  const scope = customerShipmentFilter(session);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [
    inFlight,
    deliveredThisMonth,
    pendingPod,
    recent,
    openPickups,
    openComplaints,
    outstanding,
  ] = await Promise.all([
      prisma.shipment.count({
        where: { ...scope, currentStatus: { in: IN_FLIGHT } },
      }),
      prisma.shipment.count({
        where: {
          ...scope,
          currentStatus: { in: STATUS_GROUPS.done },
          deliveredAt: { gte: monthStart },
        },
      }),
      // Delivered but the signed proof has not come back off the device.
      prisma.shipment.count({
        where: { ...scope, currentStatus: "DELIVERED" },
      }),
      listPortalShipments(session, { take: 5 }),
    prisma.pickupRequest.count({
      where: {
        customerId: session.customerId,
        status: { in: ["REQUESTED", "ASSIGNED", "IN_PROGRESS"] },
      },
    }),
    countOpenPortalComplaints(session),
    portalOutstandingSummary(session),
  ]);

  return {
    inFlight,
    deliveredThisMonth,
    pendingPod,
    outstanding: outstanding?.total ?? null,
    hasOverdue: Number(outstanding?.overdue ?? 0) > 0,
    recent: recent.rows,
    openPickups,
    openComplaints,
  };
}

export type PortalShipmentRow = {
  id: string;
  lrNumber: string;
  status: string;
  tone: PublicTone;
  bookedAt: Date;
  expectedDeliveryAt: Date | null;
  deliveredAt: Date | null;
  packageCount: number;
  fromCity: string;
  toCity: string;
  consigneeName: string;
  reference: string | null;
  hasPod: boolean;
};

export type PortalShipmentQuery = {
  q?: string;
  group?: keyof typeof STATUS_GROUPS;
  page?: number;
  take?: number;
};

export const PORTAL_PAGE_SIZE = 20;

export async function listPortalShipments(
  session: CustomerSession,
  query: PortalShipmentQuery = {},
): Promise<{ rows: PortalShipmentRow[]; total: number; page: number; pageSize: number }> {
  const pageSize = query.take ?? PORTAL_PAGE_SIZE;
  const page = Math.max(1, query.page ?? 1);
  const q = query.q?.trim();

  const where = {
    // Spread first, then narrow. The account pin is never overwritten
    // because nothing below writes `consignorId`.
    ...customerShipmentFilter(session),
    ...(query.group ? { currentStatus: { in: STATUS_GROUPS[query.group] } } : {}),
    ...(q
      ? {
          OR: [
            { lrNumber: { contains: q, mode: "insensitive" as const } },
            { customerReference: { contains: q, mode: "insensitive" as const } },
            { consigneeName: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { bookedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        lrNumber: true,
        currentStatus: true,
        bookedAt: true,
        expectedDeliveryAt: true,
        deliveredAt: true,
        packageCount: true,
        consigneeName: true,
        customerReference: true,
        consignorCity: { select: { name: true } },
        consigneeCity: { select: { name: true } },
        pod: { select: { id: true } },
      },
    }),
    prisma.shipment.count({ where }),
  ]);

  return {
    page,
    pageSize,
    total,
    rows: rows.map((row) => ({
      id: row.id,
      lrNumber: row.lrNumber,
      status: customerLabel(row.currentStatus),
      tone: toneFor(row.currentStatus),
      bookedAt: row.bookedAt,
      expectedDeliveryAt: row.expectedDeliveryAt,
      deliveredAt: row.deliveredAt,
      packageCount: row.packageCount,
      fromCity: row.consignorCity.name,
      toCity: row.consigneeCity.name,
      consigneeName: row.consigneeName,
      reference: row.customerReference,
      hasPod: Boolean(row.pod),
    })),
  };
}

export type PortalShipmentDetail = {
  id: string;
  lrNumber: string;
  status: string;
  tone: PublicTone;
  milestones: PublicMilestone[];

  bookedAt: Date;
  expectedDeliveryAt: Date | null;
  deliveredAt: Date | null;

  serviceName: string;
  mode: string;
  packageCount: number;
  chargeableWeight: string;
  goodsDescription: string;
  declaredValue: string | null;

  fromCity: string;
  toCity: string;
  consigneeName: string;
  consigneeCompany: string | null;
  consigneeAddress: string;
  consigneePincode: string;

  reference: string | null;
  invoiceNumber: string | null;
  ewayBillNumber: string | null;

  paymentType: string;
  codAmount: string | null;
  /** Zero until Phase 6 rates it. Rendered as "not yet priced". */
  grandTotal: string;

  hasPod: boolean;
  podReceiverName: string | null;
  podDeliveredAt: Date | null;
};

/**
 * One shipment, if and only if it belongs to this account.
 *
 * `findFirst` with the scope spread in — never `findUnique` by id, which
 * would fetch the row first and leave the ownership check to whatever the
 * caller remembers to do next.
 */
export async function getPortalShipment(
  session: CustomerSession,
  id: string,
): Promise<PortalShipmentDetail | null> {
  const shipment = await prisma.shipment.findFirst({
    where: { ...customerShipmentFilter(session), id },
    select: {
      id: true,
      lrNumber: true,
      currentStatus: true,
      statusUpdatedAt: true,
      mode: true,
      bookedAt: true,
      expectedDeliveryAt: true,
      deliveredAt: true,
      packageCount: true,
      chargeableWeight: true,
      goodsDescription: true,
      declaredValue: true,
      consigneeName: true,
      consigneeCompany: true,
      consigneeAddress: true,
      consigneePincode: true,
      customerReference: true,
      invoiceNumber: true,
      ewayBillNumber: true,
      paymentType: true,
      codAmount: true,
      grandTotal: true,
      serviceType: { select: { name: true } },
      consignorCity: { select: { name: true } },
      consigneeCity: { select: { name: true } },
      pod: { select: { id: true, receiverName: true, deliveredAt: true } },
      events: {
        orderBy: [{ occurredAt: "asc" }, { recordedAt: "asc" }],
        select: {
          eventType: true,
          occurredAt: true,
          resultingStatus: true,
          branch: { select: { city: { select: { name: true } } } },
        },
      },
    },
  });

  if (!shipment) return null;

  return {
    id: shipment.id,
    lrNumber: shipment.lrNumber,
    status: customerLabel(shipment.currentStatus),
    tone: toneFor(shipment.currentStatus),
    // The same projection the public page uses. A signed-in consignor is
    // still not shown which hub sorted it or who drove it.
    milestones: toPublicTimeline(
      shipment.events.map((event) => ({
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        resultingStatus: event.resultingStatus,
        cityName: event.branch?.city.name ?? null,
      })),
      shipment.currentStatus,
      shipment.statusUpdatedAt,
    ),

    bookedAt: shipment.bookedAt,
    expectedDeliveryAt: shipment.expectedDeliveryAt,
    deliveredAt: shipment.deliveredAt,

    serviceName: shipment.serviceType.name,
    mode: shipment.mode,
    packageCount: shipment.packageCount,
    chargeableWeight: shipment.chargeableWeight.toString(),
    goodsDescription: shipment.goodsDescription,
    declaredValue: shipment.declaredValue?.toFixed(2) ?? null,

    fromCity: shipment.consignorCity.name,
    toCity: shipment.consigneeCity.name,
    consigneeName: shipment.consigneeName,
    consigneeCompany: shipment.consigneeCompany,
    consigneeAddress: shipment.consigneeAddress,
    consigneePincode: shipment.consigneePincode,

    reference: shipment.customerReference,
    invoiceNumber: shipment.invoiceNumber,
    ewayBillNumber: shipment.ewayBillNumber,

    paymentType: shipment.paymentType,
    codAmount: shipment.codAmount?.toFixed(2) ?? null,
    grandTotal: shipment.grandTotal.toFixed(2),

    hasPod: Boolean(shipment.pod),
    podReceiverName: shipment.pod?.receiverName ?? null,
    podDeliveredAt: shipment.pod?.deliveredAt ?? null,
  };
}

/** Confirms an id belongs to this account before linking out to the POD. */
export async function customerOwnsShipment(
  session: CustomerSession,
  shipmentId: string,
): Promise<boolean> {
  const count = await prisma.shipment.count({
    where: { ...customerShipmentFilter(session), id: shipmentId },
  });
  return count > 0;
}

export type PortalPod = {
  lrNumber: string;
  toCity: string;
  consigneeName: string;
  consigneeAddress: string;
  consigneePincode: string;
  packageCount: number;
  chargeableWeight: string;
  goodsDescription: string;
  receiverName: string;
  receiverRelation: string | null;
  deliveredAt: Date;
  otpVerified: boolean;
  /** Set once the worker has rendered the branded PDF. */
  documentAssetId: string | null;
};

/**
 * Proof of delivery for one of this account's own shipments.
 *
 * A customer-facing POD deliberately carries less than the operations one:
 * who received the goods and when, but not which agent delivered them,
 * where their phone was standing, or what the run was called.
 */
export async function getPortalPod(
  session: CustomerSession,
  shipmentId: string,
): Promise<PortalPod | null> {
  const shipment = await prisma.shipment.findFirst({
    where: { ...customerShipmentFilter(session), id: shipmentId },
    select: {
      lrNumber: true,
      packageCount: true,
      chargeableWeight: true,
      goodsDescription: true,
      consigneeName: true,
      consigneeAddress: true,
      consigneePincode: true,
      consigneeCity: { select: { name: true } },
      pod: {
        select: {
          receiverName: true,
          receiverRelation: true,
          deliveredAt: true,
          otpReference: true,
          documentAssetId: true,
        },
      },
    },
  });

  if (!shipment?.pod) return null;

  return {
    lrNumber: shipment.lrNumber,
    toCity: shipment.consigneeCity.name,
    consigneeName: shipment.consigneeName,
    consigneeAddress: shipment.consigneeAddress,
    consigneePincode: shipment.consigneePincode,
    packageCount: shipment.packageCount,
    chargeableWeight: shipment.chargeableWeight.toString(),
    goodsDescription: shipment.goodsDescription,
    receiverName: shipment.pod.receiverName,
    receiverRelation: shipment.pod.receiverRelation,
    deliveredAt: shipment.pod.deliveredAt,
    otpVerified: Boolean(shipment.pod.otpReference),
    documentAssetId: shipment.pod.documentAssetId,
  };
}

/**
 * The label set is the state machine's, not this module's. A status with
 * no customer label — LOST — reads as "In progress" here; the conversation
 * about a lost consignment is a complaint, not a list row.
 */
function customerLabel(status: ShipmentStatus): string {
  return CUSTOMER_STATUS_LABELS[status] ?? "In progress";
}
