import type { ShipmentStatus } from "@/generated/prisma/client";
import type { DataScope } from "@/lib/rbac/permissions";
import {
  CUSTOMER_STATUS_LABELS,
  STATUS_LABELS,
  TRANSITIONS,
} from "@/lib/shipment/state-machine";

/**
 * The help screen's content, as data.
 *
 * Almost none of it is written here. The status vocabulary, and the words
 * used to describe how a consignment reaches each status, are read out of
 * `state-machine.ts` — which is the only module allowed to decide what a
 * status becomes, and therefore the only honest source for a page that
 * claims to explain it. A second, hand-written copy of that vocabulary
 * would start drifting the first time somebody added an event, and a help
 * page that describes a product it no longer has is worse than none.
 *
 * The Prisma enum is imported as a *type*. This module is only rendered on
 * the server today, but a value import would drag the Prisma runtime into
 * any client component that later reaches it, and the failure is a 500
 * rather than a compile error.
 */

// ────────────────────────────────────────────────────────────
// How a consignment moves
// ────────────────────────────────────────────────────────────

export type JourneyStage = {
  key: string;
  title: string;
  /** What physically happens, in one or two sentences. */
  blurb: string;
  /** The statuses a consignment wears while this stage is under way. */
  statuses: ShipmentStatus[];
  /** The screen the work is actually done on. */
  href: string;
  /** Permission that screen wants, so the link is offered only if it opens. */
  permission: string;
};

/**
 * Eight stages, covering all twenty statuses between them — asserted in
 * `staff.test.ts` rather than trusted, because a status added to the
 * machine and not placed here would simply be missing from the one page
 * that promises to list them all.
 */
export const JOURNEY: JourneyStage[] = [
  {
    key: "booking",
    title: "Booked at the counter",
    blurb:
      "An LR number is issued from the branch's own series, the freight is rated off the customer's rate card, and the consignment exists. Nothing has moved yet, and everything about the booking is still editable.",
    statuses: ["BOOKED"],
    href: "/shipments/new",
    permission: "shipment.create",
  },
  {
    key: "pickup",
    title: "Collected from the consignor",
    blurb:
      "A pickup executive is given the address, and the consignment is only picked up when they say so from the field. A failed attempt is history rather than a status: the consignment is still owed a collection.",
    statuses: ["PICKUP_ASSIGNED", "PICKED_UP"],
    href: "/pickups",
    permission: "pickup.read",
  },
  {
    key: "hub",
    title: "Received, weighed and sorted",
    blurb:
      "One inbound scan means two different things. At the origin branch it means the consignment has entered the network; at every hub after that it means it has arrived here. Weighing changes the charge but never the status.",
    statuses: ["RECEIVED_AT_ORIGIN", "PROCESSED"],
    href: "/hub",
    permission: "scan.inbound",
  },
  {
    key: "manifest",
    title: "Manifested for a leg",
    blurb:
      "A manifest is the list of consignments travelling one leg together. Adding and removing lines is ordinary work; closing the manifest is what commits the load, and reopening a closed one is recorded.",
    statuses: ["MANIFESTED"],
    href: "/dispatch/manifests",
    permission: "manifest.read",
  },
  {
    key: "trip",
    title: "Dispatched on a trip",
    blurb:
      "Gate-out puts the vehicle on the road. After that the movement is written either by the tracking pipeline, from geofence crossings, or by hand as gate events — and both routes land on the same statuses, so a carrier without GPS reads the same timeline.",
    statuses: [
      "DISPATCHED",
      "IN_TRANSIT",
      "ARRIVED_AT_HUB",
      "RECEIVED_AT_HUB",
    ],
    href: "/dispatch/trips",
    permission: "trip.read",
  },
  {
    key: "delivery",
    title: "Out for delivery",
    blurb:
      "A run is one rider's list for one shift. A failed attempt sends the consignment back to the branch rather than to a status called failed — it is physically at the hub again and owed another attempt, and the failure lives in its own attempt row.",
    statuses: ["ASSIGNED_FOR_DELIVERY", "OUT_FOR_DELIVERY", "DELIVERED"],
    href: "/delivery/runs",
    permission: "delivery.read",
  },
  {
    key: "pod",
    title: "Proof of delivery, then closed",
    blurb:
      "The signature and photographs the rider captured sync up from their phone. Closing is the paperwork end of the journey rather than the physical one, and a closed consignment accepts no further events.",
    statuses: ["POD_UPLOADED", "CLOSED"],
    href: "/delivery/runs",
    permission: "pod.read",
  },
  {
    key: "exception",
    title: "When it ends somewhere else",
    blurb:
      "A return to origin, a cancellation before dispatch, or a loss. Each of these ends the journey away from the consignee, and each is worked from the exception tower rather than from the consignment itself.",
    statuses: [
      "RTO_INITIATED",
      "RTO_IN_TRANSIT",
      "RTO_DELIVERED",
      "LOST",
      "CANCELLED",
    ],
    href: "/exceptions",
    permission: "exception.read",
  },
];

