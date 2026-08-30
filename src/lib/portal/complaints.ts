import { prisma, tenantTransaction } from "@/lib/prisma";
import type {
  ComplaintCategory,
  ComplaintPriority,
  ComplaintStatus,
} from "@/generated/prisma/client";
import type { CustomerSession } from "@/lib/auth/customer-session";
import { nextNumber } from "@/lib/numbering/number-series";
import { deadlinesFrom, ageMinutes, formatAge } from "@/lib/complaints/sla";
import { STATUS_LABEL, CATEGORY_LABEL, isSettled } from "@/lib/complaints/workflow";
import { customerVisibleMessages } from "@/lib/complaints/service";
import { customerOwnedFilter, customerShipmentFilter } from "./visibility";

/**
 * Complaints, from the customer's side.
 *
 * The workflow, the SLA and the message store all belong to
 * `src/lib/complaints/**` and are not duplicated here. What this module
 * adds is the two things that make the same records safe to show a
 * customer:
 *
 *  1. **Account scoping in the data layer.** Every read starts from
 *     `customerOwnedFilter(session)`, which writes `customerId` and throws
 *     rather than build an unscoped filter. A complaint id from another
 *     account resolves to nothing — there is no "fetch then check".
 *
 *  2. **The internal note never travels.** `ComplaintMessage.isInternal`
 *     defaults to true, and the read side goes through
 *     `customerVisibleMessages()` — the filter that lives next to the
 *     column, not a copy of it typed out here. `toPortalThread` then drops
 *     anything still flagged internal, so a future caller that hands this
 *     projection a raw row cannot leak one either. Belt and braces, on the
 *     one boundary where the failure is a customer reading what an
 *     operations manager said about them.
 */

// ────────────────────────────────────────────────────────────
// What a customer may raise
// ────────────────────────────────────────────────────────────

/**
 * docs/BRD.html §A.14. The same nine the operations desk uses — a
 * customer choosing from a shorter list would simply pick "Other" and the
 * complaint would land in the wrong queue with the wrong SLA.
 */
export const PORTAL_COMPLAINT_CATEGORIES: ReadonlyArray<{
  value: ComplaintCategory;
  label: string;
  help: string;
}> = [
  { value: "DELAY", label: "Late delivery", help: "It has not arrived when it should have." },
  { value: "DAMAGE", label: "Damaged goods", help: "It arrived, but not in one piece." },
  { value: "MISSING", label: "Missing consignment", help: "Packages short, or nothing arrived at all." },
  { value: "WRONG_DELIVERY", label: "Delivered to the wrong place", help: "Someone else received it." },
  { value: "BILLING", label: "Billing or charges", help: "An invoice, a rate or a COD amount looks wrong." },
  { value: "POD_ISSUE", label: "Proof of delivery", help: "The POD is missing, unreadable or disputed." },
  { value: "PICKUP_ISSUE", label: "Pickup problem", help: "Nobody came, or came at the wrong time." },
  { value: "BEHAVIOUR", label: "Staff behaviour", help: "How someone conducted themselves." },
  { value: "OTHER", label: "Something else", help: "Anything the list above does not cover." },
];

const CATEGORY_VALUES = new Set<string>(
  PORTAL_COMPLAINT_CATEGORIES.map((option) => option.value),
);

export function isPortalCategory(value: string): value is ComplaintCategory {
  return CATEGORY_VALUES.has(value);
}

/**
 * Priority is derived, not chosen.
 *
 * Handing a customer a priority selector produces one outcome within a
 * fortnight: every complaint is CRITICAL, the SLA dashboard is permanently
 * red, and the genuinely urgent ones stop standing out. The category
 * already carries the urgency — a missing consignment is a person standing
 * next to an empty space, and a billing query is not — so the category
 * decides. Operations can re-prioritise from their own screen, which is
 * where the judgement belongs.
 */
export function priorityForCategory(
  category: ComplaintCategory,
): ComplaintPriority {
  switch (category) {
    case "MISSING":
    case "WRONG_DELIVERY":
      return "HIGH";
    case "DAMAGE":
    case "PICKUP_ISSUE":
      return "NORMAL";
    default:
      return "NORMAL";
  }
}

// ────────────────────────────────────────────────────────────
// The thread projection
// ────────────────────────────────────────────────────────────

/**
 * Who said it, as far as the customer is concerned.
 *
 * Staff are "team" and are deliberately not named. A named agent on a
 * behaviour complaint invites the customer to take it up with them
 * directly, and the company answering as one voice is the point of having
 * a complaint desk. Their own colleagues *are* named — that is their own
 * account's conversation.
 */
