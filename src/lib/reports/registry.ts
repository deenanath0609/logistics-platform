import {
  bookingRegister,
  deliveryRegister,
  dispatchManifest,
  documentExpiry,
  exceptionRegister,
  hubDwell,
  inTransitStatus,
  pendingPod,
  pickupPerformance,
  vehicleUtilisation,
} from "./operations";
import {
  agentScorecard,
  branchScorecard,
  complaintRegister,
  customerOnTime,
  customerShipments,
  driverScorecard,
} from "./people";
import {
  billingRegister,
  codRegister,
  outstandingAgeing,
  revenueByLane,
  tripExpenseRegister,
  vendorPayable,
} from "./financial";
import type { ReportDef, ReportGroup } from "./types";

/**
 * The report library.
 *
 * One table, in the order §A.17 lists them. Everything downstream — the
 * index page, the permission guard, the exporter, the saved-report picker
 * — reads this rather than keeping its own list, so adding a report is
 * one entry and never a hunt for the four other places that also needed
 * telling.
 *
 * `icon` is a NAME, not a component. These definitions are imported by
 * server components and the name crosses to the client, where it is
 * mapped; handing a Lucide function across that boundary is a runtime
 * error waiting for whoever adds the twentieth report.
 */

export const REPORTS: ReportDef[] = [
  // ── Operations ────────────────────────────────────────────
  {
    key: "booking-register",
    title: "Booking register",
    description:
      "Every consignment booked in the period, with weight, payment terms and value.",
    group: "operations",
    permission: "report.operations",
    icon: "ClipboardList",
    filters: ["dates", "branch", "customer", "lane", "serviceType", "mode", "search"],
    run: bookingRegister,
  },
  {
    key: "pickup-performance",
    title: "Pickup performance",
    description:
      "Requested against collected, by executive, with failure reasons. On time means collected on the promised date.",
    group: "operations",
    permission: "report.operations",
    icon: "PackageCheck",
    filters: ["dates", "branch", "customer"],
    run: pickupPerformance,
  },
  {
    key: "dispatch-manifest",
    title: "Dispatch & manifest",
    description:
      "Manifests with their trip, vehicle, load and the time they took to arrive.",
    group: "operations",
    permission: "report.operations",
    icon: "FileText",
    filters: ["dates", "branch", "lane"],
    run: dispatchManifest,
  },
  {
    key: "in-transit-status",
    title: "In-transit status",
    description:
      "Everything still in the network, oldest first, with where it is and what its SLA says.",
    group: "operations",
    permission: "report.operations",
    icon: "Navigation",
    filters: [
      "dates",
      "branch",
      "customer",
      "lane",
      "serviceType",
      "mode",
      "sla",
      "search",
    ],
    run: inTransitStatus,
  },
  {
    key: "delivery-register",
    title: "Delivery & undelivered",
    description:
      "Delivered, attempted and returned, with the agent, the receiver and the failure reason.",
    group: "operations",
    permission: "report.operations",
    icon: "Bike",
    filters: ["dates", "branch", "customer", "lane", "serviceType", "search"],
    run: deliveryRegister,
  },
  {
    key: "pending-pod",
    title: "Pending POD",
    description:
      "Delivered with no proof attached. A delivery you cannot prove is one you cannot bill for.",
    group: "operations",
    permission: "report.operations",
    icon: "FileSignature",
    filters: ["dates", "branch", "customer"],
    run: pendingPod,
  },
  {
    key: "exception-register",
    title: "Exception register",
    description:
      "Every exception raised in the period, its age, its escalation level and how it was resolved.",
    group: "operations",
    permission: "report.operations",
    icon: "TriangleAlert",
    filters: ["dates", "branch", "search"],
    run: exceptionRegister,
  },
  {
    key: "hub-dwell",
    title: "Hub inbound / outbound & dwell",
    description:
      "One row per hub visit: inbound scan, outbound load, and how long the consignment sat between them.",
    group: "operations",
    permission: "report.operations",
    icon: "Warehouse",
    filters: ["dates", "branch"],
    run: hubDwell,
  },
  {
    key: "vehicle-utilisation",
    title: "Vehicle utilisation",
    description:
      "Loaded weight against rated capacity, trip by trip, with arrival against plan.",
    group: "operations",
    permission: "report.operations",
    icon: "Truck",
    filters: ["dates", "branch", "lane"],
    run: vehicleUtilisation,
  },
  {
    key: "document-expiry",
    title: "Document expiry",
    description:
      "Vehicle and driver documents, closest expiry first. Ignores the date range on purpose.",
    group: "operations",
    permission: "report.operations",
    icon: "CalendarClock",
    filters: ["branch"],
    run: documentExpiry,
  },

  // ── Financial ─────────────────────────────────────────────
  {
    key: "billing-register",
    title: "Customer billing register",
    description:
      "Invoices raised in the period, with tax, payment and what is still outstanding.",
    group: "financial",
    permission: "report.financial",
    icon: "Receipt",
    filters: ["dates", "branch", "customer", "search"],
    run: billingRegister,
  },
  {
    key: "outstanding-ageing",
    title: "Outstanding & ageing",
    description:
      "What every customer owes today, in 0–30 / 31–60 / 61–90 / 90+ buckets, aged from the due date.",
    group: "financial",
    permission: "report.financial",
    icon: "Hourglass",
    filters: ["branch", "customer"],
    run: outstandingAgeing,
  },
  {
    key: "revenue-by-lane",
    title: "Revenue by lane",
    description:
      "Booked value and weight per lane. Invoiced revenue fills in once billing is live.",
    group: "financial",
    permission: "report.financial",
    icon: "TrendingUp",
    filters: ["dates", "customer", "serviceType", "mode"],
    run: revenueByLane,
  },
  {
    key: "cod-register",
    title: "COD collected, pending & remitted",
    description:
      "Cash collected at the door, what has been deposited, and how long the rest has been held.",
    group: "financial",
    permission: "report.financial",
    icon: "Wallet",
    filters: ["dates", "branch", "customer"],
    run: codRegister,
  },
  {
    key: "trip-expense-register",
    title: "Trip expense register",
    description:
      "Diesel, toll, loading and the rest, by trip, with approval state.",
    group: "financial",
    permission: "report.financial",
    icon: "Fuel",
    filters: ["dates", "branch"],
    run: tripExpenseRegister,
  },
  {
    key: "vendor-payable",
    title: "Vendor payable & reconciliation",
    description:
      "What each transporter is owed: billed, paid and outstanding per vendor. Reconciliation against the rate contract arrives with Phase 6.",
    group: "financial",
    permission: "report.financial",
    icon: "Handshake",
    filters: [],
    run: vendorPayable,
  },

  // ── Customer & people ─────────────────────────────────────
  {
    key: "customer-shipments",
    title: "Customer-wise shipments",
    description: "Volume, weight and booked value per customer account.",
    group: "people",
    permission: "report.operations",
    icon: "Contact",
    filters: ["dates", "branch", "customer", "serviceType", "mode"],
    run: customerShipments,
  },
  {
    key: "customer-on-time",
    title: "Customer-wise on-time %",
    description:
      "On-time and first-attempt performance per customer, with the number of shipments no policy covered.",
    group: "people",
    permission: "report.operations",
    icon: "Gauge",
    filters: ["dates", "branch", "customer", "serviceType", "mode"],
    run: customerOnTime,
  },
  {
    key: "complaint-register",
    title: "Complaint register & ageing",
    description:
      "Complaints with both clocks: time to first response and time to resolution.",
    group: "people",
    permission: "report.operations",
    icon: "MessageSquareWarning",
    filters: ["dates", "branch", "customer", "search"],
    run: complaintRegister,
  },
  {
    key: "branch-scorecard",
    title: "Branch scorecard",
    description:
      "Booked, delivered, on time, first attempt, breaches, exceptions and complaints per branch.",
    group: "people",
    permission: "report.management",
    icon: "Building2",
    filters: ["dates", "branch"],
    run: branchScorecard,
  },
  {
    key: "driver-scorecard",
    title: "Driver scorecard",
    description:
      "Trips, distance and on-time arrival, judged only against trips that carried a plan.",
    group: "people",
    permission: "report.management",
    icon: "IdCard",
    filters: ["dates", "branch"],
    run: driverScorecard,
  },
  {
    key: "agent-scorecard",
    title: "Delivery agent scorecard",
    description:
      "Runs, tasks, first-attempt success and COD handled per delivery agent.",
    group: "people",
    permission: "report.management",
    icon: "Bike",
    filters: ["dates", "branch"],
    run: agentScorecard,
  },
];

const BY_KEY = new Map(REPORTS.map((report) => [report.key, report]));

export function reportFor(key: string): ReportDef | undefined {
  return BY_KEY.get(key);
}

/** The reports this user may actually run. The index shows nothing else. */
export function visibleReports(permissions: ReadonlySet<string>): ReportDef[] {
  return REPORTS.filter((report) => permissions.has(report.permission));
}

export const REPORT_GROUPS: ReportGroup[] = ["operations", "financial", "people"];
