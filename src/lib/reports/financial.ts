import { Decimal } from "decimal.js";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { RECEIVABLE_AGEING_EDGES, ageingBuckets } from "./kpi";
import {
  dateCell,
  dateTimeCell,
  humanise,
  moneyCell,
  sumDecimal,
} from "./format";
import { singleBranchWhere } from "./scope";
import type { ReportContext, ReportResult, ReportRow } from "./types";

/**
 * Financial reports — docs/BRD.html §A.17.
 *
 * Phase 6 billing is being built alongside this phase, so some of these
 * have data and some do not yet. Where a figure depends on invoicing that
 * has not landed, the report says so in a sentence instead of rendering a
 * table of zeroes.
 *
 * That distinction is the whole point of this file. A revenue report
 * showing ₹0 is indistinguishable from a terrible month, and somebody
 * will act on it before anybody works out which it was. "Available once
 * billing is live" cannot be misread.
 *
 * Nothing here imports from `src/lib/billing` or `src/lib/pricing` — the
 * Prisma models are the contract between the two phases, deliberately, so
 * neither side blocks the other.
 */

const AWAITING_BILLING =
  "Available once billing is live. Phase 6 creates the invoices this report reads; until the first bill run there is nothing to show, and showing zero would read as a bad month rather than as a missing module.";

/** True when invoicing has actually started. Cheap: an existence check. */
async function billingIsLive(): Promise<boolean> {
  const invoice = await prisma.invoice.findFirst({ select: { id: true } });
  return invoice !== null;
}

function pending(columns: ReportResult["columns"]): ReportResult {
  return { columns, rows: [], total: 0, unavailable: AWAITING_BILLING };
}

// ────────────────────────────────────────────────────────────
// Customer billing register
// ────────────────────────────────────────────────────────────

export async function billingRegister(
  ctx: ReportContext,
): Promise<ReportResult> {
  const columns: ReportResult["columns"] = [
    { key: "number", label: "Invoice", type: "code" },
    { key: "date", label: "Date", type: "date" },
    { key: "customer", label: "Customer" },
    { key: "branch", label: "Branch" },
    { key: "period", label: "Period" },
    { key: "lines", label: "Shipments", type: "number" },
    { key: "subtotal", label: "Taxable", type: "money" },
    { key: "tax", label: "Tax", type: "money" },
    { key: "total", label: "Total", type: "money" },
    { key: "paid", label: "Paid", type: "money" },
    { key: "due", label: "Outstanding", type: "money" },
    { key: "status", label: "Status", type: "state" },
  ];

  if (!(await billingIsLive())) return pending(columns);

  const where: Prisma.InvoiceWhereInput = {
    AND: [
      { invoiceDate: { gte: ctx.filters.from, lte: ctx.filters.to } },
      ctx.user.branchIds === null ? {} : { branchId: { in: ctx.user.branchIds } },
      ctx.filters.branchId ? { branchId: ctx.filters.branchId } : {},
      ctx.filters.customerId ? { customerId: ctx.filters.customerId } : {},
      ctx.filters.q
        ? { number: { contains: ctx.filters.q, mode: "insensitive" } }
        : {},
    ],
  };

  const [rows, total, aggregate] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { invoiceDate: "desc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        number: true,
        status: true,
        invoiceDate: true,
        periodFrom: true,
        periodTo: true,
        subtotal: true,
        taxAmount: true,
        total: true,
        amountPaid: true,
        amountDue: true,
        customer: { select: { name: true } },
        branch: { select: { code: true } },
        _count: { select: { lines: true } },
      },
    }),
    prisma.invoice.count({ where }),
    prisma.invoice.aggregate({
      where,
      _sum: {
        subtotal: true,
        taxAmount: true,
        total: true,
        amountPaid: true,
        amountDue: true,
      },
    }),
  ]);

  return {
    columns,
    rows: rows.map((row) => ({
      key: row.id,
      cells: {
        number: row.number,
        date: dateCell(row.invoiceDate),
        customer: row.customer.name,
        branch: row.branch.code,
        period:
          row.periodFrom && row.periodTo
            ? `${dateCell(row.periodFrom)} → ${dateCell(row.periodTo)}`
            : null,
        lines: row._count.lines,
        subtotal: moneyCell(row.subtotal),
        tax: moneyCell(row.taxAmount),
        total: moneyCell(row.total),
        paid: moneyCell(row.amountPaid),
        due: moneyCell(row.amountDue),
        status: humanise(row.status),
      },
      tones: {
        status:
          row.status === "PAID"
            ? "ok"
            : row.status === "CANCELLED" || row.status === "CREDITED"
              ? "muted"
              : "warn",
      },
    })),
    total,
    totals: {
      subtotal: moneyCell(aggregate._sum.subtotal),
      tax: moneyCell(aggregate._sum.taxAmount),
      total: moneyCell(aggregate._sum.total),
      paid: moneyCell(aggregate._sum.amountPaid),
      due: moneyCell(aggregate._sum.amountDue),
    },
  };
}

