"use client";

import { useState } from "react";
import { Menu, Truck } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import type { ModuleKey } from "@/lib/modules/registry";
import { SidebarNav } from "./sidebar-nav";

export function MobileNav({
  permissions,
  modules,
  brandName,
}: {
  permissions: string[];
  modules: ModuleKey[];
  brandName: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button variant="ghost" size="icon" className="lg:hidden" />}
      >
        <Menu className="size-5" />
        <span className="sr-only">Open navigation</span>
      </SheetTrigger>

      <SheetContent side="left" className="w-72 overflow-y-auto p-0">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2.5 text-base">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Truck className="size-4" />
            </span>
            {brandName}
          </SheetTitle>
        </SheetHeader>

        <div className="px-2 py-4">
          <SidebarNav
            permissions={permissions}
            modules={modules}
            onNavigate={() => setOpen(false)}
            serverRendered={false}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