// ────────────────────────────────────────────────────────────
// The status vocabulary
// ────────────────────────────────────────────────────────────

/**
 * One conditional target exists in the whole machine — an inbound scan,
 * which resolves differently at the origin than at a hub. Evaluating it
 * needs a context, and only `currentStatus` is ever read, so the rest of
 * this is a placeholder that the assertion in `staff.test.ts` pins down.
 */
const PROBE = {
  branchId: null,
  destinationBranchId: "destination",
  originBranchId: "origin",
  attemptCount: 0,
  maxDeliveryAttempts: 3,
} as const;

/**
 * What can leave a consignment in `status`, in the state machine's own
 * words — `describe` is the same string the timeline and the audit trail
 * print, so the help page and the event log cannot disagree.
 *
 * Empty for the three statuses no transition reaches: LOST,
 * RTO_IN_TRANSIT and RTO_DELIVERED are only ever arrived at through a
 * status correction, and saying so is more useful than pretending
 * otherwise.
 */
export function arrivalsAt(status: ShipmentStatus): string[] {
  const found = new Set<string>();

  for (const rule of TRANSITIONS) {
    if (typeof rule.to === "function") {
      for (const from of rule.from) {
        if (rule.to({ ...PROBE, currentStatus: from }) === status) {
          found.add(rule.describe);
        }
      }
    } else if (rule.to === status) {
      found.add(rule.describe);
    }
  }

  return [...found];
}

export type StatusNote = {
  status: ShipmentStatus;
  /** What staff call it. */
  label: string;
  /** What the customer is told, which is deliberately coarser. */
  customerLabel: string | null;
  /** The events that put a consignment here. */
  arrivals: string[];
};

export function statusNotesFor(statuses: ShipmentStatus[]): StatusNote[] {
  return statuses.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    customerLabel: CUSTOMER_STATUS_LABELS[status] ?? null,
    arrivals: arrivalsAt(status),
  }));
}

// ────────────────────────────────────────────────────────────
// Who does what
// ────────────────────────────────────────────────────────────

/**
 * The same wording the role editor uses at `/admin/roles`, so a person
 * reading about a scope here and looking at one there sees one product.
 */
export const SCOPE_LABEL: Record<DataScope, string> = {
  OWN: "Own records only",
  BRANCH: "Their branch",
  BRANCH_SET: "Assigned branches",
  NETWORK: "Whole network",
};

// ────────────────────────────────────────────────────────────
// Where to go for the common jobs
// ────────────────────────────────────────────────────────────

export type CommonJob = {
  task: string;
  href: string;
  /**
   * Filtering on the permission alone is enough to keep this list honest
   * about modules too: the session's permissions are already narrowed to
   * what the carrier bought, so a job whose permission a module owns
   * disappears with the module.
   */
  permission: string;
};

export const COMMON_JOBS: CommonJob[] = [
  {
    task: "Book a consignment at the counter",
    href: "/shipments/new",
    permission: "shipment.create",
  },
  {
    task: "Find an LR and read everything that has happened to it",
    href: "/shipments",
    permission: "shipment.read",
  },
  {
    task: "Load a day's bookings from a spreadsheet",
    href: "/shipments/bulk",
    permission: "shipment.bulk_upload",
  },
  {
    task: "Raise a pickup against a customer's address",
    href: "/pickups",
    permission: "pickup.create",
  },
  {
    task: "Receive freight arriving at the dock",
    href: "/hub/scan",
    permission: "scan.inbound",
  },
  {
    task: "Weigh a consignment and correct the charge",
    href: "/hub/weigh",
    permission: "weight.capture",
  },
  {
    task: "Build tonight's manifest for a lane",
    href: "/dispatch/manifests",
    permission: "manifest.create",
  },
  {
    task: "Send a vehicle out and record the gate-out",
    href: "/dispatch/trips",
    permission: "trip.dispatch",
  },
  {
    task: "Plan a delivery run for a rider",
    href: "/delivery/runs",
    permission: "delivery.assign",
  },
  {
    task: "Reconcile the cash a rider brought back",
    href: "/delivery/cod",
    permission: "cod.reconcile",
  },
  {
    task: "See where the vehicles are right now",
    href: "/tracking",
    permission: "tracking.read",
  },
  {
    task: "Work what is late or stuck",
    href: "/exceptions",
    permission: "exception.read",
  },
  {
    task: "Answer a customer's complaint",
    href: "/complaints",
    permission: "complaint.read",
  },
  {
    task: "Run the day's operational numbers",
    href: "/reports",
    permission: "report.operations",
  },
  {
    task: "Raise an invoice, or chase what is owed",
    href: "/finance/invoices",
    permission: "invoice.create",
  },
  {
    task: "Add a colleague, or change what a role may do",
    href: "/admin/users",
    permission: "user.manage",
  },
  {
    task: "Check who changed what, and when",
    href: "/admin/audit",
    permission: "audit.read",
  },
];