// ────────────────────────────────────────────────────────────
// Outstanding & ageing
// ────────────────────────────────────────────────────────────

export async function outstandingAgeing(
  ctx: ReportContext,
): Promise<ReportResult> {
  const columns: ReportResult["columns"] = [
    { key: "customer", label: "Customer" },
    { key: "invoices", label: "Open invoices", type: "number" },
    { key: "b0", label: "0–30 d", type: "money" },
    { key: "b1", label: "31–60 d", type: "money" },
    { key: "b2", label: "61–90 d", type: "money" },
    { key: "b3", label: "90+ d", type: "money" },
    { key: "outstanding", label: "Total due", type: "money" },
    { key: "oldest", label: "Oldest", type: "date" },
  ];

  if (!(await billingIsLive())) return pending(columns);

  // Ageing is a snapshot of what is owed now, not of what was invoiced in
  // a window — filtering it by the report's date range would produce a
  // number nobody in accounts recognises.
  const where: Prisma.InvoiceWhereInput = {
    AND: [
      { status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
      { amountDue: { gt: 0 } },
      ctx.user.branchIds === null ? {} : { branchId: { in: ctx.user.branchIds } },
      ctx.filters.branchId ? { branchId: ctx.filters.branchId } : {},
      ctx.filters.customerId ? { customerId: ctx.filters.customerId } : {},
    ],
  };

  /**
   * A ceiling, so one bad month cannot pull the whole ledger into memory.
   *
   * Ageing has to be computed across every open invoice before it can be
   * grouped by customer and paged, so this one genuinely cannot be done a
   * page at a time — but "genuinely cannot be paged" is not the same as
   * "may be unbounded", and this had no `take` at all.
   */
  const MAX_OPEN_INVOICES = 20_000;

  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: { invoiceDate: "asc" },
    take: MAX_OPEN_INVOICES,
    select: {
      customerId: true,
      invoiceDate: true,
      dueDate: true,
      amountDue: true,
      customer: { select: { name: true, code: true } },
    },
  });

  const now = new Date();
  const byCustomer = new Map<
    string,
    { name: string; entries: Array<{ amount: Decimal; since: Date }> }
  >();

  for (const invoice of invoices) {
    const entry = byCustomer.get(invoice.customerId) ?? {
      name: `${invoice.customer.name} (${invoice.customer.code})`,
      entries: [],
    };
    entry.entries.push({
      amount: new Decimal(invoice.amountDue.toString()),
      // Ageing runs from the due date, which is the date the money was
      // actually late — ageing from the invoice date makes every customer
      // on 30-day terms look 30 days delinquent on day one.
      since: invoice.dueDate,
    });
    byCustomer.set(invoice.customerId, entry);
  }

  const all: ReportRow[] = [...byCustomer.entries()].map(([id, entry]) => {
    const buckets = ageingBuckets(entry.entries, now, RECEIVABLE_AGEING_EDGES);
    const outstanding = entry.entries.reduce(
      (sum, item) => sum.plus(item.amount),
      new Decimal(0),
    );
    const oldest = entry.entries.reduce<Date | null>(
      (min, item) => (!min || item.since < min ? item.since : min),
      null,
    );

    return {
      key: id,
      href: `/customers/${id}`,
      cells: {
        customer: entry.name,
        invoices: entry.entries.length,
        b0: buckets[0].amount.toDecimalPlaces(2).toNumber(),
        b1: buckets[1].amount.toDecimalPlaces(2).toNumber(),
        b2: buckets[2].amount.toDecimalPlaces(2).toNumber(),
        b3: buckets[3].amount.toDecimalPlaces(2).toNumber(),
        outstanding: outstanding.toDecimalPlaces(2).toNumber(),
        oldest: dateCell(oldest),
      },
      tones: {
        outstanding: buckets[3].amount.greaterThan(0) ? "bad" : "muted",
      },
    };
  });

  all.sort(
    (a, b) => Number(b.cells.outstanding ?? 0) - Number(a.cells.outstanding ?? 0),
  );

  const page = all.slice(
    (ctx.page - 1) * ctx.pageSize,
    ctx.page * ctx.pageSize,
  );

  return {
    columns,
    rows: page,
    total: all.length,
    totals: {
      outstanding: all
        .reduce(
          (sum, row) => sum.plus(new Decimal(String(row.cells.outstanding ?? 0))),
          new Decimal(0),
        )
        .toDecimalPlaces(2)
        .toNumber(),
    },
    note:
      invoices.length >= MAX_OPEN_INVOICES
        ? `A snapshot of what is owed today, aged from the due date. The report's date range does not apply. Built from the ${MAX_OPEN_INVOICES.toLocaleString("en-IN")} oldest open invoices — there are more, so these totals are a floor, not the whole ledger. Filter by customer or branch for an exact figure.`
        : "A snapshot of what is owed today, aged from the due date. The report's date range does not apply.",
  };
}

