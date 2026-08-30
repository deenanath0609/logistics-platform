import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { getCurrentOperator } from "@/lib/platform/session";
import { OperatorLoginForm } from "./login-form";

export const metadata: Metadata = { title: "Operator sign in" };
export const dynamic = "force-dynamic";

/**
 * The console's front door.
 *
 * There is no "register", no "forgot password" and no link back to any
 * tenant. A new operator is created out of band by
 * `scripts/create-platform-admin.ts`, because a self-service sign-up here
 * would be a self-service sign-up for every carrier on the platform at
 * once.
 */
export default async function OperatorLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const operator = await getCurrentOperator();
  if (operator) redirect("/platform");

  const { next } = await searchParams;
  const target = next?.startsWith("/platform") ? next : "/platform";

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="hidden flex-col justify-between bg-sidebar p-12 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <ShieldAlert className="size-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">
            Platform operator
          </span>
        </div>

        <div className="flex max-w-md flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-sidebar-primary">
            Not a carrier application
          </p>
          <h1 className="text-3xl font-bold leading-tight tracking-tight text-balance">
            This console can suspend a company.
          </h1>
          <p className="text-sm leading-relaxed text-sidebar-foreground/70">
            Operator logins are a separate population from carrier staff and
            from portal customers — a different table, a different session,
            no shared identity. Every action taken here is recorded against
            your name and the tenant it touched.
          </p>
        </div>

        <p className="font-mono text-xs text-sidebar-foreground/50">
          Carrier staff sign in on their own subdomain, never here.
        </p>
      </section>

      <section className="flex items-center justify-center px-6 py-16">
        <div className="flex w-full max-w-sm flex-col gap-8">
          <div className="flex flex-col gap-1.5">
            <p className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-primary">
              Operator console
            </p>
            <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
            <p className="text-sm text-muted-foreground">
              Use the address your operator account was created on.
            </p>
          </div>

          <OperatorLoginForm next={target} />

          <p className="text-xs text-muted-foreground">
            No operator account exists until somebody runs{" "}
            <code className="font-mono">scripts/create-platform-admin.ts</code>.
            There is no sign-up and no password reset by email.
          </p>
        </div>
      </section>
    </main>
  );
}
