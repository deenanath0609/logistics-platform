"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { moduleGateFor } from "@/lib/modules/refusal";
import type { ModuleKey } from "@/lib/modules/registry";
import { NAV } from "./nav";

export function SidebarNav({
  permissions,
  modules,
  onNavigate,
}: {
  permissions: string[];
  modules: ModuleKey[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const granted = new Set(permissions);
  const grantedModules = new Set(modules);

  /**
   * Two filters, because neither one covers the other.
   *
   * Narrowing the session already removes most unbought entries — the
   * permissions this nav checks are largely module-owned, so `Manifests`
   * and `Invoices` vanish without anything here changing. Two entries
   * survive that, and they are the reason this second filter exists:
   * `COD` is guarded by `delivery.read`, which the last mile owns rather
   * than COD, and `SLA policies` by `master.read`, which core owns. Both
   * would keep drawing a link into a module the carrier never bought.
   *
   * Hiding is still only presentation; `requireModuleForPath()` in the ops
   * layout is what actually refuses the URL.
   */
  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        granted.has(item.permission) &&
        moduleGateFor(item.href, grantedModules).allowed,
    ),
  })).filter((group) => group.items.length > 0);

  return (
    <nav className="flex flex-col gap-6" aria-label="Main">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <p className="px-3 pb-1 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            {group.label}
          </p>
          {group.items.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                <item.icon className="size-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