// ────────────────────────────────────────────────────────────
// Revenue by lane / branch
// ────────────────────────────────────────────────────────────

export async function revenueByLane(
  ctx: ReportContext,
): Promise<ReportResult> {
  const columns: ReportResult["columns"] = [
    { key: "lane", label: "Lane" },
    { key: "shipments", label: "Shipments", type: "number" },
    { key: "weight", label: "Chargeable kg", type: "weight" },
    { key: "booked", label: "Booked value", type: "money" },
    { key: "invoiced", label: "Invoiced", type: "money" },
    { key: "perKg", label: "Per kg", type: "money" },
  ];

  // The booked half is real today — the consignment note carries a
  // freight figure from the moment it is created. The invoiced half needs
  // Phase 6, and saying which half is which is more useful than waiting.
  const live = await billingIsLive();

  const laneWhereClause: Prisma.ShipmentWhereInput = {
    AND: [
      { deletedAt: null },
      { bookedAt: { gte: ctx.filters.from, lte: ctx.filters.to } },
      ctx.user.branchIds === null
        ? {}
        : {
            OR: [
              { originBranchId: { in: ctx.user.branchIds } },
              { destinationBranchId: { in: ctx.user.branchIds } },
            ],
          },
      ctx.filters.serviceTypeId
        ? { serviceTypeId: ctx.filters.serviceTypeId }
        : {},
      ctx.filters.mode ? { mode: ctx.filters.mode } : {},
      ctx.filters.customerId ? { consignorId: ctx.filters.customerId } : {},
    ],
  };

  const [grouped, everyLane] = await Promise.all([
    prisma.shipment.groupBy({
      by: ["originBranchId", "destinationBranchId"],
      where: laneWhereClause,
      _count: { _all: true },
      _sum: { chargeableWeight: true, grandTotal: true },
      orderBy: { _sum: { grandTotal: "desc" } },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
    }),

    /**
     * How many lanes there actually are.
     *
     * `total` used to be `rows.length` — the size of the page just
     * fetched. Two things followed. The header said "50 row(s)" for a
     * network with three hundred lanes, and the pagination control, which
     * only draws when `total > PAGE_SIZE`, never drew at all: every lane
     * past the fiftieth was unreachable on screen while the CSV export,
     * which pages through the same runner, contained all of them. A report
     * and its own export disagreeing is the worst version of this bug,
     * because both look authoritative.
     *
     * Bounded by the number of branch pairs, not by shipment volume.
     */
    prisma.shipment.groupBy({
      by: ["originBranchId", "destinationBranchId"],
      where: laneWhereClause,
      _count: { _all: true },
    }),
  ]);

  const branchIds = [
    ...new Set(grouped.flatMap((g) => [g.originBranchId, g.destinationBranchId])),
  ];
  const branches = await prisma.branch.findMany({
    where: { id: { in: branchIds } },
    select: { id: true, code: true },
  });
  const codeById = new Map(branches.map((b) => [b.id, b.code]));

  const rows: ReportRow[] = grouped.map((group) => {
    const booked = new Decimal((group._sum.grandTotal ?? 0).toString());
    const weight = new Decimal((group._sum.chargeableWeight ?? 0).toString());

    return {
      key: `${group.originBranchId}-${group.destinationBranchId}`,
      cells: {
        lane: `${codeById.get(group.originBranchId) ?? "?"} → ${codeById.get(group.destinationBranchId) ?? "?"}`,
        shipments: group._count._all,
        weight: weight.toDecimalPlaces(3).toNumber(),
        booked: booked.toDecimalPlaces(2).toNumber(),
        // Blank, not zero. Attributing invoice lines to lanes is Phase 6
        // work; until it lands this figure is unknown, and a zero here
        // would read as a lane that earned nothing.
        invoiced: null,
        perKg: weight.greaterThan(0)
          ? booked.dividedBy(weight).toDecimalPlaces(2).toNumber()
          : null,
      },
    };
  });

  return {
    columns,
    rows,
    total: everyLane.length,
    note: live
      ? "Booked value is what the consignment note carried. Invoiced revenue arrives once Phase 6 links invoice lines to lanes."
      : "Booked value is real — it comes from the consignment note. The invoiced column stays blank until billing is live; it is not zero, it is unknown.",
  };
}

