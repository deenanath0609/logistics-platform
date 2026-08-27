/**
 * The permission catalogue.
 *
 * This file is the single source of truth: the seed writes these rows to
 * the `permission` table, and the runtime guard checks against these codes.
 * Adding a permission means adding it here and re-running the seed.
 *
 * Codes are `resource.action`. Anything marked `sensitive` is listed
 * separately in the role editor and is always written to the audit log.
 */

export type PermissionDef = {
  code: string;
  resource: string;
  action: string;
  module: string;
  description: string;
  sensitive?: boolean;
};

function p(
  module: string,
  resource: string,
  action: string,
  description: string,
  sensitive = false,
): PermissionDef {
  return {
    code: `${resource}.${action}`,
    resource,
    action,
    module,
    description,
    sensitive,
  };
}

export const PERMISSIONS: PermissionDef[] = [
  // ── Shipment / booking ────────────────────────────────────
  p("booking", "shipment", "create", "Book a shipment"),
  p("booking", "shipment", "read", "View shipments"),
  p("booking", "shipment", "update", "Edit an unposted booking"),
  p("booking", "shipment", "cancel", "Cancel a shipment", true),
  p("booking", "shipment", "correct_status", "Post a status correction event", true),
  p("booking", "shipment", "override_rate", "Override calculated freight", true),
  p("booking", "shipment", "override_serviceability", "Book to an unserviceable PIN", true),
  p("booking", "shipment", "edit_weight_post_invoice", "Revise chargeable weight after invoicing", true),
  p("booking", "shipment", "hold", "Place or release a hold", true),
  p("booking", "shipment", "bulk_upload", "Upload shipments in bulk"),
  p("booking", "shipment", "print", "Print LR and labels"),

  // ── Pickup ────────────────────────────────────────────────
  p("pickup", "pickup", "create", "Raise a pickup request"),
  p("pickup", "pickup", "read", "View pickup tasks"),
  p("pickup", "pickup", "assign", "Assign pickup to an executive"),
  p("pickup", "pickup", "execute", "Record pickup outcome in the field"),
  p("pickup", "pickup", "cancel", "Cancel a pickup request"),

  // ── Hub operations ────────────────────────────────────────
  p("hub", "scan", "inbound", "Scan shipments inbound"),
  p("hub", "scan", "outbound", "Scan shipments outbound"),
  p("hub", "scan", "sort", "Sort and bin packages"),
  p("hub", "weight", "capture", "Capture actual and volumetric weight"),
  p("hub", "receipt", "read", "View inbound receipts"),
  p("hub", "receipt", "close", "Close an inbound receipt", true),
  p("hub", "discrepancy", "resolve", "Resolve a shortage or excess", true),
  p("hub", "damage", "record", "Record damage with photographs"),

  // ── Manifest & dispatch ───────────────────────────────────
  p("dispatch", "manifest", "create", "Create a manifest"),
  p("dispatch", "manifest", "read", "View manifests"),
  p("dispatch", "manifest", "update", "Add or remove manifest lines"),
  p("dispatch", "manifest", "close", "Close a manifest for dispatch"),
  p("dispatch", "manifest", "reopen", "Reopen a closed manifest", true),
  p("dispatch", "trip", "create", "Create a trip"),
  p("dispatch", "trip", "read", "View trips"),
  p("dispatch", "trip", "dispatch", "Record gate-out and dispatch"),
  p("dispatch", "trip", "close", "Close a completed trip", true),
  p("dispatch", "loading", "execute", "Scan-to-load against a loading sheet"),

  // ── Delivery & POD ────────────────────────────────────────
  p("delivery", "delivery", "assign", "Assign shipments to a delivery run"),
  p("delivery", "delivery", "reassign", "Reassign a delivery task", true),
  p("delivery", "delivery", "read", "View delivery tasks"),
  p("delivery", "delivery", "execute", "Deliver, or record a failed attempt"),
  p("delivery", "delivery", "rto", "Initiate return to origin", true),
  p("delivery", "pod", "read", "View proof of delivery"),
  p("delivery", "pod", "upload", "Upload or replace POD assets", true),
  p("delivery", "cod", "collect", "Collect COD in the field"),
  p("delivery", "cod", "deposit", "Deposit collected COD"),
  p("delivery", "cod", "reconcile", "Reconcile and remit COD", true),

  // ── Fleet ─────────────────────────────────────────────────
  p("fleet", "vehicle", "create", "Add a vehicle"),
  p("fleet", "vehicle", "read", "View vehicles"),
  p("fleet", "vehicle", "update", "Edit vehicle details and documents"),
  p("fleet", "vehicle", "delete", "Deactivate a vehicle", true),
  p("fleet", "driver", "create", "Add a driver"),
  p("fleet", "driver", "read", "View drivers"),
  p("fleet", "driver", "update", "Edit driver details and documents"),
  p("fleet", "driver", "delete", "Deactivate a driver", true),

  // ── Tracking ──────────────────────────────────────────────
  p("tracking", "tracking", "read", "View live vehicle tracking"),
  p("tracking", "tracking", "replay", "Replay historical trips"),
  p("tracking", "geofence", "manage", "Create and edit geofences", true),

  // ── Exceptions, SLA, complaints ───────────────────────────
  p("exception", "exception", "read", "View the exception tower"),
  p("exception", "exception", "assign", "Assign an exception owner"),
  p("exception", "exception", "resolve", "Resolve and close an exception"),
  p("exception", "complaint", "create", "Log a customer complaint"),
  p("exception", "complaint", "read", "View complaints"),
  p("exception", "complaint", "resolve", "Resolve and close a complaint"),
  p("exception", "sla", "manage", "Configure SLA policies", true),

  // ── Customers & vendors ───────────────────────────────────
  p("party", "customer", "create", "Add a customer account"),
  p("party", "customer", "read", "View customer accounts"),
  p("party", "customer", "update", "Edit a customer account"),
  p("party", "customer", "manage_credit", "Set credit limit and terms", true),
  p("party", "vendor", "create", "Add a transporter or vendor"),
  p("party", "vendor", "read", "View vendors"),
  p("party", "vendor", "update", "Edit a vendor and its rate contract"),

  // ── Finance ───────────────────────────────────────────────
  p("finance", "ratecard", "read", "View rate cards"),
  p("finance", "ratecard", "manage", "Create and version rate cards", true),
  p("finance", "invoice", "create", "Generate invoices"),
  p("finance", "invoice", "read", "View invoices"),
  p("finance", "invoice", "approve", "Approve an invoice for issue", true),
  p("finance", "invoice", "cancel", "Cancel or credit an invoice", true),
  p("finance", "payment", "record", "Record a customer payment"),
  p("finance", "payment", "read", "View payments and outstanding"),
  p("finance", "expense", "record", "Record a trip expense"),
  p("finance", "expense", "approve", "Approve trip expenses", true),
  p("finance", "settlement", "read", "View driver and vendor settlements"),
  p("finance", "settlement", "approve", "Approve a settlement for payout", true),

  // ── Reporting ─────────────────────────────────────────────
  p("report", "report", "operations", "Run operational reports"),
  p("report", "report", "financial", "Run financial reports"),
  p("report", "report", "management", "View management dashboards"),
  p("report", "report", "export", "Export report data in bulk", true),

  // ── Administration ────────────────────────────────────────
  p("admin", "master", "read", "View master data"),
  p("admin", "master", "manage", "Create and edit master data", true),
  p("admin", "branch", "read", "View branches"),
  p("admin", "branch", "manage", "Create and edit branches", true),
  p("admin", "user", "read", "View users"),
  p("admin", "user", "manage", "Create and edit users", true),
  p("admin", "role", "manage", "Create roles and grant permissions", true),
  p("admin", "audit", "read", "View the audit trail"),
  p("admin", "settings", "manage", "Change system settings", true),
  p("admin", "apikey", "manage", "Issue and revoke API keys", true),
];

