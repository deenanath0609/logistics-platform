import { TenantMark } from "@/components/brand/tenant-mark";
import { Toaster } from "@/components/ui/sonner";
import { requireUser } from "@/lib/auth/session";
import { requireModuleForPath } from "@/lib/modules/guard";
import { getTenantModules } from "@/lib/modules/tenant-modules";
import { requireTenantPage } from "@/lib/tenant/page";
import { redirect } from "next/navigation";
import { signOut } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import { MobileNav } from "@/components/shell/mobile-nav";
import { UserMenu } from "@/components/shell/user-menu";
import { ImpersonationNotice } from "@/components/platform/impersonation-notice";

export default async function OpsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { tenant, branding } = await requireTenantPage();
  const user = await requireUser();

  // Before anything renders. A module the carrier did not buy is refused by
  // URL here, whatever permission the screen behind it happens to check.
  await requireModuleForPath();

  const permissions = [...user.permissions];
  // Already resolved by the guard above, so this is the same request-cached
  // answer rather than a second query.
  const modules = [...(await getTenantModules())];

  /**
   * The banner is 2.75rem tall and sticks to the top of the viewport, so
   * everything else that sticks has to start below it — otherwise the ops
   * header slides underneath the one bar that must never be hidden. The
   * shell's own height is reduced by the same amount so a support session
   * does not introduce a scrollbar on a page that had none.
   */
  const impersonating = tenant.source === "impersonation";

  async function handleSignOut() {
    "use server";
    // `redirect: false` and our own redirect, for the reason spelled out in
    // `(auth)/login/actions.ts`: given a path, Auth.js resolves it against a
    // base URL it derives itself, which in production came out as
    // `localhost:PORT` and sent every carrier to a host that is not theirs.
    await signOut({ redirect: false });
    redirect("/login");
  }

  return (
    <>
      <ImpersonationNotice />

      <div
        className={cn(
          "grid lg:grid-cols-[236px_minmax(0,1fr)]",
          impersonating ? "min-h-[calc(100dvh-2.75rem)]" : "min-h-dvh",
        )}
      >
        {/*
          Sticky, and exactly as tall as the space the shell actually has —
          which is one screen, less the impersonation banner when there is
          one. The same arithmetic as the shell height above, for the same
          reason: during a support session the banner owns the top 2.75rem,
          so a sidebar starting at 0 would slide under the one bar that must
          never be hidden.
        */}
        <aside
          className={cn(
            "hidden border-r bg-sidebar lg:sticky lg:flex lg:flex-col",
            impersonating ? "lg:top-11 lg:h-[calc(100dvh-2.75rem)]" : "lg:top-0 lg:h-dvh",
          )}
        >
          <div className="flex h-14 items-center border-b px-4">
            <TenantMark
              name={branding.name}
              logoUrl={branding.logoUrl}
              href="/dashboard"
            />
          </div>

          <div className="flex-1 overflow-y-auto px-2 py-5">
            <SidebarNav permissions={permissions} modules={modules} />
          </div>

          {branding.supportPhone && (
            <p className="border-t px-4 py-3 font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              Support · {branding.supportPhone}
            </p>
          )}
        </aside>

        <div className="flex min-w-0 flex-col">
          <header
            className={cn(
              "sticky z-30 flex h-14 items-center justify-between gap-4 border-b bg-background/95 px-4 backdrop-blur",
              impersonating ? "top-11" : "top-0",
            )}
          >
            <div className="flex items-center gap-2">
              <MobileNav
                permissions={permissions}
                modules={modules}
                brandName={branding.name}
              />
              <span className="font-semibold tracking-tight lg:hidden">
                {branding.name}
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
    </>
  );
}