// ────────────────────────────────────────────────────────────
// COD collected / pending / remitted
// ────────────────────────────────────────────────────────────

/**
 * COD, end to end.
 *
 * Entirely real: collections, deposits and remittances are Phase 4, so
 * this is the one financial report that has been true since before
 * invoicing existed.
 */
export async function codRegister(ctx: ReportContext): Promise<ReportResult> {
  const where = singleBranchWhere(
    ctx.user,
    ctx.filters,
    "collectedAt",
  ) as Prisma.CodCollectionWhereInput;

  const scoped: Prisma.CodCollectionWhereInput = ctx.filters.customerId
    ? { AND: [where, { shipment: { consignorId: ctx.filters.customerId } }] }
    : where;

  const [rows, total, aggregate] = await Promise.all([
    prisma.codCollection.findMany({
      where: scoped,
      orderBy: { collectedAt: "desc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        amountExpected: true,
        amountCollected: true,
        mode: true,
        state: true,
        collectedAt: true,
        reference: true,
        branch: { select: { code: true } },
        shipment: {
          select: {
            id: true,
            lrNumber: true,
            consigneeName: true,
            consignor: { select: { name: true } },
            consignorName: true,
          },
        },
        deposit: { select: { depositDate: true, status: true } },
        remittance: { select: { status: true, paidAt: true } },
      },
    }),
    prisma.codCollection.count({ where: scoped }),
    prisma.codCollection.aggregate({
      where: scoped,
      _sum: { amountExpected: true, amountCollected: true },
    }),
  ]);

  const now = new Date();

  return {
    columns: [
      { key: "lr", label: "LR number", type: "code" },
      { key: "customer", label: "Customer" },
      { key: "consignee", label: "Consignee" },
      { key: "branch", label: "Branch" },
      { key: "expected", label: "Expected", type: "money" },
      { key: "collected", label: "Collected", type: "money" },
      { key: "shortfall", label: "Shortfall", type: "money" },
      { key: "mode", label: "Mode" },
      { key: "collectedAt", label: "Collected", type: "datetime" },
      { key: "deposited", label: "Deposited", type: "date" },
      { key: "age", label: "Held for", type: "duration" },
      { key: "state", label: "State", type: "state" },
    ],
    rows: rows.map((row) => {
      const expected = new Decimal(row.amountExpected.toString());
      const collected = new Decimal(row.amountCollected.toString());
      const shortfall = expected.minus(collected);
      const remitted = row.remittance?.status === "SETTLED";

      return {
        key: row.id,
        href: `/shipments/${row.shipment.id}`,
        cells: {
          lr: row.shipment.lrNumber,
          customer: row.shipment.consignor?.name ?? row.shipment.consignorName,
          consignee: row.shipment.consigneeName,
          branch: row.branch.code,
          expected: expected.toDecimalPlaces(2).toNumber(),
          collected: collected.toDecimalPlaces(2).toNumber(),
          shortfall: shortfall.toDecimalPlaces(2).toNumber(),
          mode: humanise(row.mode),
          collectedAt: dateTimeCell(row.collectedAt),
          deposited: dateCell(row.deposit?.depositDate),
          // Money sitting with an agent or a branch is the risk this
          // report exists to show, so the clock stops at remittance.
          age: remitted
            ? null
            : Math.round((now.getTime() - row.collectedAt.getTime()) / 60_000),
          state: humanise(row.state),
        },
        tones: {
          state: remitted ? "ok" : row.state === "COLLECTED" ? "warn" : "info",
          shortfall: shortfall.greaterThan(0) ? "bad" : "muted",
        },
      };
    }),
    total,
    totals: {
      expected: moneyCell(aggregate._sum.amountExpected),
      collected: moneyCell(aggregate._sum.amountCollected),
      shortfall: sumDecimal([aggregate._sum.amountExpected])
        .minus(sumDecimal([aggregate._sum.amountCollected]))
        .toDecimalPlaces(2)
        .toNumber(),
    },
    note: "Held for is the time between collection and remittance — cash sitting in the network is the exposure this report exists to show.",
  };
}

