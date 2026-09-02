import { format } from "date-fns";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import type { NotificationChannel, RecipientKind } from "@/generated/prisma/client";
import type { TemplateVariables } from "./render";
import { carrierIdentity, firstConfigured, trackingLink } from "./carrier";
import { maskPhone } from "./mask";

/**
 * Everything a template might need about one shipment, loaded once per
 * outbox event and shared by every template that fires from it.
 *
 * The alternative — each template resolving its own variables — turns a
 * delivered consignment with four templates into four identical queries on
 * a table that is already the busiest in the system.
 */

export type ShipmentContext = Awaited<
  ReturnType<typeof loadShipmentContext>
>;

export async function loadShipmentContext(shipmentId: string) {
  return prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: {
      id: true,
      lrNumber: true,
      currentStatus: true,
      packageCount: true,
      chargeableWeight: true,
      paymentType: true,
      codAmount: true,
      expectedDeliveryAt: true,
      deliveredAt: true,
      pickedUpAt: true,
      attemptCount: true,
      originBranchId: true,
      destinationBranchId: true,

      consignorId: true,
      consignorName: true,
      consignorPhone: true,
      consignorEmail: true,
      consigneeName: true,
      consigneePhone: true,
      consigneeEmail: true,

      consignorCity: { select: { name: true } },
      consigneeCity: { select: { name: true } },
      originBranch: { select: { id: true, name: true, phone: true, email: true } },
      destinationBranch: {
        select: { id: true, name: true, phone: true, email: true },
      },
      consignor: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          portalUsers: {
            where: { isActive: true, deletedAt: null },
            select: { id: true, name: true, email: true, mobile: true },
          },
        },
      },
    },
  });
}

// ────────────────────────────────────────────────────────────
// Recipients
// ────────────────────────────────────────────────────────────

export type ResolvedRecipient = {
  kind: RecipientKind;
  /** Phone or email, unmasked — this is what the gateway is handed. */
  address: string;
  /** For the opt-out lookup and per-customer spend reporting. */
  customerId: string | null;
  customerUserId: string | null;
  branchId: string | null;
};

/**
 * Who this template is addressed to, for this shipment, on this channel.
 *
 * Returns a list because one recipient kind can be several people: a
 * corporate account with four portal logins gets four emails, and each one
 * needs its own log row and its own idempotency key.
 *
 * An empty list is a normal answer, not a failure — plenty of walk-in
 * consignors have no email address.
 */
export function resolveRecipients(
  kind: RecipientKind,
  channel: NotificationChannel,
  context: NonNullable<ShipmentContext>,
): ResolvedRecipient[] {
  const wantsEmail = channel === "EMAIL";
  const customerId = context.consignorId;

  switch (kind) {
    case "CONSIGNOR": {
      const address = wantsEmail ? context.consignorEmail : context.consignorPhone;
      return address
        ? [{ kind, address, customerId, customerUserId: null, branchId: null }]
        : [];
    }

    case "CONSIGNEE": {
      const address = wantsEmail ? context.consigneeEmail : context.consigneePhone;
      // The consignee is not the account holder, so no customerId — their
      // opt-outs are their own, and their messages are not billed to the
      // consignor's notification spend.
      return address
        ? [{ kind, address, customerId: null, customerUserId: null, branchId: null }]
        : [];
    }

    case "CUSTOMER_USER": {
      const users = context.consignor?.portalUsers ?? [];
      return users
        .map((user) => ({
          kind,
          address: (wantsEmail ? user.email : user.mobile) ?? "",
          customerId,
          customerUserId: user.id,
          branchId: null,
        }))
        .filter((recipient) => recipient.address.length > 0);
    }

    case "BRANCH": {
      // Internal copies go to the branch that has to act on them, which for
      // every trigger in the matrix is the destination.
      const branch = context.destinationBranch;
      const address = wantsEmail ? branch?.email : branch?.phone;
      return address
        ? [{ kind, address, customerId: null, customerUserId: null, branchId: branch?.id ?? null }]
        : [];
    }

    case "STAFF":
      // Staff notifications are the exception tower's job, not this one:
      // they are routed by role and rota, which the template has no way to
      // express. Logged as skipped rather than silently dropped.
      return [];
  }
}

