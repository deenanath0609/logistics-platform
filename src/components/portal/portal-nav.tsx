"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen,
  Gauge,
  LifeBuoy,
  MapPin,
  Package,
  Plus,
  Receipt,
  Truck,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PortalIconName, PortalNavItem } from "./nav";
import { cn } from "@/lib/utils";

/**
 * Icon names resolve to components here, on the client. The server sends
 * strings; nothing that cannot cross a serialisation boundary is ever
 * passed as a prop.
 */
const ICONS: Record<PortalIconName, LucideIcon> = {
  gauge: Gauge,
  package: Package,
  plus: Plus,
  truck: Truck,
  mapPin: MapPin,
  receipt: Receipt,
  users: Users,
  upload: Upload,
  lifeBuoy: LifeBuoy,
  bookOpen: BookOpen,
};

export function PortalNav({
  items,
  orientation = "vertical",
}: {
  items: PortalNavItem[];
  /** Horizontal is the phone strip under the header. */
  orientation?: "vertical" | "horizontal";
}) {
  const pathname = usePathname();

  return (
    <nav
      className={cn(
        "flex gap-0.5",
        orientation === "vertical" ? "flex-col" : "min-w-max flex-row",
      )}
    >
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        // `/portal` must not light up for every child route.
        const active =
          item.href === "/portal"
            ? pathname === "/portal"
            : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm whitespace-nowrap transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
