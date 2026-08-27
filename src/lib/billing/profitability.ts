import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { anyBranchScope, branchScope } from "@/server/repositories/scope";
import { dec, money } from "./ageing";

/**
 * Profitability.
 *
 * Per trip and per shipment: revenue less vendor freight less trip
 * expenses. Overhead allocation is deliberately absent — a made-up
 * apportionment reads as precision it does not have, and the contribution
 * figure is the one an operations manager can actually act on.
 */

export type TripProfit = {
  tripId: string;
  number: string;
  status: string;
  departedAt: Date | null;
  origin: string;
  destination: string;
  vehicleNumber: string;
  vendorName: string | null;
  /** Freight on the consignments this trip carried. */
  revenue: Decimal;
  /** What the transporter is owed. */
  vendorFreight: Decimal;
  /** Approved trip expenses. */
  expenses: Decimal;
  contribution: Decimal;
  marginPercent: Decimal | null;
  shipmentCount: number;
};

export async function tripProfitability(
  options: { from: Date; to: Date; take?: number },
  user: SessionUser,
): Promise<TripProfit[]> {
  const trips = await prisma.trip.findMany({
    where: {
      plannedDepartureAt: { gte: options.from, lte: options.to },
      ...anyBranchScope(user, ["originBranchId", "destinationBranchId"]),
    },
    orderBy: { plannedDepartureAt: "desc" },
    take: options.take ?? 100,
    select: {
      id: true,
      number: true,
      status: true,
      actualDepartureAt: true,
      plannedDepartureAt: true,
      freightPayable: true,
      originBranch: { select: { code: true } },
      destinationBranch: { select: { code: true } },
      vehicle: { select: { registrationNumber: true } },
      vendor: { select: { name: true } },
      expenses: { where: { isApproved: true }, select: { amount: true } },
      manifests: {
        select: {
          lines: {
            select: {
              shipment: { select: { id: true, chargesTotal: true } },
            },
          },
        },
      },
      ftlShipment: { select: { id: true, chargesTotal: true } },
    },
  });

  return trips.map((trip) => {
    // A shipment can appear on more than one manifest across a
    // transshipment, so revenue is counted per distinct consignment.
    const shipments = new Map<string, Decimal>();

    for (const manifest of trip.manifests) {
      for (const line of manifest.lines) {
        if (!line.shipment) continue;
        shipments.set(line.shipment.id, dec(line.shipment.chargesTotal.toString()));
      }
    }
    if (trip.ftlShipment) {
      shipments.set(
        trip.ftlShipment.id,
        dec(trip.ftlShipment.chargesTotal.toString()),
      );
    }

    const revenue = money(
      [...shipments.values()].reduce((sum, value) => sum.plus(value), new Decimal(0)),
    );
    const vendorFreight = money(dec(trip.freightPayable?.toString()));
    const expenses = money(
      trip.expenses.reduce((sum, e) => sum.plus(dec(e.amount.toString())), new Decimal(0)),
    );

    const contribution = money(revenue.minus(vendorFreight).minus(expenses));
    const marginPercent = revenue.greaterThan(0)
      ? contribution.times(100).dividedBy(revenue).toDecimalPlaces(1, Decimal.ROUND_HALF_UP)
      : null;

    return {
      tripId: trip.id,
      number: trip.number,
      status: trip.status,
      departedAt: trip.actualDepartureAt ?? trip.plannedDepartureAt,
      origin: trip.originBranch.code,
      destination: trip.destinationBranch.code,
      vehicleNumber: trip.vehicle.registrationNumber,
      vendorName: trip.vendor?.name ?? null,
      revenue,
      vendorFreight,
      expenses,
      contribution,
      marginPercent,
      shipmentCount: shipments.size,
    };
  });
}

export type ShipmentProfit = {
  shipmentId: string;
  lrNumber: string;
  bookedAt: Date;
  customerName: string | null;
  lane: string;
  revenue: Decimal;
  /**
   * The trip's vendor freight and expenses, apportioned across the
   * consignments it carried by their share of revenue. Stated as an
   * allocation, not as a fact about this consignment.
   */
  allocatedCost: Decimal;
  contribution: Decimal;
  marginPercent: Decimal | null;
};

/**
 * Contribution per consignment.
 *
 * Line-haul cost is a trip-level fact, so a per-shipment figure is always
 * an apportionment. Splitting by revenue share is the least misleading
 * option available and is named as an allocation on the screen.
 */
