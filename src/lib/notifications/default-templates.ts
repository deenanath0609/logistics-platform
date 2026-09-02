import type {
  NotificationChannel,
  RecipientKind,
} from "@/generated/prisma/client";
import { extractPlaceholders } from "./render";

/**
 * The default template set — BRD §A.15's trigger matrix, written out.
 *
 * Exported as data, not seeded here: seeding is the caller's business, and
 * a template set that installs itself is a template set operations cannot
 * decline. These are starting points. Once a row exists in the database,
 * this file has no further say over it.
 *
 * SMS bodies are kept inside one 160-character GSM-7 segment wherever the
 * variable values allow, because the second segment doubles the price of
 * every booking confirmation the network sends.
 *
 * `dltTemplateId` is deliberately absent on every SMS row. The ids only
 * exist after the DLT portal approves the exact text, which takes one to
 * three weeks — the template editor warns about the gap, and the SMS
 * adapter refuses to send without one rather than letting the operator
 * drop it silently.
 */
export type DefaultTemplate = {
  code: string;
  channel: NotificationChannel;
  eventType: string;
  name: string;
  language: string;
  subject?: string;
  body: string;
  variables: string[];
  recipientKind: RecipientKind;
  isActive: boolean;
};

/**
 * Keeps the declared variable list honest without hand-maintaining it, and
 * decides whether a default ships switched on.
 *
 * **SMS ships off, and this is where that is decided.** An Indian operator
 * will not deliver a transactional SMS until the exact text is registered on
 * the DLT portal, and it accepts an unregistered one and drops it without a
 * delivery report — so a template switched on before its `dltTemplateId`
 * comes back looks perfectly healthy and reaches nobody. Registration takes
 * one to three weeks per carrier. Every other channel ships on.
 *
 * This used to live in `prisma/seed/notifications.ts` as a bare
 * `isActive: tpl.channel !== "SMS"`, which meant this field was carried
 * through the whole file and then ignored: setting `isActive: false` on a
 * default here would have had no effect at all, silently. The seed now
 * honours what this says, so the two cannot drift.
 */
