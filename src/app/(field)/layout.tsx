import type { Metadata, Viewport } from "next";
import { requireUser } from "@/lib/auth/session";
import { requireModuleForPath } from "@/lib/modules/guard";
import { Toaster } from "@/components/ui/sonner";
import { TenantMark } from "@/components/brand/tenant-mark";
import { requireTenantPage } from "@/lib/tenant/page";
import { OfflineProvider } from "@/components/delivery/offline-provider";
import { ImpersonationNotice } from "@/components/platform/impersonation-notice";
import { cn } from "@/lib/utils";

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
  const { branding, tenant } = await requireTenantPage();
  const user = await requireUser();

  // The rider's screens live at `/delivery`, which the last mile owns, so
  // the same URL refusal the ops shell applies has to apply here — this
  // layout is a second front door onto a gated module, not a mobile skin
  // over the first one.
  await requireModuleForPath();

  const impersonating = tenant.source === "impersonation";

  return (
    <div
      className={cn(
        "flex flex-col bg-background",
        impersonating ? "min-h-[calc(100dvh-2.75rem)]" : "min-h-dvh",
      )}
    >
      {/*
        The field app is the surface an operator is most likely to enter and
        least likely to be recognised on — one thumb, one screen, no chrome.
        The bar has to be here too, or an impersonated session looks exactly
        like an agent's own.
      */}
      <ImpersonationNotice />

      <header
        className={cn(
          "sticky z-30 border-b bg-background/95 backdrop-blur",
          impersonating ? "top-11" : "top-0",
        )}
      >
        <div className="flex h-14 items-center gap-2.5 px-4">
          {/*
            Mark only, no carrier name: the two lines beside it tell the agent
            which run they are on, which is what they open this for. The
            hostname and the tab title already say whose app this is.
          */}
          <TenantMark
            name={branding.name}
            logoUrl={branding.logoUrl}
            showName={false}
            className="flex shrink-0 items-center"
          />
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
