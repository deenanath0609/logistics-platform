/**
 * Portal navigation, as data.
 *
 * `icon` is a NAME, not a component. A Lucide icon is a function, and a
 * function cannot be serialised across the server/client boundary — so the
 * server renders this list and `portal-nav.tsx` resolves the name against
 * its own map on the client.
 */
export type PortalNavItem = {
  href: string;
  label: string;
  icon: PortalIconName;
  /** Hidden from VIEWER logins, which may look but not act. */
  writeOnly?: boolean;
  /** Hidden from everyone but the account owner. */
  ownerOnly?: boolean;
};

export type PortalIconName =
  | "gauge"
  | "package"
  | "plus"
  | "truck"
  | "mapPin"
  | "receipt"
  | "users"
  | "upload"
  | "lifeBuoy"
  | "bookOpen";

export const PORTAL_NAV: PortalNavItem[] = [
  { href: "/portal", label: "Overview", icon: "gauge" },
  { href: "/portal/shipments", label: "Shipments", icon: "package" },
  { href: "/portal/book", label: "Book a shipment", icon: "plus", writeOnly: true },
  { href: "/portal/bulk", label: "Bulk upload", icon: "upload", writeOnly: true },
  { href: "/portal/pickups", label: "Pickups", icon: "truck" },
  { href: "/portal/addresses", label: "Saved addresses", icon: "mapPin" },
  { href: "/portal/invoices", label: "Invoices", icon: "receipt" },
  { href: "/portal/complaints", label: "Complaints", icon: "lifeBuoy" },
  { href: "/portal/users", label: "People", icon: "users", ownerOnly: true },
  // Last, and neither `writeOnly` nor `ownerOnly`: a VIEWER login is the
  // one most likely to be somebody's first day in here.
  { href: "/portal/help", label: "Help", icon: "bookOpen" },
];

export function visibleNav(options: {
  isOwner: boolean;
  canWrite: boolean;
}): PortalNavItem[] {
  return PORTAL_NAV.filter((item) => {
    if (item.ownerOnly && !options.isOwner) return false;
    if (item.writeOnly && !options.canWrite) return false;
    return true;
  });
}
