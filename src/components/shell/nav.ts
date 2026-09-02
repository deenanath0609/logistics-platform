import type { LucideIcon } from "lucide-react";
import {
  CircleHelp,
  LayoutDashboard,
  Truck,
  Contact,
  PackageCheck,
  Warehouse,
  ScanLine,
  ClipboardCheck,
  Scale,
  FileText,
  Navigation,
  Bike,
  Wallet,
  IdCard,
  Container,
  CalendarClock,
  MessageSquareWarning,
  MessageSquare,
  Send,
  TriangleAlert,
  Timer,
  Satellite,
  ClipboardList,
  Gauge,
  Landmark,
  IndianRupee,
  HandCoins,
  Building,
  Upload,
  KeyRound,
  Webhook,
  MapPin,
  Building2,
  Route as RouteIcon,
  Boxes,
  Package,
  Receipt,
  Percent,
  AlertTriangle,
  Hash,
  Users,
  UsersRound,
  ShieldCheck,
  ScrollText,
  Map,
} from "lucide-react";
import { moduleGateFor } from "@/lib/modules/refusal";
import type { ModuleKey } from "@/lib/modules/registry";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /**
   * Hidden entirely when the user lacks this permission.
   *
   * Null means the entry is shown to everybody. That has to be its own case
   * rather than "pick a permission everyone holds", because there is no such
   * permission: a DRIVER holds four codes and `master.read` is not among
   * them, a PICKUP_EXEC holds three, and the two sets share nothing with the
   * booking counter's. An entry that must survive the narrowest role is
   * therefore ungated by construction.
   */
  permission: string | null;
  /**
   * Further permissions that also open this entry.
   *
   * A screen whose own guard is `canAny([...])` cannot be described by one
   * code, and gating the link on the first of them hides it from everybody
   * who holds one of the others. That is what happened to the scan console:
   * the page admits `scan.inbound`, `scan.sort` or `scan.outbound`, the link
   * asked for `scan.inbound` alone, and a dispatch manager holding only
   * `scan.outbound` could use the console but was never shown the way in.
   *
   * `permission` stays the primary code — it is what
   * `modules.test.ts` checks route ownership against — and this is the rest
   * of the same `canAny`.
   */
  orPermissions?: string[];
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

/**
 * Navigation is permission-driven: an item the user cannot open is not
 * rendered at all, rather than rendered and then rejected. The page itself
 * still guards — the nav is a convenience, not the boundary.
 */
