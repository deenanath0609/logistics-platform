"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useSyncExternalStore } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModuleKey } from "@/lib/modules/registry";
import { visibleNavGroups } from "./nav";
import {
  collapseInitScript,
  collapseStyles,
  collapsedServerSnapshot,
  collapsedSnapshot,
  sectionId,
  setCollapsedSections,
  subscribeCollapsed,
  syncCollapsedAttribute,
} from "./nav-collapse";

export function SidebarNav({
  permissions,
  modules,
  onNavigate,
  serverRendered = true,
}: {
  permissions: string[];
  modules: ModuleKey[];
  onNavigate?: () => void;
  /**
   * False for the copy inside the sheet, which only ever mounts on the
   * client. Restoring the folded sections before first paint is a job only a
   * server-rendered copy can do — React never executes a `<script>` it
   * creates itself, and says so, loudly, in the dev overlay. The sheet does
   * not need it either way: the desktop aside is in the document on every
   * viewport, merely hidden, so its setup has already run.
   */
  serverRendered?: boolean;
}) {
  const pathname = usePathname();
  // The sheet renders a second copy of this nav; without a per-instance
  // prefix both would claim the same panel ids while it is open.
  const uid = useId();
  const granted = new Set(permissions);
  const grantedModules = new Set(modules);

  /**
   * Which groups survive is decided in `nav.ts`, next to the data, so the
   * drift test can assert what a role is shown without rendering a tree.
   * The id is a rendering concern and stays here.
   */
  const groups = visibleNavGroups(granted, grantedModules).map((group) => ({
    ...group,
    id: sectionId(group.label),
  }));

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  const activeId =
    groups.find((group) => group.items.some((item) => isActive(item.href)))
      ?.id ?? null;

  /**
   * Hydration renders from the server snapshot — everything open — and React
   * swaps in the browser's remembered set immediately afterwards, so the two
   * first renders agree. Nothing on screen moves in between: the inline
   * script below has already put the remembered set on `<html>`, and the
   * stylesheet, not this value, is what hides a panel.
   */
  const collapsed = useSyncExternalStore(
    subscribeCollapsed,
    collapsedSnapshot,
    collapsedServerSnapshot,
  );

  /**
   * Only on `activeId`, and reading the store itself rather than `collapsed`
   * — on mount `collapsed` is still the server's empty snapshot, and writing
   * that would undo the init script. A client-side navigation is the case
   * this exists for: it can move the current page into a folded section.
   */
  useEffect(() => {
    syncCollapsedAttribute(activeId);
  }, [activeId]);

  // Off the store rather than off `collapsed`, which is a rendered value and
  // so is one render behind a click that lands before React has caught up.
  function toggle(id: string) {
    const next = new Set(collapsedSnapshot());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsedSections(next);
    syncCollapsedAttribute(activeId);
  }

  return (
    <nav className="flex flex-col gap-4" aria-label="Main">
      {serverRendered && (
        <>
          <style
            data-nav-collapse=""
            dangerouslySetInnerHTML={{
              __html: collapseStyles(groups.map((group) => group.id)),
            }}
          />
          <script
            dangerouslySetInnerHTML={{ __html: collapseInitScript(activeId) }}
          />
        </>
      )}

      {groups.map((group) => {
        const current = group.id === activeId;
        const open = current || !collapsed.includes(group.id);
        const panelId = `${uid}-${group.id}-panel`;
        const headingId = `${uid}-${group.id}-heading`;

        return (
          <div
            key={group.label}
            data-nav-section={group.id}
            className="flex flex-col gap-1"
          >
            <button
              type="button"
              id={headingId}
              // The section you are standing in stays open. Leaving the
              // control in place but inert keeps the row looking like every
              // other heading instead of losing its chevron for one page.
              disabled={current}
              title={current ? "The section you are in stays open" : undefined}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => toggle(group.id)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md px-3 py-1 text-left font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                current
                  ? "cursor-default"
                  : "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )}
            >
              <span className="truncate">{group.label}</span>
              {/*
                Rotation is left to the stylesheet above rather than set from
                `open`, so that the chevron and the panel it describes are
                driven by one thing. Two sources would also compose, not
                override — Tailwind's rotate utility and a `transform` rule
                are separate properties and would land at 180 degrees.
              */}
              <ChevronDown
                data-nav-chevron=""
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 transition-transform duration-150",
                  current && "opacity-40",
                )}
              />
            </button>

            <div
              id={panelId}
              data-nav-panel={group.id}
              role="group"
              aria-labelledby={headingId}
              className="flex flex-col gap-1"
            >
              {group.items.map((item) => {
                const active = isActive(item.href);
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
          </div>
        );
      })}
    </nav>
  );
}
