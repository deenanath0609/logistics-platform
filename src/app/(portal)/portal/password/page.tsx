import type { Metadata } from "next";
import { KeyRound } from "lucide-react";
import { requireCustomerUser } from "@/lib/auth/customer-session";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = {
  title: "Change your password",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The only signed-in portal page reachable while `mustChangePassword` is
 * set — `requireCustomerUser` sends every other one here.
 */
export default async function PortalPasswordPage() {
  const session = await requireCustomerUser({ allowPasswordChange: true });

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-16">
      <div className="flex flex-col gap-2">
        <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <KeyRound className="size-5" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">
          {session.mustChangePassword
            ? "Choose your own password"
            : "Change your password"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {session.mustChangePassword
            ? `Your login for ${session.customerName} was set up with a temporary password. Replace it before you go any further — nobody else should know how to sign in as you.`
            : `Signed in as ${session.email}.`}
        </p>
      </div>

      <PasswordForm forced={session.mustChangePassword} />
    </main>
  );
}
