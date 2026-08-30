import type { PlatformCapability } from "@/lib/platform/roles";

/**
 * Console navigation, as data.
 *
 * `icon` is a NAME, not a component, for the same reason the portal's nav
 * is: a Lucide icon is a function, a function cannot cross the
 * server/client boundary, and the server renders this list. `console-nav.tsx`
 * resolves the name against its own map on the client.
 */
export type ConsoleIconName =
  | "gauge"
  | "building"
  | "creditCard"
  | "scrollText"
  | "userCog";

export type ConsoleNavItem = {
  href: string;
  label: string;
  icon: ConsoleIconName;
  /** Hidden when the operator's role does not hold this. */
  needs: PlatformCapability;
};

export const CONSOLE_NAV: ConsoleNavItem[] = [
  { href: "/platform", label: "Overview", icon: "gauge", needs: "tenant.read" },
  { href: "/platform/tenants", label: "Tenants", icon: "building", needs: "tenant.read" },
  { href: "/platform/plans", label: "Plans", icon: "creditCard", needs: "plan.read" },
  {
    href: "/platform/impersonation",
    label: "Support sessions",
    icon: "userCog",
    needs: "impersonate",
  },
  { href: "/platform/audit", label: "Operator log", icon: "scrollText", needs: "audit.read" },
];

/**
 * Hiding a link is presentation, never protection. Every page behind these
 * links calls `requireCapability` for itself, and every action calls
 * `authorizeOperator`; this only stops a BILLING login being shown a door
 * that would refuse them.
 */
export function visibleConsoleNav(
  capabilities: ReadonlySet<PlatformCapability>,
): ConsoleNavItem[] {
  return CONSOLE_NAV.filter((item) => capabilities.has(item.needs));
}
