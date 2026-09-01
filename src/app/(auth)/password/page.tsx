import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { requireTenantPage } from "@/lib/tenant/page";
import { TenantMark } from "@/components/brand/tenant-mark";
import { StaffPasswordForm } from "./password-form";

export const metadata: Metadata = {
  title: "Change your password",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The only signed-in page a staff member carrying `mustChangePassword` can
 * reach — `requireUser` sends every other one here.
 *
 * It sits in the `(auth)` group, which has no layout of its own, exactly as
 * `/portal/password` and `/platform/password` sit outside their shells. A
 * page inside the ops shell would be redirected to itself by the very guard
 * that sent the person here.
 */
export default async function StaffPasswordPage() {
  // The `(auth)` group has no layout, so the tenant is resolved here — an
  // unresolvable host must 404 rather than offer a password box belonging
  // to nobody.
  const { branding } = await requireTenantPage();
  const user = await requireUser({ allowPasswordChange: true });

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-16">
      <TenantMark
        name={branding.name}
        logoUrl={branding.logoUrl}
        className="flex items-center gap-3"
      />

      <div className="flex flex-col gap-2">
        <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <KeyRound className="size-5" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">
          {user.mustChangePassword
            ? "Choose your own password"
            : "Change your password"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {user.mustChangePassword
            ? "Your account was set up with a password somebody else chose and handed to you. Replace it before you go any further — until you do, whoever wrote it down can sign in as you."
            : `Signed in as ${user.name} · ${user.mobile}. The current password is asked for even though you are signed in: an unattended session is the ordinary way an account is taken over.`}
        </p>
      </div>

      <StaffPasswordForm forced={user.mustChangePassword} />

      {!user.mustChangePassword && (
        <Link
          href="/dashboard"
          className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Back to the dashboard
        </Link>
      )}
    </main>
  );
}
