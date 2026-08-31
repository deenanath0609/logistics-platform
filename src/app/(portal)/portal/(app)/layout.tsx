import Link from "next/link";
import { KeyRound, LogOut } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { redirect } from "next/navigation";
import { signOut } from "@/lib/auth";
import {
  canWrite,
  isAccountOwner,
  requireCustomerUser,
} from "@/lib/auth/customer-session";
import { TenantMark } from "@/components/brand/tenant-mark";
import { requireTenantPage } from "@/lib/tenant/page";
import { PortalNav } from "@/components/portal/portal-nav";
import { visibleNav } from "@/components/portal/nav";

/**
 * The signed-in portal shell.
 *
 * The guard is here rather than on each page so a new route cannot be
 * added unprotected. `requireCustomerUser` also enforces the forced
 * password change, which is why `/portal/password` sits OUTSIDE this
 * layout — otherwise it would redirect to itself for ever.
 */
export default async function PortalAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { branding } = await requireTenantPage();
  const session = await requireCustomerUser();

  const items = visibleNav({
    isOwner: isAccountOwner(session),
    canWrite: canWrite(session),
  });

  async function handleSignOut() {
    "use server";
    // See `(auth)/login/actions.ts` — Auth.js resolves a `redirectTo` against
    // a base URL of its own devising, which is not this carrier's host.
    await signOut({ redirect: false });
    redirect("/portal/login");
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[236px_minmax(0,1fr)]">
      {/* Sticky, one screen tall — see the same note in the ops shell. */}
      <aside className="hidden border-r bg-sidebar lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <div className="flex h-14 items-center border-b px-4">
          <TenantMark
            name={branding.name}
            logoUrl={branding.logoUrl}
            href="/portal"
          />
        </div>

        <div className="flex flex-col gap-1 border-b px-4 py-4">
          <p className="truncate text-sm font-medium">{session.customerName}</p>
          <p className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
            {session.customerCode} · {session.role.toLowerCase()}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-4">
          <PortalNav items={items} />
        </div>

        <div className="flex flex-col gap-0.5 border-t p-2">
          <Link
            href="/portal/password"
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
          >
            <KeyRound className="size-4 shrink-0" aria-hidden />
            Change password
          </Link>
          <form action={handleSignOut}>
            <button
              type="submit"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
            >
              <LogOut className="size-4 shrink-0" aria-hidden />
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b bg-background/95 px-4 backdrop-blur lg:hidden">
          {/*
            The carrier's mark beside the customer's own name: on a phone
            this header is the only place the account they are signed in as
            appears, so the name here stays theirs and not the carrier's.
          */}
          <Link href="/portal" className="flex items-center gap-2.5">
            <TenantMark
              name={branding.name}
              logoUrl={branding.logoUrl}
              showName={false}
              className="flex items-center"
            />
            <span className="font-semibold tracking-tight">
              {session.customerName}
            </span>
          </Link>
          <form action={handleSignOut}>
            <button
              type="submit"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Sign out
            </button>
          </form>
        </header>

        {/* The same links, laid out for a phone. */}
        <div className="overflow-x-auto border-b px-2 py-2 lg:hidden">
          <PortalNav items={items} orientation="horizontal" />
        </div>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>

      <Toaster position="top-right" />
    </div>
  );
}