export const PERMISSION_CODES = PERMISSIONS.map((x) => x.code);
export type PermissionCode = (typeof PERMISSION_CODES)[number];

// ────────────────────────────────────────────────────────────
// System roles
// ────────────────────────────────────────────────────────────

export type DataScope = "OWN" | "BRANCH" | "BRANCH_SET" | "NETWORK";

export type RoleDef = {
  code: string;
  name: string;
  description: string;
  scope: DataScope;
  /** "*" grants everything. */
  permissions: string[] | "*";
};

/** Every read permission — the shape most view-only roles want. */
const allReads = PERMISSIONS.filter(
  (x) => x.action === "read" && !x.sensitive,
).map((x) => x.code);

export const SYSTEM_ROLES: RoleDef[] = [
  {
    code: "SUPER_ADMIN",
    name: "Super Admin",
    description: "Unrestricted access across the network.",
    scope: "NETWORK",
    permissions: "*",
  },
  {
    code: "MANAGEMENT",
    name: "Management",
    description: "Read-only visibility of the whole network, plus dashboards.",
    scope: "NETWORK",
    permissions: [
      ...allReads,
      "report.operations",
      "report.financial",
      "report.management",
      "tracking.read",
    ],
  },
  {
    code: "OPS_MANAGER",
    name: "Operations Manager",
    description: "Runs network operations end to end, excluding finance.",
    scope: "NETWORK",
    permissions: [
      ...allReads,
      "shipment.create", "shipment.update", "shipment.cancel", "shipment.hold",
      "shipment.override_serviceability", "shipment.print", "shipment.bulk_upload",
      "pickup.create", "pickup.assign", "pickup.cancel",
      "scan.inbound", "scan.outbound", "scan.sort", "weight.capture",
      "receipt.close", "discrepancy.resolve", "damage.record",
      "manifest.create", "manifest.update", "manifest.close", "manifest.reopen",
      "trip.create", "trip.dispatch", "trip.close", "loading.execute",
      "delivery.assign", "delivery.reassign", "delivery.rto",
      "exception.assign", "exception.resolve", "complaint.resolve",
      "tracking.read", "tracking.replay",
      "report.operations", "report.management",
    ],
  },
  {
    code: "BRANCH_MANAGER",
    name: "Branch Manager",
    description: "Full operational control of one branch.",
    scope: "BRANCH",
    permissions: [
      ...allReads,
      "shipment.create", "shipment.update", "shipment.cancel", "shipment.hold", "shipment.print",
      "pickup.create", "pickup.assign", "pickup.cancel",
      "scan.inbound", "scan.outbound", "scan.sort", "weight.capture",
      "receipt.close", "discrepancy.resolve", "damage.record",
      "manifest.create", "manifest.update", "manifest.close",
      "trip.create", "trip.dispatch", "loading.execute",
      "delivery.assign", "delivery.reassign",
      "exception.assign", "exception.resolve", "complaint.create", "complaint.resolve",
      "cod.deposit",
      "report.operations",
    ],
  },
  {
    code: "BOOKING_EXEC",
    name: "Booking Executive",
    description: "Takes bookings at the counter.",
    scope: "BRANCH",
    permissions: [
      "shipment.create", "shipment.read", "shipment.update", "shipment.print",
      "shipment.bulk_upload",
      "pickup.create", "pickup.read",
      "customer.read", "customer.create",
      "master.read", "branch.read",
      "ratecard.read",
    ],
  },
  {
    code: "HUB_OPERATOR",
    name: "Hub Operator",
    description: "Receives, sorts, and loads at the dock.",
    scope: "BRANCH",
    permissions: [
      "shipment.read", "shipment.print",
      "scan.inbound", "scan.outbound", "scan.sort",
      "weight.capture", "receipt.read", "damage.record",
      "manifest.read", "loading.execute",
      "master.read", "branch.read",
    ],
  },
  {
    code: "DISPATCH_MANAGER",
    name: "Dispatch Manager",
    description: "Builds manifests and trips, and sends vehicles out.",
    scope: "BRANCH_SET",
    permissions: [
      "shipment.read",
      "manifest.create", "manifest.read", "manifest.update", "manifest.close",
      "trip.create", "trip.read", "trip.dispatch", "trip.close",
      "loading.execute", "scan.outbound",
      "vehicle.read", "vehicle.update", "driver.read",
      "tracking.read",
      "master.read", "branch.read",
      "report.operations",
    ],
  },
  {
    code: "TRANSPORT_DESK",
    name: "Transport Desk",
    description: "Owns the fleet, drivers, and vehicle documents.",
    scope: "NETWORK",
    permissions: [
      "vehicle.create", "vehicle.read", "vehicle.update", "vehicle.delete",
      "driver.create", "driver.read", "driver.update", "driver.delete",
      "vendor.read", "vendor.update",
      "trip.read", "tracking.read", "tracking.replay",
      "exception.read", "exception.assign", "exception.resolve",
      "expense.record",
      "master.read", "branch.read",
      "report.operations",
    ],
  },
  {
    code: "PICKUP_EXEC",
    name: "Pickup Executive",
    description: "Field collection. Sees only their own tasks.",
    scope: "OWN",
    permissions: ["shipment.read", "pickup.read", "pickup.execute"],
  },
  {
    code: "DELIVERY_AGENT",
    name: "Delivery Agent",
    description: "Last-mile delivery. Sees only their own run.",
    scope: "OWN",
    permissions: [
      "shipment.read",
      "delivery.read", "delivery.execute",
      "pod.read", "cod.collect",
    ],
  },
  {
    code: "DRIVER",
    name: "Driver",
    description: "Line-haul driving. Sees their own trips.",
    scope: "OWN",
    permissions: [
      "trip.read", "loading.execute", "vehicle.read", "expense.record",
    ],
  },
  {
    code: "ACCOUNTS",
    name: "Accounts",
    description: "Billing, receivables, settlements.",
    scope: "NETWORK",
    permissions: [
      ...allReads,
      "ratecard.manage",
      "invoice.create", "invoice.approve", "invoice.cancel",
      "payment.record",
      "customer.manage_credit",
      "expense.approve", "settlement.approve",
      "cod.reconcile",
      "report.financial", "report.export",
    ],
  },
  {
    code: "CUSTOMER_SUPPORT",
    name: "Customer Support",
    description: "Answers customers; can correct addresses, not money.",
    scope: "NETWORK",
    permissions: [
      ...allReads,
      "shipment.update",
      "complaint.create", "complaint.resolve",
      "exception.read",
      "tracking.read",
      "report.operations",
    ],
  },
];
