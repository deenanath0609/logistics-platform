import Link from "next/link";
import { TenantMark } from "@/components/brand/tenant-mark";
import { requireTenantPage } from "@/lib/tenant/page";

/**
 * The public shell. No session is read anywhere under `/track` — this is
 * the one surface of the platform that answers to anybody, which is why
 * everything it renders comes through `toPublicTracking`.
 *
 * It is also the most-seen surface of the product by people who are not our
 * users: a consignee who has never heard of the platform sees the carrier's
 * brand, resolved from the hostname they were sent (ADR 001 §3).
 */
export default async function TrackLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { branding } = await requireTenantPage();

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <TenantMark
            name={branding.name}
            logoUrl={branding.logoUrl}
            href="/track"
          />

          <Link
            href="/portal"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Customer sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        {children}
      </main>

      <footer className="border-t">
        <p className="mx-auto w-full max-w-3xl px-4 py-5 font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground sm:px-6">
          Tracking shows milestones and cities. For consignment paperwork,
          charges or a claim, sign in to the customer portal.
          {branding.supportPhone ? ` Support · ${branding.supportPhone}` : ""}
        </p>
      </footer>
    </div>
  );
}
