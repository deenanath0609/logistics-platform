import type { Metadata } from "next";
import { requirePlatformHost } from "@/lib/platform/guard";
import { CONSOLE_PALETTE_CSS } from "@/components/platform/console-theme";

export const metadata: Metadata = {
  title: { default: "Operator console", template: "%s · Operator console" },
  // Never indexed and never followed. The console is not a public surface
  // and its URLs name customers.
  robots: { index: false, follow: false },
};

/**
 * The outermost layout of the operator console.
 *
 * Two things happen here and nowhere else:
 *
 * 1. **The host boundary.** `requirePlatformHost()` 404s anything served
 *    from a carrier's subdomain. It is deliberately above the sign-in
 *    page, not beside it — a login form that renders on
 *    `acme.platform.com` is already a leak, whatever it does with the
 *    credentials.
 * 2. **The palette.** The console overrides the product's design tokens on
 *    `[data-platform-console]`, so an operator can tell at a glance that
 *    they are not inside a tenant's app. Same mechanism as white-labelling
 *    (ADR 001 §3), pointed at ourselves.
 */
export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePlatformHost();

  return (
    <div data-platform-console="" className="min-h-dvh bg-background">
      <style dangerouslySetInnerHTML={{ __html: CONSOLE_PALETTE_CSS }} />
      {children}
    </div>
  );
}
