/**
 * The variable catalogue.
 *
 * Templates are master data edited by operations, so the set of names the
 * dispatcher can supply has to be discoverable in the editor rather than
 * learned by reading `dispatch.ts`. This file is that list, and it is the
 * same list the editor's validation checks against.
 *
 * Pure data — imported by both a server action and a client component.
 */

export type VariableSpec = {
  name: string;
  description: string;
  /** Example value, shown in the editor and used for the preview. */
  sample: string;
  /**
   * Event types that supply it. Empty means "every event", which is how
   * the shipment-wide variables are marked.
   */
  events?: string[];
  /**
   * The message is refused rather than sent when this one has no value.
   *
   * The default is the opposite, and deliberately so: most of these are
   * facts about one consignment that may legitimately be blank — a parcel
   * with no COD, a delivery with no run behind it — and refusing the whole
   * message over a blank is how a consignee ends up told nothing at all.
   * Mark a variable required only when the message is actively misleading
   * without it: a delivery code that is not there, a tracking link that
   * goes nowhere.
   */
  required?: boolean;
  /**
   * Never written to the send log.
   *
   * The rendered body is stored so support can answer "what did we
   * actually send them". A one-time code stored next to the number it was
   * sent to is authentication written down, readable by everyone who holds
   * `master.read` — so the gateway gets the real value and the log gets
   * bullets. See `redactSecrets` in `render.ts`.
   */
  secret?: boolean;
};

/** Available on every notification, whatever the trigger. */
export const COMMON_VARIABLES: VariableSpec[] = [
  { name: "brandName", description: "Trading name of the carrier this message goes out as", sample: "Acme Logistics" },
  { name: "supportPhone", description: "Handling branch's number, or the carrier's central one", sample: "1800-000-000" },
  { name: "supportEmail", description: "Carrier's published support address", sample: "support@acme-logistics.example" },
];

/** Available on any event whose aggregate is a shipment. */
export const SHIPMENT_VARIABLES: VariableSpec[] = [
  { name: "lrNumber", description: "Consignment note number", sample: "CL/DEL/2627/000412", required: true },
  { name: "trackingUrl", description: "Public tracking link for this LR", sample: "https://track.example/CL-000412", required: true },
  { name: "consignorName", description: "Sender name", sample: "Sharma Traders" },
  { name: "consigneeName", description: "Receiver name", sample: "Mehta Industries" },
  { name: "originCity", description: "Booking city", sample: "Delhi" },
  { name: "destinationCity", description: "Delivery city", sample: "Jaipur" },
  { name: "originBranch", description: "Origin branch name", sample: "Okhla" },
  { name: "destinationBranch", description: "Destination branch name", sample: "Jaipur City" },
  { name: "packageCount", description: "Number of packages", sample: "3" },
  { name: "chargeableWeight", description: "Weight charged on, in kg", sample: "42.500" },
  { name: "expectedDeliveryDate", description: "Committed delivery date", sample: "29 Aug 2026" },
  { name: "paymentType", description: "Paid, To Pay, or COD", sample: "COD" },
  { name: "codAmount", description: "Amount to collect at the door", sample: "12,400.00" },
  { name: "currentStatus", description: "Status after this event", sample: "Out for delivery" },
];

