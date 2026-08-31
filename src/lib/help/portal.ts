import type {
  ComplaintCategory,
  CustomerUserRole,
  ShipmentStatus,
} from "@/generated/prisma/client";
import { CATEGORY_LABEL } from "@/lib/complaints/workflow";
import { slaFor } from "@/lib/complaints/sla";
import { toneFor, type PublicTone } from "@/lib/portal/visibility";
import { CUSTOMER_STATUS_LABELS } from "@/lib/shipment/state-machine";

/**
 * The customer help screen's content, as data.
 *
 * Written for somebody who books freight and is not in the trade. The
 * statuses are the ones `CUSTOMER_STATUS_LABELS` already shows them — the
 * portal never sees the internal vocabulary, and a help page that
 * explained "manifested" would be explaining a word this customer will
 * never be shown. The complaint windows are read out of the SLA table
 * rather than typed, so a promise on this page is the promise the product
 * actually keeps.
 *
 * Prisma enums are imported as types only: a value import would pull the
 * Prisma runtime into any client component that reaches this, and the page
 * would 500 instead of failing to compile.
 */

// ────────────────────────────────────────────────────────────
// What each status means
// ────────────────────────────────────────────────────────────

export type CustomerStatusNote = {
  label: string;
  tone: PublicTone;
  meaning: string;
};

/**
 * One line per label, not per status — several internal steps collapse
 * into "In transit" on purpose, and a customer counting six of them would
 * be reading a network diagram they were never meant to see.
 */
const MEANING: Record<string, string> = {
  Booked:
    "We have your consignment on paper and an LR number against it. Nothing has been collected yet.",
  "Pickup scheduled":
    "Someone has been given your address and is coming for it. You will get the same update by SMS.",
  "Picked up":
    "It is with our executive and on its way to the branch it will travel from.",
  "In transit":
    "It is moving through our network. Sorting, loading and each leg of the journey all show as this — the next line you see will be a new city.",
  Dispatched: "It has left on a vehicle for the next leg.",
  "Reached destination city":
    "It has arrived in the delivery city and is waiting to be put on a delivery run.",
  "Out for delivery soon":
    "It has been added to a rider's list. Delivery is usually the same day or the next working one.",
  "Out for delivery": "A rider has it and is on the way to the consignee.",
  Delivered:
    "Handed over. The proof of delivery — signature and photograph — appears against the consignment shortly afterwards.",
  "Being returned to sender":
    "Delivery could not be completed, so it is coming back to you. Raise a complaint if nobody has told you why.",
  "Returned to sender": "It is back with you rather than with the consignee.",
  Cancelled:
    "The booking was cancelled before it moved. Nothing was collected and nothing will be charged for carriage.",
};

/**
 * The labels a customer can be shown, in the order a consignment meets
 * them.
 *
 * Deduplicated by label, keeping the *last* status that carries it. Tone
 * is what the pill on your shipment list uses, and taking the last one is
 * what makes "In transit" blue rather than grey: the label first appears
 * against a consignment sitting at a branch and finally against one on the
 * road, and the road is what the words describe.
 */
export function customerStatusNotes(): CustomerStatusNote[] {
  const order: string[] = [];
  const tones = new Map<string, PublicTone>();

  for (const [status, label] of Object.entries(CUSTOMER_STATUS_LABELS)) {
    if (!label) continue;
    if (!tones.has(label)) order.push(label);
    tones.set(label, toneFor(status as ShipmentStatus));
  }

  return order.map((label) => ({
    label,
    tone: tones.get(label) ?? "moving",
    meaning: MEANING[label] ?? "",
  }));
}

// ────────────────────────────────────────────────────────────
// Complaints
// ────────────────────────────────────────────────────────────

export type ComplaintNote = {
  category: ComplaintCategory;
  label: string;
  /** Hours to a human reply, at ordinary priority. */
  responseHours: number;
  /** Hours to an answer, at ordinary priority. */
  resolutionHours: number;
};

/**
 * The categories, ordered by how fast they are answered.
 *
 * Both figures come from `slaFor` at NORMAL priority — the default a
 * portal complaint is raised at. Your carrier's desk may raise the
 * priority, which only shortens them.
 */
export function complaintNotes(): ComplaintNote[] {
  return (Object.keys(CATEGORY_LABEL) as ComplaintCategory[])
    .map((category) => {
      const target = slaFor(category, "NORMAL");
      return {
        category,
        label: CATEGORY_LABEL[category],
        responseHours: Math.round(target.responseMinutes / 60),
        resolutionHours: Math.round(target.resolutionMinutes / 60),
      };
    })
    .sort(
      (a, b) =>
        a.responseHours - b.responseHours ||
        a.resolutionHours - b.resolutionHours ||
        a.label.localeCompare(b.label),
    );
}

// ────────────────────────────────────────────────────────────
// Who on your side can do what
// ────────────────────────────────────────────────────────────

export const PORTAL_ROLE_NOTE: Record<
  CustomerUserRole,
  { label: string; can: string }
> = {
  OWNER: {
    label: "Owner",
    can: "Everything below, and manages the logins on this account.",
  },
  MEMBER: {
    label: "Member",
    can: "Books consignments, requests pickups, keeps the address book and raises complaints.",
  },
  VIEWER: {
    label: "Viewer",
    can: "Looks at consignments, invoices and complaints. Cannot book or change anything.",
  },
};
