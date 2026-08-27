import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Truck } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  const { next } = await searchParams;
  const target = next?.startsWith("/") ? next : "/dashboard";

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel — hidden on the small screens field staff use. */}
      <section className="hidden flex-col justify-between bg-sidebar p-12 lg:flex">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Truck className="size-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">
            City Logistics
          </span>
        </div>

        <div className="flex max-w-md flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-primary">
            Freight operations platform
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

        <p className="font-mono text-xs text-muted-foreground">
          FTL · PTL · Courier
        </p>
      </section>

      <section className="flex items-center justify-center px-6 py-16">
        <div className="flex w-full max-w-sm flex-col gap-8">
          <div className="flex flex-col gap-2 lg:hidden">
            <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Truck className="size-5" />
            </span>
            <span className="text-lg font-semibold tracking-tight">
              City Logistics
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
            <p className="text-sm text-muted-foreground">
              Office staff use a password. Field staff use a one-time code.
            </p>
          </div>

          <LoginForm next={target} />
        </div>
      </section>
    </main>
  );
}
