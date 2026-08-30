import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentCustomerUser } from "@/lib/auth/customer-session";
import { TenantMark } from "@/components/brand/tenant-mark";
import { requireTenantPage } from "@/lib/tenant/page";
import { PortalLoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Customer sign in",
  robots: { index: false, follow: false },
};

export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Sits outside the `(app)` layout — the forced password change lives here
  // too — so this page resolves the tenant itself.
  const { branding } = await requireTenantPage();

  const customer = await getCurrentCustomerUser();
  if (customer) redirect("/portal");

  const { next } = await searchParams;
  const target = next?.startsWith("/portal") ? next : "/portal";

  // A customer who cannot sign in phones the carrier, never the vendor.
  const supportLine = branding.supportPhone ?? branding.supportEmail;

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="hidden flex-col justify-between bg-sidebar p-12 lg:flex">
        <TenantMark
          name={branding.name}
          logoUrl={branding.logoUrl}
          className="flex items-center gap-3 text-lg"
        />

        <div className="flex max-w-md flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-primary">
            Customer portal
          </p>
          <h1 className="text-3xl font-bold leading-tight tracking-tight text-balance">
            Your consignments, your addresses, your people.
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Book, request a collection, follow every shipment to the door and
            pull the proof of delivery — without telephoning a branch.
          </p>
        </div>

        <p className="font-mono text-xs text-muted-foreground">
          Just tracking a number?{" "}
          <Link href="/track" className="underline underline-offset-4">
            No sign-in needed
          </Link>
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
            <h2 className="text-2xl font-semibold tracking-tight">
              Customer sign in
            </h2>
            <p className="text-sm text-muted-foreground">
              Use the email address your account was set up on.
            </p>
          </div>

          <PortalLoginForm next={target} />

          <p className="text-xs text-muted-foreground">
            Staff sign in at{" "}
            <Link href="/login" className="underline underline-offset-4">
              /login
            </Link>
            . Tracking a consignment needs no account —{" "}
            <Link href="/track" className="underline underline-offset-4">
              track it here
            </Link>
            .{supportLine ? ` Trouble signing in? ${supportLine}.` : ""}
          </p>
        </div>
      </section>
    </main>
  );
}
