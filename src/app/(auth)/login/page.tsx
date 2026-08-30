import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getEnv } from "@/lib/env";
import { isPlatformHost } from "@/lib/tenant/host";
import { TenantMark } from "@/components/brand/tenant-mark";
import { requireTenantPage } from "@/lib/tenant/page";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // `/login` is muscle memory, and on the operator host it is the wrong
  // door. Point it at the right one rather than 404ing: the console still
  // decides who may in, and this only saves an operator from a blank page.
  const host = (await headers()).get("host");
  if (isPlatformHost(host, getEnv().APP_ROOT_DOMAIN)) redirect("/platform/login");

  // The `(auth)` group has no layout of its own, so the tenant is required
  // here — an unresolvable host must 404 rather than offer a sign-in box
  // that belongs to nobody.
  const { branding } = await requireTenantPage();

  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  const { next } = await searchParams;
  const target = next?.startsWith("/") ? next : "/dashboard";

  // Whoever cannot get in needs a human at the carrier, not at us.
  const supportLine = branding.supportPhone ?? branding.supportEmail;

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel — hidden on the small screens field staff use. */}
      <section className="hidden flex-col justify-between bg-sidebar p-12 lg:flex">
        <TenantMark
          name={branding.name}
          logoUrl={branding.logoUrl}
          className="flex items-center gap-3 text-lg"
        />

        <div className="flex max-w-md flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-primary">
            Staff sign-in
          </p>
          <h1 className="text-3xl font-bold leading-tight tracking-tight text-balance">
            Every status you see was produced by someone actually moving
            freight.
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Scans at the dock, loads onto a manifest, a signature at the door —
            tracking is the record of the work, not a dropdown someone
            remembered to update.
          </p>
        </div>

        {/*
          The third row is rendered even when the carrier has given us no
          support contact: `justify-between` would otherwise drop the copy
          above it to the floor of a 900px-tall panel.
        */}
        <p className="font-mono text-xs text-muted-foreground">
          {supportLine ? `Locked out? ${supportLine}` : ""}
        </p>
      </section>

      <section className="flex items-center justify-center px-6 py-16">
        <div className="flex w-full max-w-sm flex-col gap-8">
          {/* The brand panel is hidden here, so the mark stands in for it. */}
          <TenantMark
            name={branding.name}
            logoUrl={branding.logoUrl}
            className="flex flex-col items-start gap-2 text-lg lg:hidden"
          />

          <div className="flex flex-col gap-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
            <p className="text-sm text-muted-foreground">
              Office staff use a password. Field staff use a one-time code.
            </p>
          </div>

          <LoginForm next={target} />

          {supportLine && (
            <p className="text-xs text-muted-foreground lg:hidden">
              Locked out? {supportLine}
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