// ────────────────────────────────────────────────────────────
// Variables
// ────────────────────────────────────────────────────────────

const money = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function rupees(value: { toString(): string } | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? money.format(parsed) : null;
}

function day(value: Date | null | undefined): string | null {
  return value ? format(value, "d MMM yyyy") : null;
}

function dayTime(value: Date | null | undefined): string | null {
  return value ? format(value, "d MMM yyyy, h:mm a") : null;
}

const PAYMENT_LABEL: Record<string, string> = {
  PAID: "Paid",
  TO_PAY: "To Pay",
  COD: "COD",
  TBB: "To be billed",
  FOC: "Free of cost",
};

/**
 * The variables every shipment event supplies.
 *
 * Anything the event itself knows — a failure reason, an OTP — is merged
 * over the top by `eventVariables`.
 */
export async function baseVariables(
  context: NonNullable<ShipmentContext>,
): Promise<TemplateVariables> {
  const env = getEnv();
  const carrier = await carrierIdentity();

  return {
    // The carrier's trading name, never ours. `APP_NAME` is whatever the
    // shell that started the server was configured with, which is the right
    // answer only when there is no tenant at all — a preview, or a test.
    brandName: carrier?.brandName ?? env.APP_NAME,
    // Branch first, because a consignee ringing about a delivery wants the
    // branch handling it — not a head-office switchboard. Behind it the
    // carrier's own central number, and only then `SUPPORT_PHONE`, so a
    // branch with no number on file cannot fail the render of a delivery
    // confirmation over a footer line.
    supportPhone:
      firstConfigured(
        context.originBranch?.phone,
        context.destinationBranch?.phone,
        carrier?.supportPhone,
        env.SUPPORT_PHONE,
      ) ?? "",
    // No branch ahead of the carrier here, unlike the phone: a branch
    // mailbox is an internal routing address — it is what BRANCH-addressed
    // templates are delivered *to* — while the carrier's support address is
    // the published, monitored one a consignee may reply to.
    supportEmail: carrier?.supportEmail ?? "",

    lrNumber: context.lrNumber,
    trackingUrl: await trackingLink(context.lrNumber),
    consignorName: context.consignorName,
    consigneeName: context.consigneeName,
    originCity: context.consignorCity?.name ?? null,
    destinationCity: context.consigneeCity?.name ?? null,
    originBranch: context.originBranch?.name ?? null,
    destinationBranch: context.destinationBranch?.name ?? null,
    packageCount: context.packageCount,
    chargeableWeight: context.chargeableWeight.toString(),
    expectedDeliveryDate: day(context.expectedDeliveryAt),
    paymentType: PAYMENT_LABEL[context.paymentType] ?? context.paymentType,
    // Zero rather than nothing. Most consignments are not COD, and a
    // template that mentions the amount due at the door has to render for
    // those too — "COD due: 0.00" is a true statement, an unrendered
    // placeholder is not.
    codAmount: rupees(context.codAmount) ?? "0.00",
    currentStatus: context.currentStatus.replaceAll("_", " ").toLowerCase(),
  };
}

/**
 * Variables only one trigger supplies.
 *
 * Each branch costs a query, so they are looked up per event rather than
 * loaded into the base context — a booking confirmation has no reason to
 * find out which delivery agent will eventually carry the parcel.
 */
