"use client";

import { LogOut, Building2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function UserMenu({
  name,
  mobile,
  roles,
  branch,
  signOutAction,
}: {
  name: string;
  mobile: string;
  roles: string[];
  branch: string | null;
  signOutAction: () => Promise<void>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" className="h-9 gap-2 px-2" />}
      >
        <span className="flex size-6 items-center justify-center rounded-full bg-primary text-[0.65rem] font-semibold text-primary-foreground">
          {initials(name)}
        </span>
        <span className="hidden text-sm font-medium sm:inline">{name}</span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
          <span className="text-sm font-medium">{name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {mobile}
          </span>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <div className="flex flex-col gap-1.5 px-2 py-1.5">
          <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
            Roles
          </p>
          <p className="text-xs leading-relaxed">{roles.join(", ") || "None"}</p>
        </div>

        {branch && (
          <div className="flex items-center gap-2 px-2 pb-2 text-xs text-muted-foreground">
            <Building2 className="size-3.5 shrink-0" />
            <span className="truncate">{branch}</span>
          </div>
        )}

        <DropdownMenuSeparator />

        <form action={signOutAction}>
          <DropdownMenuItem
            render={
              <button type="submit" className="w-full cursor-pointer" />
            }
          >
            <LogOut className="size-4" />
            Sign out
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
