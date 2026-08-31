import type { ModuleDefinition, ModuleKey } from "@/lib/modules/registry";

/**
 * The twelve modules, as data.
 *
 * The shape lives in `registry.ts`; this file is the content, and it is the
 * thing a salesperson and a plan editor both read. Descriptions are written
 * for someone deciding what to buy, not for someone maintaining the code —
 * "collect cash at the door", not "gates the COD reconciliation surface".
 *
 * Two rules kept this table honest, and both are enforced by
 * `modules.test.ts`:
 *
 * 1. **A permission belongs to a module only when it is meaningless without
 *    it.** `invoice.approve` cannot mean anything to a carrier who does not
 *    bill, so billing owns it. `shipment.read` belongs to nobody, because
 *    booking is core and core is on for everyone — a permission listed on an
 *    `alwaysOn` module would never be withheld anyway, so listing one there
 *    would be decoration that later reads as a claim.
 * 2. **Every screen falls under exactly one module's prefix.** A route no
 *    module claims is a route nothing gates.
 */
export const MODULES: Record<ModuleKey, ModuleDefinition> = {
  core: {
    key: "core",
    label: "Core operations",
    description:
      "Book consignments, keep your customer, network and fleet masters, and run your own branches and staff.",
    alwaysOn: true,
    // Fleet and vendors sit here rather than under dispatch or the last
    // mile. A vehicle register is not a capability anyone would sell
    // separately, and splitting `/fleet` across two modules would mean a
    // carrier could lose their driver list by declining a delivery plan.
    //
    // `/reports` is core too: the operational report runner is how a branch
    // manager checks their own day's work. Management dashboards and bulk
    // export are the upsell, and those live in `insights`.
    //
    // `/help` is claimed here for the same reason everything else is: a route
    // no module claims is a route nothing gates, and the drift test refuses
    // one. Core being `alwaysOn` is what makes the claim harmless — the help
    // screen is reachable on the barest plan there is, which is precisely
    // when somebody needs it.
    routes: [
      "/dashboard",
      "/help",
      "/shipments",
      "/pickups",
      "/customers",
      "/vendors",
      "/masters",
      "/fleet",
      "/admin",
      "/notifications",
      "/reports",
    ],
    // Deliberately empty — see rule 1 above. Booking, pickup, party, fleet
    // and administration permissions are held by every carrier on every plan.
    permissions: [],
  },

  hub: {
    key: "hub",
    label: "Hub & warehouse",
    description:
      "Receive, weigh, sort and bin freight at the dock, with inbound receipts and shortage, excess and damage handling.",
    routes: ["/hub"],
    // `scan.outbound` is the dock gate, not the loading sheet — scan-to-load
    // against a trip is `loading.execute`, which dispatch owns. A carrier on
    // dispatch without a hub still loads vehicles; they just do not run a
    // receiving bay.
    permissions: [
      "scan.inbound",
      "scan.outbound",
      "scan.sort",
      "weight.capture",
      "receipt.read",
      "receipt.close",
      "discrepancy.resolve",
      "damage.record",
    ],
  },

  dispatch: {
    key: "dispatch",
    label: "Line haul & dispatch",
    description:
      "Build manifests, load vehicles against a loading sheet, and send trips out on route.",
    routes: ["/dispatch"],
    permissions: [
      "manifest.create",
      "manifest.read",
      "manifest.update",
      "manifest.close",
      "manifest.reopen",
      "trip.create",
      "trip.read",
      "trip.dispatch",
      "trip.close",
      "loading.execute",
    ],
  },

  lastmile: {
    key: "lastmile",
    label: "Last mile delivery",
    description:
      "Plan delivery runs, hand tasks to riders on their phone, and capture proof of delivery.",
    // Owns `/delivery` outright, which covers both the ops planning screens
    // and the field app riders open on their phones. COD carves
    // `/delivery/cod` back out with a longer prefix.
    routes: ["/delivery"],
    permissions: [
      "delivery.assign",
      "delivery.reassign",
      "delivery.read",
      "delivery.execute",
      "delivery.rto",
      "pod.read",
      "pod.upload",
    ],
  },

  cod: {
    key: "cod",
    label: "Cash on delivery",
    description:
      "Collect cash at the door, track what each rider is holding, and reconcile deposits and remittances to the customer.",
    routes: ["/delivery/cod"],
    permissions: ["cod.collect", "cod.deposit", "cod.reconcile"],
    // The dependency runs this way and not the other. A carrier who delivers
    // only prepaid freight is an ordinary carrier; a carrier who collects
    // cash without a delivery to collect it on is nothing at all.
    requires: ["lastmile"],
  },

  billing: {
    key: "billing",
    label: "Billing & receivables",
    description:
      "Rate cards, invoicing, receivables and ageing, and driver and vendor settlements.",
    routes: ["/finance"],
    // Trip expenses live here rather than with dispatch: they are approved
    // by accounts and they settle against a driver or a vendor, which is a
    // finance workflow that happens to be triggered on a trip.
    permissions: [
      "ratecard.read",
      "ratecard.manage",
      "invoice.create",
      "invoice.read",
      "invoice.approve",
      "invoice.cancel",
      "payment.record",
      "payment.read",
      "expense.record",
      "expense.approve",
      "settlement.read",
      "settlement.approve",
      "report.financial",
    ],
    requires: ["lastmile"],
  },

  tracking: {
    key: "tracking",
    label: "GPS tracking",
    description:
      "A live map of your vehicles, running ETAs, geofence alerts on arrival and departure, and trip replay.",
    routes: ["/tracking"],
    permissions: ["tracking.read", "tracking.replay", "geofence.manage"],
    // Everything on the map is a trip: `loadLiveFleet` reads trips and
    // stitches vehicle positions onto them. Without dispatch there are no
    // trips, and the map is an empty screen with a legend.
    requires: ["dispatch"],
  },

  sla: {
    key: "sla",
    label: "Service levels & exceptions",
    description:
      "Promise a delivery date, watch every consignment against it, and work the exceptions and customer complaints when it slips.",
    // The escalation matrix and the policies themselves are edited inside
    // masters, so this module reaches into `/masters` with a longer prefix
    // than core's. The exception tower and the complaint desk are the same
    // capability seen from the other end: what you do once a promise breaks.
    routes: ["/exceptions", "/complaints", "/masters/sla-policies"],
    permissions: [
      "sla.manage",
      "exception.read",
      "exception.assign",
      "exception.resolve",
      "complaint.create",
      "complaint.read",
      "complaint.resolve",
    ],
  },

  portal: {
    key: "portal",
    label: "Customer portal",
    description:
      "A branded self-service login where your customers book, track, download their invoices and raise complaints.",
    routes: ["/portal"],
    // Portal logins are `CustomerUser` rows on their own session, not staff
    // holding RBAC permissions, so there is no permission to withhold here.
    // Switching the module off closes the door; there is no second lock
    // behind it.
    permissions: [],
  },

  ecommerce: {
    key: "ecommerce",
    label: "E-commerce delivery",
    description:
      "Serve online sellers: bulk seller manifests, COD on most consignments, and RTO and reverse pickup as everyday outcomes rather than exceptions.",
    // No routes of its own, and that is the honest answer rather than an
    // omission. `ECOMMERCE` is a `ShipmentMode`, and the mode is a lens over
    // screens that already exist — bulk upload at `/shipments/bulk`, RTO on
    // a delivery run, reconciliation at `/delivery/cod`. It is gated where
    // modes are offered (booking, rate cards, report filters), not by URL.
    // Give it a prefix here and it would claim a screen it does not own.
    routes: [],
    // Nothing in the catalogue is exclusive to it either: `delivery.rto` and
    // `shipment.bulk_upload` are both used by ordinary courier and PTL work.
    permissions: [],
    requires: ["lastmile", "cod"],
  },

  integrations: {
    key: "integrations",
    label: "API & webhooks",
    description:
      "Issue API keys and push webhook events, so your customers' systems can book and track without anyone typing.",
    routes: ["/integrations"],
    permissions: ["apikey.manage"],
  },

  insights: {
    key: "insights",
    label: "Insights & analytics",
    description:
      "Management dashboards, trend and profitability analysis, and bulk export of report data.",
    routes: ["/insights"],
    // `report.export` is here rather than in core, which means a carrier
    // without insights can run an operational report on screen but cannot
    // pull the whole dataset out of it. That is the intended line: reading
    // your own day is operations, taking the data away is analytics.
    permissions: ["report.management", "report.export"],
  },
};