export async function eventVariables(
  eventType: string,
  context: NonNullable<ShipmentContext>,
  payload: Record<string, unknown>,
): Promise<TemplateVariables> {
  switch (eventType) {
    case "shipment.pickup_assigned": {
      const request = await prisma.pickupRequest.findFirst({
        where: { shipmentId: context.id },
        orderBy: { createdAt: "desc" },
        select: {
          requestedDate: true,
          slot: true,
          assignments: {
            where: { supersededAt: null },
            orderBy: { assignedAt: "desc" },
            take: 1,
            select: { assignedTo: { select: { name: true } } },
          },
        },
      });

      const slot = request
        ? `${day(request.requestedDate)}, ${SLOT_LABEL[request.slot]}`
        : null;

      return {
        pickupExecutive: request?.assignments[0]?.assignedTo.name ?? null,
        pickupSlot: slot,
      };
    }

    case "shipment.pickup_completed":
      return {
        pickedUpPackages: context.packageCount,
        pickedUpWeight: context.chargeableWeight.toString(),
      };

    case "shipment.gate_out":
      return {
        lane: `${context.consignorCity?.name ?? "—"} → ${context.consigneeCity?.name ?? "—"}`,
      };

    case "shipment.run_started": {
      // The event says which run it was. Asking the shipment for its most
      // recently assigned task instead answers with a *later* run on a
      // reattempted consignment, and answers with nothing at all when the
      // out-scan was inferred at the door for a delivery nobody planned a
      // run for — which is where the missing agent names were coming from.
      const runId = asString(payload.runId);
      const taskId = asString(payload.taskId);

      const task = await prisma.deliveryTask.findFirst({
        where: taskId
          ? { id: taskId, shipmentId: context.id }
          : {
              shipmentId: context.id,
              ...(runId ? { runId } : { runId: { not: null } }),
            },
        orderBy: { assignedAt: "desc" },
        select: { run: { select: { agent: { select: { name: true, mobile: true } } } } },
      });

      const agent = task?.run?.agent;
      return {
        agentName: agent?.name ?? null,
        // The consignee is told who is coming, not given a number to call
        // the agent on directly — that is what the support line is for.
        agentPhoneMasked: agent?.mobile ? maskPhone(agent.mobile) : null,
      };
    }

    case "notification.delivery_otp": {
      const ttl = getEnv().OTP_TTL_SECONDS;
      return {
        otpCode: asString(payload.code),
        otpValidMinutes: Math.max(1, Math.round(ttl / 60)),
      };
    }

    case "shipment.delivery_attempted": {
      const attempt = await prisma.deliveryAttempt.findFirst({
        where: { shipmentId: context.id },
        orderBy: { attemptedAt: "desc" },
        select: { attemptNumber: true, reasonCodeId: true, remarks: true },
      });

      const reason = attempt?.reasonCodeId
        ? await prisma.reasonCode.findUnique({
            where: { id: attempt.reasonCodeId },
            select: { name: true },
          })
        : null;

      const next = await prisma.deliveryTask.findFirst({
        where: { shipmentId: context.id, status: "PENDING" },
        orderBy: { assignedAt: "desc" },
        select: { assignedAt: true },
      });

      return {
        failureReason: reason?.name ?? attempt?.remarks ?? "Attempt unsuccessful",
        attemptNumber: attempt?.attemptNumber ?? context.attemptCount,
        nextAttemptDate: day(next?.assignedAt) ?? "the next working day",
        rescheduleUrl: await trackingLink(context.lrNumber, "/reschedule"),
      };
    }

    case "shipment.delivered": {
      const attempt = await prisma.deliveryAttempt.findFirst({
        // "COLLECTED" is the successful outcome on both pickup and
        // delivery attempts — the enum is shared.
        where: { shipmentId: context.id, outcome: "COLLECTED" },
        orderBy: { attemptedAt: "desc" },
        select: { receiverName: true },
      });

      return {
        receiverName: attempt?.receiverName ?? context.consigneeName,
        deliveredAt: dayTime(context.deliveredAt),
        podUrl: await trackingLink(context.lrNumber, "/pod"),
      };
    }

    case "shipment.reweighed": {
      // Every figure comes off the payload, not off the shipment. The
      // dispatcher may work this out minutes after the weighing, and by
      // then a second reweigh could have moved the row again — what the
      // customer is told has to be what was actually measured.
      const previousKg = asString(payload.previousChargeableWeight);
      const revisedKg = asString(payload.chargeableWeight);

      return {
        previousChargeableWeight: previousKg,
        chargeableWeight: revisedKg,
        previousTotal: rupees(asString(payload.previousTotal)),
        revisedTotal: rupees(asString(payload.revisedTotal)),
        amountDifference: rupees(asString(payload.delta)),
        deltaPercent: asString(payload.deltaPercent),
        // Null when the consignment has not been invoiced yet, which is the
        // common case — the invoice will simply bill the revised figure.
        debitNoteNumber: asString(payload.debitNoteNumber),
      };
    }

    default:
      return {};
  }
}

const SLOT_LABEL: Record<string, string> = {
  MORNING: "9 am – 1 pm",
  AFTERNOON: "1 pm – 5 pm",
  EVENING: "5 pm – 8 pm",
  ANYTIME: "any time",
};

function asString(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}