export const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        label: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
        permission: "master.read",
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        label: "Shipments",
        href: "/shipments",
        icon: Truck,
        permission: "shipment.read",
      },
      {
        label: "Pickups",
        href: "/pickups",
        icon: PackageCheck,
        permission: "pickup.read",
      },
      {
        label: "Bulk upload",
        href: "/shipments/bulk",
        icon: Upload,
        permission: "shipment.bulk_upload",
      },
      {
        label: "Customers",
        href: "/customers",
        icon: Contact,
        permission: "customer.read",
      },
    ],
  },
  {
    label: "Hub",
    items: [
      {
        label: "Dock",
        href: "/hub",
        icon: Warehouse,
        permission: "scan.inbound",
      },
      {
        label: "Scan console",
        href: "/hub/scan",
        icon: ScanLine,
        // The page admits any of the three scan codes (`canAny` in
        // `/hub/scan/page.tsx`), so the link has to as well. Gated on
        // `scan.inbound` alone, a dispatch manager holding only
        // `scan.outbound` could work the console and had no link to it.
        permission: "scan.inbound",
        orPermissions: ["scan.sort", "scan.outbound"],
      },
      {
        label: "Weighment",
        href: "/hub/weigh",
        icon: Scale,
        permission: "weight.capture",
      },
      {
        label: "Inbound receipts",
        href: "/hub/inbound",
        icon: ClipboardCheck,
        permission: "receipt.read",
      },
    ],
  },
  {
    label: "Dispatch",
    items: [
      {
        label: "Manifests",
        href: "/dispatch/manifests",
        icon: FileText,
        permission: "manifest.read",
      },
      {
        label: "Trips",
        href: "/dispatch/trips",
        icon: Navigation,
        permission: "trip.read",
      },
    ],
  },
  {
    label: "Delivery",
    items: [
      {
        label: "Delivery runs",
        href: "/delivery/runs",
        icon: Bike,
        permission: "delivery.read",
      },
      {
        label: "COD",
        href: "/delivery/cod",
        icon: Wallet,
        permission: "delivery.read",
      },
    ],
  },
  {
    label: "Fleet",
    items: [
      {
        label: "Vehicles",
        href: "/fleet/vehicles",
        icon: Truck,
        permission: "vehicle.read",
      },
      {
        label: "Drivers",
        href: "/fleet/drivers",
        icon: IdCard,
        permission: "driver.read",
      },
      {
        label: "Field staff",
        href: "/fleet/field-staff",
        icon: UsersRound,
        permission: "user.read",
      },
      {
        label: "Vehicle types",
        href: "/fleet/vehicle-types",
        icon: Container,
        permission: "vehicle.read",
      },
      {
        label: "Document expiries",
        href: "/fleet/expiries",
        icon: CalendarClock,
        permission: "vehicle.read",
      },
    ],
  },
  {
    label: "Network",
    items: [
      {
        label: "Branches & hubs",
        href: "/masters/branches",
        icon: Building2,
        permission: "branch.read",
      },
      {
        label: "Cities",
        href: "/masters/cities",
        icon: Map,
        permission: "master.read",
      },
      {
        label: "Pincodes",
        href: "/masters/pincodes",
        icon: MapPin,
        permission: "master.read",
      },
      {
        label: "Zones",
        href: "/masters/zones",
        icon: Boxes,
        permission: "master.read",
      },
      {
        label: "Routes",
        href: "/masters/routes",
        icon: RouteIcon,
        permission: "master.read",
      },
      {
        label: "SLA policies",
        href: "/masters/sla-policies",
        icon: Timer,
        permission: "master.read",
      },
    ],
  },
  {
    label: "Masters",
    items: [
      {
        label: "Service types",
        href: "/masters/service-types",
        icon: Package,
        permission: "master.read",
      },
      {
        label: "Package types",
        href: "/masters/package-types",
        icon: Boxes,
        permission: "master.read",
      },
      {
        label: "Charge heads",
        href: "/masters/charge-types",
        icon: Receipt,
        permission: "master.read",
      },
      {
        label: "Tax rates",
        href: "/masters/tax-rates",
        icon: Percent,
        permission: "master.read",
      },
      {
        label: "Reason codes",
        href: "/masters/reason-codes",
        icon: AlertTriangle,
        permission: "master.read",
      },
      {
        label: "Number series",
        href: "/masters/number-series",
        icon: Hash,
        permission: "master.read",
      },
    ],
  },
  {
    label: "Control tower",
    items: [
      {
        label: "Exceptions",
        href: "/exceptions",
        icon: TriangleAlert,
        permission: "exception.read",
      },
      {
        label: "Live tracking",
        href: "/tracking",
        icon: Satellite,
        permission: "tracking.read",
      },
      {
        label: "Reports",
        href: "/reports",
        icon: ClipboardList,
        permission: "report.operations",
      },
      {
        label: "Insights",
        href: "/insights",
        icon: Gauge,
        permission: "report.management",
      },
    ],
  },
  {
    label: "Finance",
    items: [
      {
        // `/finance` was linked from nowhere, and it is the only page that
        // links `/finance/profitability` and `/finance/coverage-gaps` —
        // both were therefore reachable only by typing the URL. The landing
        // page admits anyone who can read one of its cards, so the link
        // does the same.
        label: "Overview",
        href: "/finance",
        icon: Gauge,
        permission: "invoice.read",
        orPermissions: [
          "ratecard.read",
          "payment.read",
          "settlement.read",
          "vendor.read",
          "report.financial",
        ],
      },
      {
        label: "Invoices",
        href: "/finance/invoices",
        icon: Receipt,
        permission: "invoice.read",
      },
      {
        label: "Receivables",
        href: "/finance/receivables",
        icon: Landmark,
        permission: "payment.read",
      },
      {
        label: "Rate cards",
        href: "/finance/rate-cards",
        icon: IndianRupee,
        permission: "ratecard.read",
      },
      {
        label: "Settlements",
        href: "/finance/settlements",
        icon: HandCoins,
        permission: "settlement.read",
      },
      {
        label: "Vendors",
        href: "/vendors",
        icon: Building,
        permission: "vendor.read",
      },
    ],
  },
  {
    label: "Customer care",
    items: [
      {
        label: "Complaints",
        href: "/complaints",
        icon: MessageSquareWarning,
        permission: "complaint.read",
      },
      {
        label: "Notification log",
        href: "/notifications/log",
        icon: Send,
        permission: "master.read",
      },
      {
        label: "Templates",
        href: "/notifications/templates",
        icon: MessageSquare,
        permission: "master.read",
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        label: "Users",
        href: "/admin/users",
        icon: Users,
        permission: "user.read",
      },
      {
        label: "Roles & permissions",
        href: "/admin/roles",
        icon: ShieldCheck,
        permission: "user.read",
      },
      {
        label: "Audit trail",
        href: "/admin/audit",
        icon: ScrollText,
        permission: "audit.read",
      },
      {
        label: "API keys",
        href: "/integrations/api-keys",
        icon: KeyRound,
        permission: "apikey.manage",
      },
      {
        label: "Webhooks",
        href: "/integrations/webhooks",
        icon: Webhook,
        permission: "apikey.manage",
      },
    ],
  },
  {
    label: "Help",
    items: [
      {
        label: "How this works",
        href: "/help",
        icon: CircleHelp,
        // Ungated on purpose, and last so it is where a lost person looks.
        // Whoever most needs the page holds the fewest permissions.
        permission: null,
      },
    ],
  },
];

/**
 * The groups a given user should be shown.
 *
 * Two filters, because neither one covers the other.
 *
 * Narrowing the session already removes most unbought entries — the
 * permissions checked here are largely module-owned, so `Manifests` and
 * `Invoices` vanish without anything in this file changing. Two entries
 * survive that, and they are the reason the module filter exists: `COD` is
 * guarded by `delivery.read`, which the last mile owns rather than COD, and
 * `SLA policies` by `master.read`, which core owns. Both would keep drawing
 * a link into a module the carrier never bought.
 *
 * Hiding is still only presentation; `requireModuleForPath()` in the ops
 * layout is what actually refuses the URL.
 */
export function visibleNavGroups(
  permissions: ReadonlySet<string>,
  modules: ReadonlySet<ModuleKey>,
): NavGroup[] {
  return NAV.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => holds(permissions, item) && moduleGateFor(item.href, modules).allowed,
    ),
  })).filter((group) => group.items.length > 0);
}

/** The link's own `canAny`: the primary code, or any of its alternatives. */
function holds(permissions: ReadonlySet<string>, item: NavItem): boolean {
  if (item.permission === null) return true;
  if (permissions.has(item.permission)) return true;
  return (item.orPermissions ?? []).some((code) => permissions.has(code));
}