export type PortalAuthorKind = "you" | "colleague" | "team";

export type PortalMessage = {
  id: string;
  body: string;
  /** ISO 8601. A plain string cannot smuggle a relation or a Decimal. */
  at: string;
  author: PortalAuthorKind;
  /** Null for the team, whose individuals are not named. */
  authorName: string | null;
};

/**
 * Accepts a message row as Prisma hands it over, including one that still
 * carries `isInternal`. That is the point: handing this function a raw row
 * must be safe.
 */
export type InternalMessageLike = {
  id: string;
  body: string;
  createdAt: Date;
  authorUserId?: string | null;
  authorCustomerUserId?: string | null;
  /** Present only when the caller selected it. `true` is dropped. */
  isInternal?: boolean;
  [extra: string]: unknown;
};

export type ThreadContext = {
  /** The signed-in customer user, so their own messages read as "you". */
  viewerId: string;
  /** Names of this account's own logins, by id. */
  colleagueNames: ReadonlyMap<string, string>;
};

/**
 * The customer-facing thread.
 *
 * Two independent guards, because one is not enough on this boundary:
 * the query filters on `isInternal: false` through
 * `customerVisibleMessages()`, and this projection drops any row that
 * arrives flagged internal anyway. A message with no author at all is
 * dropped too — an unattributable line in a complaint thread is a bug, and
 * showing it to a customer is the worst way to find out.
 */
export function toPortalThread(
  messages: readonly InternalMessageLike[],
  context: ThreadContext,
): PortalMessage[] {
  const out: PortalMessage[] = [];

  for (const message of messages) {
    if (message.isInternal === true) continue;

    const customerAuthor = message.authorCustomerUserId ?? null;
    const staffAuthor = message.authorUserId ?? null;

    if (!customerAuthor && !staffAuthor) continue;

    const author: PortalAuthorKind = !customerAuthor
      ? "team"
      : customerAuthor === context.viewerId
        ? "you"
        : "colleague";

    out.push({
      id: message.id,
      body: message.body,
      at: message.createdAt.toISOString(),
      author,
      authorName:
        author === "team"
          ? null
          : (context.colleagueNames.get(customerAuthor as string) ?? null),
    });
  }

  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// ────────────────────────────────────────────────────────────
// Reads
// ────────────────────────────────────────────────────────────

export type PortalComplaintRow = {
  id: string;
  number: string;
  category: ComplaintCategory;
  categoryLabel: string;
  status: ComplaintStatus;
  statusLabel: string;
  /** Coarse tone for the pill. The internal SLA state never leaves. */
  tone: "open" | "working" | "settled";
  subject: string;
  createdAt: Date;
  /** "3 h 20 m" — stops at resolution, not at closure. */
  age: string;
  /** True until somebody the customer can hear from has replied. */
  awaitingFirstReply: boolean;
  lrNumber: string | null;
  shipmentId: string | null;
  messageCount: number;
};

function toneFor(status: ComplaintStatus): PortalComplaintRow["tone"] {
  if (isSettled(status)) return "settled";
  return status === "OPEN" || status === "REOPENED" ? "open" : "working";
}

/** Every complaint on this account, newest first. */
export async function listPortalComplaints(
  session: CustomerSession,
  options: { take?: number } = {},
): Promise<PortalComplaintRow[]> {
  const rows = await prisma.complaint.findMany({
    // Spread first and write nothing else that touches `customerId`.
    where: { ...customerOwnedFilter(session) },
    orderBy: { createdAt: "desc" },
    take: options.take ?? 100,
    select: {
      id: true,
      number: true,
      category: true,
      status: true,
      subject: true,
      createdAt: true,
      resolvedAt: true,
      firstResponseAt: true,
      shipmentId: true,
      shipment: { select: { lrNumber: true } },
      _count: { select: { messages: { where: { isInternal: false } } } },
    },
  });

  const now = new Date();

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    category: row.category,
    categoryLabel: CATEGORY_LABEL[row.category] ?? row.category,
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] ?? row.status,
    tone: toneFor(row.status),
    subject: row.subject,
    createdAt: row.createdAt,
    age: formatAge(
      ageMinutes({ createdAt: row.createdAt, resolvedAt: row.resolvedAt }, now),
    ),
    awaitingFirstReply: row.firstResponseAt === null && !isSettled(row.status),
    lrNumber: row.shipment?.lrNumber ?? null,
    shipmentId: row.shipmentId,
    messageCount: row._count.messages,
  }));
}

