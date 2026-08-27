import type { Metadata, Viewport } from "next";
import { Truck } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { Toaster } from "@/components/ui/sonner";
import { OfflineProvider } from "@/components/delivery/offline-provider";

export const metadata: Metadata = { title: "Field" };

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  // The screen is used one-handed in daylight, often through a screen
  // protector with a crack in it. Nothing shrinks below thumb size.
  viewportFit: "cover",
};

/**
 * The field shell.
 *
 * Not the operations chrome with a mobile breakpoint bolted on — a
 * different surface for a different job. There is no sidebar, no nav tree
 * and no search: an agent has one run and works down it. Everything is
 * reachable with one thumb on a 375px screen, and the sync state lives at
 * the top where it is seen without being asked for.
 *
 * PWA installability — manifest, service worker, offline shell — is handled
 * separately. This layout assumes a normal browser tab.
 */
export default async function FieldLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Truck className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight">
              {user.name}
            </p>
            <p className="truncate font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
              {user.primaryBranch?.code ?? "No branch"} · {user.mobile}
            </p>
          </div>
        </div>
        <OfflineProvider />
      </header>

      <main className="flex-1 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {children}
      </main>

      <Toaster position="top-center" />
    </div>
  );
}