// ────────────────────────────────────────────────────────────
// Trip expense register
// ────────────────────────────────────────────────────────────

export async function tripExpenseRegister(
  ctx: ReportContext,
): Promise<ReportResult> {
  const branchIds = ctx.user.branchIds;

  const where: Prisma.TripExpenseWhereInput = {
    AND: [
      { incurredOn: { gte: ctx.filters.from, lte: ctx.filters.to } },
      branchIds === null
        ? {}
        : {
            trip: {
              OR: [
                { originBranchId: { in: branchIds } },
                { destinationBranchId: { in: branchIds } },
              ],
            },
          },
      ctx.filters.branchId
        ? {
            trip: {
              OR: [
                { originBranchId: ctx.filters.branchId },
                { destinationBranchId: ctx.filters.branchId },
              ],
            },
          }
        : {},
    ],
  };

  const [rows, total, aggregate] = await Promise.all([
    prisma.tripExpense.findMany({
      where,
      orderBy: { incurredOn: "desc" },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
      select: {
        id: true,
        category: true,
        amount: true,
        incurredOn: true,
        paidBy: true,
        isApproved: true,
        approvedAt: true,
        remarks: true,
        trip: {
          select: {
            id: true,
            number: true,
            originBranch: { select: { code: true } },
            destinationBranch: { select: { code: true } },
            vehicle: { select: { registrationNumber: true } },
            driver: { select: { name: true } },
          },
        },
      },
    }),
    prisma.tripExpense.count({ where }),
    prisma.tripExpense.aggregate({ where, _sum: { amount: true } }),
  ]);

  return {
    columns: [
      { key: "trip", label: "Trip", type: "code" },
      { key: "lane", label: "Lane" },
      { key: "vehicle", label: "Vehicle", type: "code" },
      { key: "driver", label: "Driver" },
      { key: "category", label: "Head" },
      { key: "amount", label: "Amount", type: "money" },
      { key: "incurred", label: "Incurred", type: "date" },
      { key: "paidBy", label: "Paid by" },
      { key: "approval", label: "Approval", type: "state" },
      { key: "remarks", label: "Remarks" },
    ],
    rows: rows.map((row) => ({
      key: row.id,
      href: `/dispatch/trips/${row.trip.id}`,
      cells: {
        trip: row.trip.number,
        lane: `${row.trip.originBranch.code} → ${row.trip.destinationBranch.code}`,
        vehicle: row.trip.vehicle.registrationNumber,
        driver: row.trip.driver?.name ?? null,
        category: humanise(row.category),
        amount: moneyCell(row.amount),
        incurred: dateCell(row.incurredOn),
        paidBy: row.paidBy,
        approval: row.isApproved ? "Approved" : "Pending",
        remarks: row.remarks,
      },
      tones: { approval: row.isApproved ? "ok" : "warn" },
    })),
    total,
    totals: { amount: moneyCell(aggregate._sum.amount) },
  };
}