export type PortalComplaintDetail = PortalComplaintRow & {
  description: string;
  /** The resolution the team recorded, once there is one. */
  resolution: string | null;
  resolvedAt: Date | null;
  /** True while the customer may still add to the thread. */
  canReply: boolean;
  messages: PortalMessage[];
};

/**
 * One complaint, if and only if it belongs to this account.
 *
 * `findFirst` with the scope spread in, never `findUnique` by id — the
 * ownership check has to be part of the query that fetches the row, not a
 * comparison the next line of code remembers to make.
 */
export async function getPortalComplaint(
  session: CustomerSession,
  id: string,
): Promise<PortalComplaintDetail | null> {
  const complaint = await prisma.complaint.findFirst({
    where: { ...customerOwnedFilter(session), id },
    select: {
      id: true,
      number: true,
      category: true,
      status: true,
      subject: true,
      description: true,
      resolution: true,
      createdAt: true,
      resolvedAt: true,
      firstResponseAt: true,
      shipmentId: true,
      shipment: { select: { lrNumber: true } },
    },
  });

  if (!complaint) return null;

  // The filter is not re-derived here. `customerVisibleMessages` lives
  // beside the column it protects, and this is the only way in.
  const visible = await customerVisibleMessages(complaint.id);

  const colleagueIds = [
    ...new Set(
      visible
        .map((message) => message.authorCustomerUserId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  // Names come from this account's own logins only, so a customer-user id
  // from anywhere else resolves to nothing rather than to a name.
  const colleagues =
    colleagueIds.length === 0
      ? []
      : await prisma.customerUser.findMany({
          where: { id: { in: colleagueIds }, ...customerOwnedFilter(session) },
          select: { id: true, name: true },
        });

  const messages = toPortalThread(visible, {
    viewerId: session.id,
    colleagueNames: new Map(colleagues.map((user) => [user.id, user.name])),
  });

  const now = new Date();

  return {
    id: complaint.id,
    number: complaint.number,
    category: complaint.category,
    categoryLabel: CATEGORY_LABEL[complaint.category] ?? complaint.category,
    status: complaint.status,
    statusLabel: STATUS_LABEL[complaint.status] ?? complaint.status,
    tone: toneFor(complaint.status),
    subject: complaint.subject,
    description: complaint.description,
    resolution: complaint.resolution,
    createdAt: complaint.createdAt,
    resolvedAt: complaint.resolvedAt,
    age: formatAge(
      ageMinutes(
        { createdAt: complaint.createdAt, resolvedAt: complaint.resolvedAt },
        now,
      ),
    ),
    awaitingFirstReply:
      complaint.firstResponseAt === null && !isSettled(complaint.status),
    lrNumber: complaint.shipment?.lrNumber ?? null,
    shipmentId: complaint.shipmentId,
    messageCount: messages.length,
    // A settled complaint still takes replies. A customer telling us "this
    // is not fixed" is the single most important message in the thread,
    // and a disabled box on a prematurely closed complaint sends them back
    // to the phone.
    canReply: true,
    messages,
  };
}

/** Open complaints, for the overview card. */
export async function countOpenPortalComplaints(
  session: CustomerSession,
): Promise<number> {
  return prisma.complaint.count({
    where: {
      ...customerOwnedFilter(session),
      status: { in: ["OPEN", "ASSIGNED", "INVESTIGATING", "ACTION_TAKEN", "REOPENED"] },
    },
  });
}

/** Shipments this account may attach a complaint to. */
export async function complainableShipments(
  session: CustomerSession,
  options: { take?: number } = {},
): Promise<Array<{ id: string; lrNumber: string; toCity: string; bookedAt: Date }>> {
  const rows = await prisma.shipment.findMany({
    where: customerShipmentFilter(session),
    orderBy: { bookedAt: "desc" },
    take: options.take ?? 100,
    select: {
      id: true,
      lrNumber: true,
      bookedAt: true,
      consigneeCity: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    lrNumber: row.lrNumber,
    toCity: row.consigneeCity.name,
    bookedAt: row.bookedAt,
  }));
}

// ────────────────────────────────────────────────────────────
// Writes
// ────────────────────────────────────────────────────────────

export type RaiseComplaintInput = {
  category: ComplaintCategory;
  subject: string;
  description: string;
  /** One of this account's own consignments, or nothing. */
  shipmentId?: string | null;
};

export type PortalComplaintResult =
  | { ok: true; id: string; number: string }
  | { ok: false; error: string; field?: string };

/**
 * Raises a complaint from the portal.
 *
 * Deliberately not `createComplaint` from the complaints service: that
 * function takes a `SessionUser` and stamps `raisedByUserId`, which is a
 * foreign key into the staff table. A portal complaint is raised by a
 * `CustomerUser` and must say so — `raisedByCustomerUserId` exists for
 * exactly this, and borrowing a service principal here would lose the one
 * fact that matters when the desk reads the queue: a real customer is
 * waiting at the other end of this.
 *
 * Everything else is the same path the desk uses: the same numbering
 * inside the same transaction, and the same SLA deadlines from
 * `deadlinesFrom`.
 */
export async function raisePortalComplaint(
  session: CustomerSession,
  input: RaiseComplaintInput,
): Promise<PortalComplaintResult> {
  const subject = input.subject.trim();
  const description = input.description.trim();

  if (subject.length === 0) {
    return { ok: false, error: "Give it a one-line summary.", field: "subject" };
  }
  if (description.length < 10) {
    return {
      ok: false,
      error: "Tell us what happened — a couple of sentences is enough.",
      field: "description",
    };
  }
  if (!isPortalCategory(input.category)) {
    return { ok: false, error: "Choose what it is about.", field: "category" };
  }

  // ── The consignment is not taken on trust ─────────────────
  // The account id is in the WHERE clause, so an LR belonging to somebody
  // else resolves to nothing rather than attaching this account's
  // complaint to another customer's shipment.
  let shipmentId: string | null = null;
  let branchId: string | null = null;

  if (input.shipmentId) {
    const shipment = await prisma.shipment.findFirst({
      where: { ...customerShipmentFilter(session), id: input.shipmentId },
      select: { id: true, destinationBranchId: true },
    });
    if (!shipment) {
      return {
        ok: false,
        error: "That consignment is not on your account.",
        field: "shipmentId",
      };
    }
    shipmentId = shipment.id;
    // The complaint lands with the branch that has to answer for it.
    branchId = shipment.destinationBranchId;
  }

  if (!branchId) {
    const customer = await prisma.customer.findUnique({
      where: { id: session.customerId },
      select: { branchId: true },
    });
    branchId = customer?.branchId ?? null;
  }

  const priority = priorityForCategory(input.category);
  const raisedAt = new Date();
  const { respondBy, resolveBy } = deadlinesFrom(raisedAt, input.category, priority);

  try {
    const created = await tenantTransaction(async (tx) => {
      // Numbered inside the transaction, so an abandoned complaint does
      // not burn a number out of the series.
      const number = await nextNumber(
        { document: "COMPLAINT" },
        tx,
      );

      return tx.complaint.create({
        data: {
          orgId: session.orgId,
          number,
          category: input.category,
          priority,
          status: "OPEN",
          subject,
          description,
          shipmentId,
          // Written unconditionally from the session. Nothing in the input
          // can reach this field.
          customerId: session.customerId,
          branchId,
          raisedByCustomerUserId: session.id,
          respondBy,
          resolveBy,
          createdAt: raisedAt,
        },
        select: { id: true, number: true },
      });
    });

    return { ok: true, ...created };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

export type PortalReplyResult = { ok: true } | { ok: false; error: string };

/**
 * A customer's reply.
 *
 * Written `isInternal: false` explicitly — the column defaults to true and
 * a customer's own words being filed as an internal note would be absurd,
 * but the default is the right one for the column and this is the right
 * place to override it.
 *
 * `firstResponseAt` is deliberately untouched. That clock measures how
 * long the customer waited for *us*; stopping it on their own follow-up
 * would make the SLA measure how talkative they are.
 */
export async function replyToPortalComplaint(
  session: CustomerSession,
  complaintId: string,
  body: string,
): Promise<PortalReplyResult> {
  const text = body.trim();
  if (text.length === 0) return { ok: false, error: "Type something first." };
  if (text.length > 4000) {
    return { ok: false, error: "That is too long — 4,000 characters is the limit." };
  }

  // Ownership is proved by the same query that finds the complaint.
  const complaint = await prisma.complaint.findFirst({
    where: { ...customerOwnedFilter(session), id: complaintId },
    select: { id: true },
  });
  if (!complaint) {
    return { ok: false, error: "That complaint is not on your account." };
  }

  try {
    await prisma.complaintMessage.create({
      data: {
        orgId: session.orgId,
        complaintId: complaint.id,
        body: text,
        authorCustomerUserId: session.id,
        isInternal: false,
      },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("No active number series")) {
    return "We could not number your complaint. Please call your branch — this is our problem, not yours.";
  }

  console.error("[portal complaints]", error);
  return "Something went wrong. Nothing was saved.";
}
