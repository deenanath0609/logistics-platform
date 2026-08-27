import Link from "next/link";
import { Truck } from "lucide-react";

/**
 * The public shell. No session is read anywhere under `/track` — this is
 * the one surface of the platform that answers to anybody, which is why
 * everything it renders comes through `toPublicTracking`.
 */
export default function TrackLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/track" className="flex items-center gap-2.5">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Truck className="size-4" />
            </span>
            <span className="font-semibold tracking-tight">City Logistics</span>
          </Link>

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
        </p>
      </footer>
    </div>
  );
}