// ────────────────────────────────────────────────────────────
// Awaiting Phase 6
// ────────────────────────────────────────────────────────────

/**
 * Vendor payable & reconciliation.
 *
 * The vendor bill models exist; nothing writes to them until Phase 6
 * generates payables from the rate contracts. Rather than render an empty
 * table that looks like "no vendors owed anything", this reports what it
 * is waiting for.
 */
export async function vendorPayable(
  ctx: ReportContext,
): Promise<ReportResult> {
  const columns: ReportResult["columns"] = [
    { key: "vendor", label: "Vendor" },
    { key: "bills", label: "Bills", type: "number" },
    { key: "billed", label: "Billed", type: "money" },
    { key: "contracted", label: "Per contract", type: "money" },
    { key: "variance", label: "Variance", type: "money" },
    { key: "paid", label: "Paid", type: "money" },
    { key: "outstanding", label: "Outstanding", type: "money" },
  ];

  const bill = await prisma.vendorBill.findFirst({ select: { id: true } });

  if (!bill) {
    return {
      columns,
      rows: [],
      total: 0,
      unavailable:
        "Available once billing is live. Vendor payables are generated from the rate contracts in Phase 6; no bill has been raised yet, and an empty table here would read as 'nothing owed'.",
    };
  }

  /**
   * Paged, and counted.
   *
   * This took `take: 100` with no `skip` and reported `total: rows.length`.
   * Every consequence of that was invisible from the screen: the header
   * said "100 row(s)" whatever the vendor list held, the pagination
   * control never appeared because 100 is not more than a page, and the
   * exporter — which walks the runner page by page — was handed the same
   * first hundred vendors on every page it asked for.
   */
  const [rows, everyVendor] = await Promise.all([
    prisma.vendorBill.groupBy({
      by: ["vendorId"],
      _count: { _all: true },
      _sum: {
        total: true,
        amountPaid: true,
        amountDue: true,
        varianceAmount: true,
      },
      orderBy: { _sum: { total: "desc" } },
      skip: (ctx.page - 1) * ctx.pageSize,
      take: ctx.pageSize,
    }),
    prisma.vendorBill.groupBy({ by: ["vendorId"], _count: { _all: true } }),
  ]);

  const vendors = await prisma.vendor.findMany({
    where: { id: { in: rows.map((r) => r.vendorId) } },
    select: { id: true, name: true, code: true },
  });
  const nameById = new Map(vendors.map((v) => [v.id, `${v.name} (${v.code})`]));

  return {
    columns,
    rows: rows.map((row) => ({
      key: row.vendorId,
      cells: {
        vendor: nameById.get(row.vendorId) ?? "Unknown vendor",
        bills: row._count._all,
        billed: moneyCell(row._sum.total),
        // Still unknown: attributing a rate contract to a bill is Phase 6
        // work and there is nothing to read it from.
        contracted: null,
        // These three were blank too, and they should never have been:
        // `amountPaid`, `amountDue` and `varianceAmount` are columns on
        // the very rows being grouped. "Outstanding — unknown" next to a
        // billed figure is what sends somebody to the ledger to work out a
        // number the report was already holding.
        variance: moneyCell(row._sum.varianceAmount),
        paid: moneyCell(row._sum.amountPaid),
        outstanding: moneyCell(row._sum.amountDue),
      },
    })),
    total: everyVendor.length,
    note: "Billed, paid, outstanding and variance are the vendor bills themselves. Per contract stays blank — reconciling against the rate contract arrives with Phase 6, and blank means unknown, not zero. Vendor bills carry no branch, so this report is scoped to the organisation and the branch filter does not apply. The date range does not apply either: it is what is owed today.",
  };
}