export async function shipmentProfitability(
  options: { from: Date; to: Date; customerId?: string | null; take?: number },
  user: SessionUser,
): Promise<ShipmentProfit[]> {
  const shipments = await prisma.shipment.findMany({
    where: {
      bookedAt: { gte: options.from, lte: options.to },
      deletedAt: null,
      ...(options.customerId ? { consignorId: options.customerId } : {}),
      ...anyBranchScope(user, [
        "originBranchId",
        "destinationBranchId",
        "bookingBranchId",
      ]),
    },
    orderBy: { bookedAt: "desc" },
    take: options.take ?? 200,
    select: {
      id: true,
      lrNumber: true,
      bookedAt: true,
      chargesTotal: true,
      consignor: { select: { name: true } },
      originBranch: { select: { code: true } },
      destinationBranch: { select: { code: true } },
      manifestLines: {
        select: {
          manifest: {
            select: {
              tripId: true,
              trip: {
                select: {
                  id: true,
                  freightPayable: true,
                  expenses: { where: { isApproved: true }, select: { amount: true } },
                  manifests: {
                    select: {
                      lines: {
                        select: { shipment: { select: { id: true, chargesTotal: true } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  return shipments.map((shipment) => {
    const revenue = money(dec(shipment.chargesTotal.toString()));
    let allocatedCost = new Decimal(0);

    const seenTrips = new Set<string>();

    for (const line of shipment.manifestLines) {
      const trip = line.manifest.trip;
      if (!trip || seenTrips.has(trip.id)) continue;
      seenTrips.add(trip.id);

      const tripCost = dec(trip.freightPayable?.toString()).plus(
        trip.expenses.reduce((sum, e) => sum.plus(dec(e.amount.toString())), new Decimal(0)),
      );

      const carried = new Map<string, Decimal>();
      for (const manifest of trip.manifests) {
        for (const manifestLine of manifest.lines) {
          if (!manifestLine.shipment) continue;
          carried.set(
            manifestLine.shipment.id,
            dec(manifestLine.shipment.chargesTotal.toString()),
          );
        }
      }

      const tripRevenue = [...carried.values()].reduce(
        (sum, value) => sum.plus(value),
        new Decimal(0),
      );

      // Even split when nothing on the trip carried revenue — otherwise
      // the whole trip cost would land on one consignment at random.
      const share = tripRevenue.greaterThan(0)
        ? revenue.dividedBy(tripRevenue)
        : carried.size > 0
          ? new Decimal(1).dividedBy(carried.size)
          : new Decimal(0);

      allocatedCost = allocatedCost.plus(tripCost.times(share));
    }

    allocatedCost = money(allocatedCost);
    const contribution = money(revenue.minus(allocatedCost));
    const marginPercent = revenue.greaterThan(0)
      ? contribution.times(100).dividedBy(revenue).toDecimalPlaces(1, Decimal.ROUND_HALF_UP)
      : null;

    return {
      shipmentId: shipment.id,
      lrNumber: shipment.lrNumber,
      bookedAt: shipment.bookedAt,
      customerName: shipment.consignor?.name ?? null,
      lane: `${shipment.originBranch.code} → ${shipment.destinationBranch.code}`,
      revenue,
      allocatedCost,
      contribution,
      marginPercent,
    };
  });
}

/** Headline figures for the profitability screen. */
export async function profitabilitySummary(
  options: { from: Date; to: Date },
  user: SessionUser,
): Promise<{
  revenue: Decimal;
  vendorFreight: Decimal;
  expenses: Decimal;
  contribution: Decimal;
  marginPercent: Decimal | null;
  invoiced: Decimal;
}> {
  const trips = await tripProfitability({ ...options, take: 1000 }, user);

  const revenue = money(trips.reduce((sum, t) => sum.plus(t.revenue), new Decimal(0)));
  const vendorFreight = money(
    trips.reduce((sum, t) => sum.plus(t.vendorFreight), new Decimal(0)),
  );
  const expenses = money(trips.reduce((sum, t) => sum.plus(t.expenses), new Decimal(0)));
  const contribution = money(revenue.minus(vendorFreight).minus(expenses));

  const invoicedAgg = await prisma.invoice.aggregate({
    where: {
      invoiceDate: { gte: options.from, lte: options.to },
      status: { notIn: ["CANCELLED", "DRAFT"] },
      ...branchScope(user, "branchId"),
    },
    _sum: { total: true },
  });

  return {
    revenue,
    vendorFreight,
    expenses,
    contribution,
    marginPercent: revenue.greaterThan(0)
      ? contribution.times(100).dividedBy(revenue).toDecimalPlaces(1, Decimal.ROUND_HALF_UP)
      : null,
    invoiced: money(dec(invoicedAgg._sum.total?.toString())),
  };
}
