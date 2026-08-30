"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  CreditCard,
  Gauge,
  ScrollText,
  UserCog,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConsoleIconName, ConsoleNavItem } from "./nav";

/**
 * Icon names resolve to components here, on the client. The server sends
 * strings; nothing that cannot be serialised is ever passed as a prop.
 */
const ICONS: Record<ConsoleIconName, LucideIcon> = {
  gauge: Gauge,
  building: Building2,
  creditCard: CreditCard,
  scrollText: ScrollText,
  userCog: UserCog,
};

export function ConsoleNav({
  items,
  orientation = "vertical",
}: {
  items: ConsoleNavItem[];
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
        // `/platform` is the overview and must not light up for every
        // child route beneath it.
        const active =
          item.href === "/platform"
            ? pathname === "/platform"
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
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
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
