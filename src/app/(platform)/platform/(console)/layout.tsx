import Link from "next/link";
import { KeyRound, LogOut, ShieldAlert } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { ConsoleNav } from "@/components/platform/console-nav";
import { visibleConsoleNav } from "@/components/platform/nav";
import { capabilitiesFor, PLATFORM_ROLE_LABEL } from "@/lib/platform/roles";
import { requireOperator } from "@/lib/platform/session";
import { signOutOperator } from "../password/actions";

/**
 * The signed-in console shell.
 *
 * The guard lives here rather than on each page so a route cannot be added
 * unprotected, and it is the same arrangement the portal uses:
 * `requireOperator` also enforces the forced password change, which is why
 * `/platform/password` sits outside this layout.
 *
 * Pages inside still call `requireCapability` for themselves. The nav only
 * hides links; hiding is presentation, and presentation is not access
 * control.
 */
export default async function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const operator = await requireOperator();
  const items = visibleConsoleNav(capabilitiesFor(operator.role));

  return (
    <div className="grid min-h-dvh lg:grid-cols-[248px_minmax(0,1fr)]">
      {/*
        Sticky and exactly one screen tall, so the page scrolls underneath it
        rather than carrying it away. The nav in the middle takes the slack
        and scrolls on its own when an operator has enough entries to need
        it, which keeps the two controls at the bottom — change password and
        sign out — on screen at every scroll position. They are the two a
        person reaches for without looking, and hunting for them by scrolling
        back to the top is how a shared console stays signed in.
      */}
      <aside className="hidden bg-sidebar text-sidebar-foreground lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <div className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-4">
          <span className="flex size-7 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <ShieldAlert className="size-4" />
          </span>
          <Link href="/platform" className="font-semibold tracking-tight">
            Operator console
          </Link>
        </div>

        <div className="flex flex-col gap-1 border-b border-sidebar-border px-4 py-4">
          <p className="truncate text-sm font-medium">{operator.name}</p>
          <p className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-sidebar-foreground/60">
            {PLATFORM_ROLE_LABEL[operator.role]}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-4">
          <ConsoleNav items={items} />
        </div>

        <div className="flex flex-col gap-0.5 border-t border-sidebar-border p-2">
          <Link
            href="/platform/password"
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
          >
            <KeyRound className="size-4 shrink-0" aria-hidden />
            Change password
          </Link>
          <form action={signOutOperator}>
            <button
              type="submit"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
            >
              <LogOut className="size-4 shrink-0" aria-hidden />
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        {/*
          A standing reminder rather than a toast. Somebody spends a whole
          afternoon in here; a notice that disappears after four seconds
          stops being seen by mid-morning.
        */}
        <div className="flex items-center gap-2 border-b bg-sidebar px-4 py-1.5 text-sidebar-foreground">
          <ShieldAlert className="size-3.5 shrink-0 text-sidebar-primary" aria-hidden />
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.14em]">
            Platform operator — every action is recorded against your name
          </p>
        </div>

        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b bg-background/95 px-4 backdrop-blur lg:hidden">
          <Link href="/platform" className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <ShieldAlert className="size-4" />
            </span>
            <span className="font-semibold tracking-tight">Operator</span>
          </Link>
          <form action={signOutOperator}>
            <button
              type="submit"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Sign out
            </button>
          </form>
        </header>

        <div className="overflow-x-auto border-b bg-sidebar px-2 py-2 lg:hidden">
          <ConsoleNav items={items} orientation="horizontal" />
        </div>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>

      <Toaster position="top-right" />
    </div>
  );
}
