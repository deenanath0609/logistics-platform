/**
 * Which tables belong to a tenant.
 *
 * This list is the single definition every isolation mechanism reads: the
 * Prisma extension that injects `orgId`, the RLS migration, and the tests
 * that try to break both. Three copies of the same list is how a table
 * added in a hurry ends up protected in two places out of three.
 *
 * `models.test.ts` re-derives this from `prisma/schema/*.prisma` and fails
 * if the two disagree, so adding a model with an `orgId` column and
 * forgetting this file is a red test rather than a silent leak.
 *
 * Deliberately excluded, and each for a reason:
 *
 *   Organization       — it IS the tenant; scoping it to itself is circular.
 *   ImpersonationGrant — operator-owned. A tenant must not be able to read
 *                        or write the grants that let support in.
 *   TenantUsageSnapshot,
 *   TenantOnboardingTask — the operator's view of a tenant, not the
 *                        tenant's own data. Both carry `orgId` because
 *                        they are *about* a tenant, which is not the same
 *                        as belonging to one.
 *   PlatformAdmin,
 *   PlatformAuditLog,
 *   TenantPlan         — no `orgId` at all; platform tables.
 */

/** Prisma model name → Postgres table name. */
export const TENANT_MODELS = {
  ApiKey: "api_key",
  AuditLog: "audit_log",
  Branch: "branch",
  BulkUploadBatch: "bulk_upload_batch",
  ChargeType: "charge_type",
  City: "city",
  Complaint: "complaint",
  CreditNote: "credit_note",
  Customer: "customer",
  CustomerUser: "customer_user",
  DeliveryRun: "delivery_run",
  DeliveryTask: "delivery_task",
  Driver: "driver",
  DriverSettlement: "driver_settlement",
  EscalationRule: "escalation_rule",
  EtaSnapshot: "eta_snapshot",
  EwayBillRecord: "eway_bill_record",
  Exception: "exception",
  FileAsset: "file_asset",
  FuelSurchargeRule: "fuel_surcharge_rule",
  Geofence: "geofence",
  GpsPing: "gps_ping",
  InboundReceipt: "inbound_receipt",
  Invoice: "invoice",
  LoginActivity: "login_activity",
  Manifest: "manifest",
  NotificationLog: "notification_log",
  NotificationPreference: "notification_preference",
  NotificationTemplate: "notification_template",
  NumberSeries: "number_series",
  OtpToken: "otp_token",
  PackageType: "package_type",
  Payment: "payment",
  PickupRequest: "pickup_request",
  Pincode: "pincode",
  RateCard: "rate_card",
  ReasonCode: "reason_code",
  ReportRun: "report_run",
  Role: "role",
  Route: "route",
  SavedReport: "saved_report",
  ServiceType: "service_type",
  Shipment: "shipment",
  SlaPolicy: "sla_policy",
  State: "state",
  SystemConfig: "system_config",
  TaxRate: "tax_rate",
  TrackingAlert: "tracking_alert",
  TrackingProviderConfig: "tracking_provider_config",
  Trip: "trip",
  User: "app_user",
  Vehicle: "vehicle",
  VehicleLocation: "vehicle_location",
  VehicleType: "vehicle_type",
  Vendor: "vendor",
  VendorBill: "vendor_bill",
  VendorPayment: "vendor_payment",
  VerificationToken: "verification_token",
  WebhookSubscription: "webhook_subscription",
  Zone: "zone",
} as const;

export type TenantModel = keyof typeof TENANT_MODELS;

/**
 * Models that carry `orgId` but are the operator's, not the tenant's.
 *
 * Held here rather than as a comment so the schema test can assert the
 * split is complete: every model with an `orgId` column is either scoped
 * to a tenant or deliberately listed as the operator's. There is no third
 * category, and "I forgot" must not become one.
 */
export const SYSTEM_OWNED_MODELS = {
  /**
   * The outbox carries `orgId` so a handler knows whose tenant an event
   * belongs to — but the drain itself is not a tenant and must see every
   * tenant's rows, or one company's dead webhook endpoint stalls another
   * company's delivery SMS. Its isolation comes from each handler
   * resolving `orgId` off the row it is working, not from a query filter.
   *
   * This is the one table where "scoped to a tenant" would be the wrong
   * answer, so it is named rather than left out.
   */
  OutboxEvent: "outbox_event",
} as const;

export const OPERATOR_OWNED_MODELS = {
  ImpersonationGrant: "impersonation_grant",
  TenantUsageSnapshot: "tenant_usage_snapshot",
  TenantOnboardingTask: "tenant_onboarding_task",
} as const;

export const TENANT_MODEL_NAMES = Object.keys(TENANT_MODELS) as TenantModel[];

export const TENANT_TABLES = Object.values(TENANT_MODELS);

export function isTenantModel(name: string): name is TenantModel {
  return name in TENANT_MODELS;
}

/**
 * Tables that inherit their tenant through a parent row rather than an
 * `orgId` column of their own — a shipment event belongs to whoever owns
 * the shipment.
 *
 * Each entry names the column and the parent table it points at, which is
 * exactly what the RLS policy needs: membership is decided by a join, so
 * there is no second copy of `orgId` to drift out of agreement with the
 * first. A shipment moved between tenants (which never happens) would
 * carry its whole history rather than orphaning it.
 */
export const DERIVED_TENANT_TABLES: Array<{
  table: string;
  column: string;
  parentTable: string;
}> = [
  { table: "shipment_event", column: "shipmentId", parentTable: "shipment" },
  { table: "shipment_package", column: "shipmentId", parentTable: "shipment" },
  { table: "shipment_charge", column: "shipmentId", parentTable: "shipment" },
  { table: "freight_calculation", column: "shipmentId", parentTable: "shipment" },
  { table: "invoice_line", column: "invoiceId", parentTable: "invoice" },
  { table: "manifest_line", column: "manifestId", parentTable: "manifest" },
  { table: "rate_card_version", column: "rateCardId", parentTable: "rate_card" },
  { table: "user_role", column: "userId", parentTable: "app_user" },
];