function template(
  input: Omit<DefaultTemplate, "variables" | "language" | "isActive"> &
    Partial<Pick<DefaultTemplate, "language" | "isActive">>,
): DefaultTemplate {
  const declared = new Set([
    ...extractPlaceholders(input.body),
    ...extractPlaceholders(input.subject ?? ""),
  ]);

  return {
    language: "en",
    ...input,
    isActive: input.isActive ?? input.channel !== "SMS",
    variables: [...declared],
  };
}

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  // ── Booking created ─────────────────────────────────────
  template({
    code: "BOOKING_CREATED",
    channel: "SMS",
    eventType: "shipment.booking_created",
    name: "Booking confirmation to consignor",
    recipientKind: "CONSIGNOR",
    body:
      "{{brandName}}: Booking confirmed. LR {{lrNumber}}, {{packageCount}} pkg " +
      "to {{consigneeName}}, {{destinationCity}}. Track: {{trackingUrl}}",
  }),
  template({
    code: "BOOKING_CREATED",
    channel: "EMAIL",
    eventType: "shipment.booking_created",
    name: "Booking confirmation to consignor",
    recipientKind: "CONSIGNOR",
    subject: "Booking confirmed — {{lrNumber}}",
    body:
      "Dear {{consignorName}},\n\n" +
      "Your consignment has been booked.\n\n" +
      "LR number: {{lrNumber}}\n" +
      "Consignee: {{consigneeName}}, {{destinationCity}}\n" +
      "Packages: {{packageCount}}\n" +
      "Chargeable weight: {{chargeableWeight}} kg\n" +
      "Expected delivery: {{expectedDeliveryDate}}\n\n" +
      "Track it at {{trackingUrl}}\n\n" +
      "{{brandName}} · {{supportPhone}}",
  }),

  // ── Pickup assigned ─────────────────────────────────────
  template({
    code: "PICKUP_ASSIGNED",
    channel: "SMS",
    eventType: "shipment.pickup_assigned",
    name: "Pickup executive assigned",
    recipientKind: "CONSIGNOR",
    body:
      "{{brandName}}: {{pickupExecutive}} will collect LR {{lrNumber}} " +
      "{{pickupSlot}}. Please keep the consignment ready.",
  }),

  // ── Picked up ───────────────────────────────────────────
  template({
    code: "PICKED_UP",
    channel: "SMS",
    eventType: "shipment.pickup_completed",
    name: "Pickup done — count and weight to consignor",
    recipientKind: "CONSIGNOR",
    body:
      "{{brandName}}: Picked up LR {{lrNumber}} — {{pickedUpPackages}} pkg, " +
      "{{pickedUpWeight}} kg. Track: {{trackingUrl}}",
  }),
  template({
    code: "PICKED_UP",
    channel: "WHATSAPP",
    eventType: "shipment.pickup_completed",
    name: "Shipment on its way — to consignee",
    recipientKind: "CONSIGNEE",
    body:
      "Hello {{consigneeName}}, a consignment from {{consignorName}} is on " +
      "its way to you. LR {{lrNumber}}. Track it here: {{trackingUrl}}",
  }),

  // ── Dispatched ──────────────────────────────────────────
  template({
    code: "DISPATCHED",
    channel: "SMS",
    eventType: "shipment.gate_out",
    name: "Dispatched — lane and expected date",
    recipientKind: "CONSIGNOR",
    body:
      "{{brandName}}: LR {{lrNumber}} dispatched on {{lane}}. Expected " +
      "{{expectedDeliveryDate}}. Track: {{trackingUrl}}",
  }),
  template({
    code: "DISPATCHED",
    channel: "EMAIL",
    eventType: "shipment.gate_out",
    name: "Dispatched — to consignee",
    recipientKind: "CONSIGNEE",
    subject: "{{lrNumber}} is on its way — expected {{expectedDeliveryDate}}",
    body:
      "Dear {{consigneeName}},\n\n" +
      "Consignment {{lrNumber}} from {{consignorName}} has left " +
      "{{originBranch}} on {{lane}}.\n\n" +
      "Expected delivery: {{expectedDeliveryDate}}\n" +
      "Packages: {{packageCount}}\n\n" +
      "Track it at {{trackingUrl}}\n\n" +
      "{{brandName}} · {{supportPhone}}",
  }),

  // ── Reached destination city ────────────────────────────
  //
  // `shipment.gate_in` fires at every hub on the route. The dispatcher only
  // acts on it when the scanning branch is the destination branch, so this
  // template does not need a condition of its own.
  template({
    code: "REACHED_DESTINATION",
    channel: "SMS",
    eventType: "shipment.gate_in",
    name: "Arrived in destination city",
    recipientKind: "CONSIGNEE",
    body:
      "{{brandName}}: LR {{lrNumber}} has reached {{destinationCity}} and " +
      "will be out for delivery shortly. Track: {{trackingUrl}}",
  }),

  // ── Out for delivery ────────────────────────────────────
  template({
    code: "OUT_FOR_DELIVERY",
    channel: "SMS",
    eventType: "shipment.run_started",
    name: "Out for delivery — agent name and masked phone",
    recipientKind: "CONSIGNEE",
    body:
      "{{brandName}}: LR {{lrNumber}} is out for delivery with " +
      "{{agentName}} ({{agentPhoneMasked}}). COD due: {{codAmount}}.",
  }),
  template({
    code: "OUT_FOR_DELIVERY",
    channel: "WHATSAPP",
    eventType: "shipment.run_started",
    name: "Out for delivery — to consignee",
    recipientKind: "CONSIGNEE",
    body:
      "Hello {{consigneeName}}, your consignment {{lrNumber}} is out for " +
      "delivery today with {{agentName}} ({{agentPhoneMasked}}). " +
      "Please keep {{codAmount}} ready if this is a COD consignment.",
  }),
  //
  // The code itself is a separate trigger because it is issued at the door,
  // not when the run starts — the agent taps "send OTP" standing outside.
  template({
    code: "DELIVERY_OTP",
    channel: "SMS",
    eventType: "notification.delivery_otp",
    name: "Delivery OTP to consignee",
    recipientKind: "CONSIGNEE",
    body:
      "{{otpCode}} is your {{brandName}} delivery code for LR {{lrNumber}}. " +
      "Valid {{otpValidMinutes}} min. Share it only with the delivery agent.",
  }),

  // ── Delivery failed ─────────────────────────────────────
  template({
    code: "DELIVERY_FAILED_CONSIGNOR",
    channel: "SMS",
    eventType: "shipment.delivery_attempted",
    name: "Failed attempt — to consignor",
    recipientKind: "CONSIGNOR",
    body:
      "{{brandName}}: Delivery of LR {{lrNumber}} failed — {{failureReason}}. " +
      "Next attempt {{nextAttemptDate}}. Details: {{trackingUrl}}",
  }),
  template({
    code: "DELIVERY_FAILED_CONSIGNEE",
    channel: "SMS",
    eventType: "shipment.delivery_attempted",
    name: "Failed attempt — reschedule link to consignee",
    recipientKind: "CONSIGNEE",
    body:
      "{{brandName}}: We could not deliver LR {{lrNumber}} — " +
      "{{failureReason}}. Pick a new slot: {{rescheduleUrl}}",
  }),
  template({
    code: "DELIVERY_FAILED",
    channel: "EMAIL",
    eventType: "shipment.delivery_attempted",
    name: "Failed attempt — to consignor",
    recipientKind: "CONSIGNOR",
    subject: "Delivery attempt {{attemptNumber}} failed — {{lrNumber}}",
    body:
      "Dear {{consignorName}},\n\n" +
      "Attempt {{attemptNumber}} to deliver consignment {{lrNumber}} to " +
      "{{consigneeName}} at {{destinationCity}} was unsuccessful.\n\n" +
      "Reason: {{failureReason}}\n" +
      "Next attempt: {{nextAttemptDate}}\n\n" +
      "Full history at {{trackingUrl}}\n\n" +
      "{{brandName}} · {{supportPhone}}",
  }),

  // ── Delivered ───────────────────────────────────────────
  template({
    code: "DELIVERED",
    channel: "SMS",
    eventType: "shipment.delivered",
    name: "Delivered — POD link to consignor",
    recipientKind: "CONSIGNOR",
    body:
      "{{brandName}}: LR {{lrNumber}} delivered to {{receiverName}} on " +
      "{{deliveredAt}}. POD: {{podUrl}}",
  }),
  template({
    code: "DELIVERED",
    channel: "WHATSAPP",
    eventType: "shipment.delivered",
    name: "Delivery receipt to consignee",
    recipientKind: "CONSIGNEE",
    body:
      "Hello {{consigneeName}}, consignment {{lrNumber}} was delivered on " +
      "{{deliveredAt}} and signed for by {{receiverName}}. " +
      "Receipt: {{podUrl}}",
  }),
  template({
    code: "DELIVERED",
    channel: "EMAIL",
    eventType: "shipment.delivered",
    name: "Delivered — POD to consignor",
    recipientKind: "CONSIGNOR",
    subject: "Delivered — {{lrNumber}}",
    body:
      "Dear {{consignorName}},\n\n" +
      "Consignment {{lrNumber}} was delivered to {{consigneeName}} at " +
      "{{destinationCity}} on {{deliveredAt}}, signed for by " +
      "{{receiverName}}.\n\n" +
      "Packages: {{packageCount}}\n" +
      "Proof of delivery: {{podUrl}}\n\n" +
      "{{brandName}} · {{supportPhone}}",
  }),

  // ── Reweighed at the hub ────────────────────────
  //
  // Only sent when the revision is past the configured tolerance — a
  // 200-gram correction is not worth an SMS, and telling a customer about
  // every scale reading trains them to ignore the one that matters. The
  // point is that they hear it from us before the invoice arrives.
  template({
    code: "SHIPMENT_REWEIGHED",
    channel: "SMS",
    eventType: "shipment.reweighed",
    name: "Reweighed — revised charge to consignor",
    recipientKind: "CONSIGNOR",
    body:
      "{{brandName}}: LR {{lrNumber}} weighed {{chargeableWeight}} kg at our " +
      "hub against {{previousChargeableWeight}} kg booked. Revised charge " +
      "{{revisedTotal}}. Queries: {{supportPhone}}",
  }),
  template({
    code: "SHIPMENT_REWEIGHED",
    channel: "EMAIL",
    eventType: "shipment.reweighed",
    name: "Reweighed — revised charge to consignor",
    recipientKind: "CONSIGNOR",
    subject: "Revised weight on {{lrNumber}} — {{revisedTotal}}",
    body:
      "Dear {{consignorName}},\n\n" +
      "Consignment {{lrNumber}} was weighed at our hub and the chargeable " +
      "weight has been revised.\n\n" +
      "Booked weight: {{previousChargeableWeight}} kg\n" +
      "Weighed at hub: {{chargeableWeight}} kg\n" +
      "Previous charge: {{previousTotal}}\n" +
      "Revised charge: {{revisedTotal}} (a difference of " +
      "{{amountDifference}})\n\n" +
      "The weighbridge record is available on request. If you believe the " +
      "reading is wrong, tell us before the invoice is settled and we will " +
      "re-verify.\n\n" +
      "{{brandName}} · {{supportPhone}}",
  }),

  // ── COD remittance ──────────────────────────────────────
  //
  // Nothing emits `cod.remittance` yet — remittance runs are Phase 6. The
  // template is here so the text is agreed and DLT-registered before the
  // emitter lands, which is the whole point of starting registration early.
  template({
    code: "COD_REMITTANCE",
    channel: "EMAIL",
    eventType: "cod.remittance",
    name: "COD remittance advice",
    recipientKind: "CUSTOMER_USER",
    subject: "COD remittance {{remittanceReference}} — {{netAmount}}",
    body:
      "Dear customer,\n\n" +
      "COD remittance {{remittanceReference}} for {{remittancePeriod}} has " +
      "been released.\n\n" +
      "Gross collected: {{grossAmount}}\n" +
      "Handling fee: {{feeAmount}}\n" +
      "Net transferred: {{netAmount}}\n\n" +
      "The remittance advice with the consignment-level breakup is attached " +
      "to your portal account.\n\n" +
      "{{brandName}} · {{supportPhone}}",
  }),
  template({
    code: "COD_REMITTANCE",
    channel: "SMS",
    eventType: "cod.remittance",
    name: "COD remittance released",
    recipientKind: "CUSTOMER_USER",
    body:
      "{{brandName}}: COD remittance {{remittanceReference}} of " +
      "{{netAmount}} for {{remittancePeriod}} has been released.",
  }),
];

/** SMS templates in the default set, for the DLT registration checklist. */
export function smsTemplatesNeedingDlt(): DefaultTemplate[] {
  return DEFAULT_TEMPLATES.filter((t) => t.channel === "SMS");
}
