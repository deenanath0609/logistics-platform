"use client";

import Link from "next/link";
import { LogOut, Building2, KeyRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
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
        {/*
          The group is not decoration. `DropdownMenuLabel` is Base UI's
          `Menu.GroupLabel`, which reads a context only `Menu.Group` provides
          — without it the component throws, and because it throws during
          render the whole page goes down rather than just the menu. That is
          what happened here: opening this menu replaced the application with
          "This page couldn't load", and since sign-out lives inside it,
          there was no way to sign out at all.
        */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
            <span className="text-sm font-medium">{name}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {mobile}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>

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

        {/*
          The everyday way in. `/password` is otherwise only reached by
          being forced there at first sign-in, which would make changing a
          password afterwards impossible without an administrator resetting
          it — the one thing a password change exists to avoid.
        */}
        <DropdownMenuItem render={<Link href="/password" />}>
          <KeyRound className="size-4" />
          Change password
        </DropdownMenuItem>

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
