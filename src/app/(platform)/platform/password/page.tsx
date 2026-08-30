import type { Metadata } from "next";
import { KeyRound } from "lucide-react";
import { MIN_PASSWORD_LENGTH } from "@/lib/platform/credentials";
import { requireOperator } from "@/lib/platform/session";
import { OperatorPasswordForm } from "./password-form";
import { signOutOperator } from "./actions";

export const metadata: Metadata = { title: "Change password" };
export const dynamic = "force-dynamic";

/**
 * Sits OUTSIDE the console shell, exactly as `/portal/password` sits
 * outside the portal shell: the shell's guard redirects an operator
 * carrying `mustChangePassword` here, so a page inside it would redirect
 * to itself for ever.
 */
export default async function OperatorPasswordPage() {
  const operator = await requireOperator({ allowPasswordChange: true });

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <div className="flex flex-col gap-2">
          <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <KeyRound className="size-5" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">
            {operator.mustChangePassword
              ? "Set your own password"
              : "Change your password"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {operator.mustChangePassword
              ? "Your account was created from a terminal, so the password you signed in with has been in a shell history. It is a handover token, not a credential — replace it before going any further."
              : "The current password is required even though you are signed in: an unattended session is the ordinary way an account is taken over."}
          </p>
        </div>

        <OperatorPasswordForm minLength={MIN_PASSWORD_LENGTH} />

        <form action={signOutOperator}>
          <button
            type="submit"
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Sign out instead
          </button>
        </form>
      </div>
    </main>
  );
}
