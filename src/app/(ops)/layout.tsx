import Link from "next/link";
import { Truck } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { requireUser } from "@/lib/auth/session";
import { signOut } from "@/lib/auth";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import { MobileNav } from "@/components/shell/mobile-nav";
import { UserMenu } from "@/components/shell/user-menu";

export default async function OpsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const permissions = [...user.permissions];

  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[236px_minmax(0,1fr)]">
      <aside className="hidden border-r bg-sidebar lg:flex lg:flex-col">
        <div className="flex h-14 items-center gap-2.5 border-b px-4">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Truck className="size-4" />
          </span>
          <Link href="/dashboard" className="font-semibold tracking-tight">
            City Logistics
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-5">
          <SidebarNav permissions={permissions} />
        </div>

        <p className="border-t px-4 py-3 font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
          Phase 1 · Foundation
        </p>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b bg-background/95 px-4 backdrop-blur">
          <div className="flex items-center gap-2">
            <MobileNav permissions={permissions} />
            <span className="font-semibold tracking-tight lg:hidden">
              City Logistics
            </span>
          </div>

          <div className="flex items-center gap-3">
            {user.primaryBranch && (
              <span className="hidden rounded-md border bg-muted px-2 py-1 font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground sm:inline">
                {user.primaryBranch.code}
              </span>
            )}
            <UserMenu
              name={user.name}
              mobile={user.mobile}
              roles={user.roles.map((r) => r.name)}
              branch={user.primaryBranch?.name ?? null}
              signOutAction={handleSignOut}
            />
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>

      <Toaster position="top-right" />
    </div>
  );
}