/** Supplied only by the event named against each one. */
export const EVENT_VARIABLES: VariableSpec[] = [
  { name: "pickupExecutive", description: "Name of the assigned pickup executive", sample: "Ravi Kumar", events: ["shipment.pickup_assigned"] },
  { name: "pickupSlot", description: "Agreed pickup window", sample: "Today, 2–5 pm", events: ["shipment.pickup_assigned"] },
  { name: "pickedUpPackages", description: "Packages actually collected", sample: "3", events: ["shipment.pickup_completed"] },
  { name: "pickedUpWeight", description: "Weight captured at pickup, in kg", sample: "42.500", events: ["shipment.pickup_completed"] },
  { name: "lane", description: "Origin to destination, as printed on the manifest", sample: "Delhi → Jaipur", events: ["shipment.gate_out"] },
  { name: "agentName", description: "Delivery agent out with the parcel", sample: "Imran Sheikh", events: ["shipment.run_started"] },
  { name: "agentPhoneMasked", description: "Agent's number, partially masked", sample: "98•••43210", events: ["shipment.run_started"] },
  { name: "otpCode", description: "One-time code the consignee reads out at the door", sample: "4821", events: ["notification.delivery_otp"], required: true, secret: true },
  { name: "otpValidMinutes", description: "Minutes the code stays valid", sample: "5", events: ["notification.delivery_otp"] },
  { name: "failureReason", description: "Why the attempt failed", sample: "Consignee not available", events: ["shipment.delivery_attempted"] },
  { name: "attemptNumber", description: "Which attempt this was", sample: "1", events: ["shipment.delivery_attempted"] },
  { name: "nextAttemptDate", description: "When the next attempt is scheduled", sample: "29 Aug 2026", events: ["shipment.delivery_attempted"] },
  { name: "rescheduleUrl", description: "Link for the consignee to pick a new slot", sample: "https://track.example/CL-000412/reschedule", events: ["shipment.delivery_attempted"] },
  { name: "receiverName", description: "Who signed for the consignment", sample: "Anil Mehta", events: ["shipment.delivered"] },
  { name: "deliveredAt", description: "Delivery date and time", sample: "28 Aug 2026, 3:42 pm", events: ["shipment.delivered"] },
  { name: "podUrl", description: "Link to the proof of delivery", sample: "https://track.example/CL-000412/pod", events: ["shipment.delivered"] },
  // Reweigh. Every figure comes off the event payload rather than off the
  // shipment, because a second weighing can move the row before the
  // dispatcher gets to the first — see `eventVariables`.
  { name: "previousChargeableWeight", description: "Weight the booking was charged on, in kg", sample: "42.500", events: ["shipment.reweighed"] },
  { name: "previousTotal", description: "Charge before the reweigh", sample: "3,410.00", events: ["shipment.reweighed"] },
  { name: "revisedTotal", description: "Charge after the reweigh", sample: "4,180.00", events: ["shipment.reweighed"] },
  { name: "amountDifference", description: "Difference between the two charges", sample: "770.00", events: ["shipment.reweighed"] },
  { name: "deltaPercent", description: "Difference as a percentage of the booked charge", sample: "22.58", events: ["shipment.reweighed"] },
  { name: "debitNoteNumber", description: "Debit note raised for the difference, where one was", sample: "DN/2627/0114", events: ["shipment.reweighed"] },
  { name: "remittanceReference", description: "Remittance advice reference", sample: "REM/2627/0031", events: ["cod.remittance"] },
  { name: "remittancePeriod", description: "Period the remittance covers", sample: "16–31 Aug 2026", events: ["cod.remittance"] },
  { name: "grossAmount", description: "COD collected before deductions", sample: "2,41,000.00", events: ["cod.remittance"] },
  { name: "feeAmount", description: "COD handling fee deducted", sample: "4,820.00", events: ["cod.remittance"] },
  { name: "netAmount", description: "Amount actually transferred", sample: "2,36,180.00", events: ["cod.remittance"] },
];

export const ALL_VARIABLES: VariableSpec[] = [
  ...COMMON_VARIABLES,
  ...SHIPMENT_VARIABLES,
  ...EVENT_VARIABLES,
];

/** The names the dispatcher can supply for one event type. */
export function variablesForEvent(eventType: string): VariableSpec[] {
  return ALL_VARIABLES.filter(
    (spec) => !spec.events || spec.events.includes(eventType),
  );
}

/**
 * The names one trigger can supply, as a set.
 *
 * The dispatcher's test for "is this placeholder a typo": a name in here
 * that happens to be empty for this consignment is a blank field, and a
 * name that is not in here at all is a mistake in the template.
 */
export function knownVariables(eventType: string): Set<string> {
  return new Set(variablesForEvent(eventType).map((spec) => spec.name));
}

/** Names the message may not go out without. See `VariableSpec.required`. */
export function requiredVariables(eventType: string): Set<string> {
  return new Set(
    variablesForEvent(eventType)
      .filter((spec) => spec.required)
      .map((spec) => spec.name),
  );
}

/**
 * Names whose value must never reach the send log.
 *
 * Not per event: a variable that is a secret under one trigger is a secret
 * under every one, and a template pointed at the wrong trigger must not be
 * able to launder it into the log.
 */
export const SECRET_VARIABLES: ReadonlySet<string> = new Set(
  ALL_VARIABLES.filter((spec) => spec.secret).map((spec) => spec.name),
);

/** Sample values for the editor's live preview. */
export function sampleVariables(eventType: string): Record<string, string> {
  return Object.fromEntries(
    variablesForEvent(eventType).map((spec) => [spec.name, spec.sample]),
  );
}

/** Event types the trigger matrix covers, for the editor's dropdown. */
export const TRIGGER_EVENTS: Array<{ value: string; label: string }> = [
  { value: "shipment.booking_created", label: "Booking created" },
  { value: "shipment.pickup_assigned", label: "Pickup assigned" },
  { value: "shipment.pickup_completed", label: "Picked up" },
  { value: "shipment.gate_out", label: "Dispatched" },
  { value: "shipment.gate_in", label: "Reached destination city" },
  { value: "shipment.reweighed", label: "Reweighed at the hub" },
  { value: "shipment.run_started", label: "Out for delivery" },
  { value: "notification.delivery_otp", label: "Delivery OTP" },
  { value: "shipment.delivery_attempted", label: "Delivery failed" },
  { value: "shipment.delivered", label: "Delivered" },
  { value: "shipment.rto_initiated", label: "Return to origin started" },
  { value: "shipment.cancelled", label: "Booking cancelled" },
  { value: "cod.remittance", label: "COD remittance" },
];

export const EVENT_LABEL: Record<string, string> = Object.fromEntries(
  TRIGGER_EVENTS.map((event) => [event.value, event.label]),
);
