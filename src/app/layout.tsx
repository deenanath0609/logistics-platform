import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import { getEnv } from "@/lib/env";
import { tenantPaletteCss } from "@/lib/tenant/branding";
import { optionalBranding } from "@/lib/tenant/page";
import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

/**
 * Titles and the favicon come from whichever carrier owns this hostname.
 *
 * The root layout deliberately does not 404 an unresolvable host — it has
 * no boundary to render a 404 into. Each route group's layout calls
 * `requireTenantPage()`, which does.
 */
export async function generateMetadata(): Promise<Metadata> {
  const branding = await optionalBranding();
  const name = branding?.name ?? getEnv().APP_NAME;

  return {
    title: { default: name, template: `%s · ${name}` },
    description: "Freight operations platform — FTL, PTL and courier.",
    icons: branding?.faviconUrl ? { icon: branding.faviconUrl } : undefined,
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Field staff operate this one-handed on a phone; let them zoom.
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1719" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const branding = await optionalBranding();
  const palette = branding ? tenantPaletteCss(branding) : "";

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${archivo.variable} ${plexMono.variable} antialiased`}>
        {/*
          The tenant palette overrides the tokens globals.css declares, so it
          has to come after the stylesheet rather than inside it. Only the
          brand tokens move — status colours stay put, because a carrier
          whose brand happens to be red must not end up with red meaning
          "delivered".
        */}
        {palette && (
          <style
            data-tenant-palette=""
            dangerouslySetInnerHTML={{ __html: palette }}
          />
        )}
        {children}
      </body>
    </html>
  );
}
