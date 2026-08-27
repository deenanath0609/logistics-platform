import { cache } from "react";
import { basePrisma } from "@/lib/prisma-base";
import {
  darkVariantFor,
  foregroundFor,
  formatOklch,
  hexToOklch,
  subtleFor,
  type Oklch,
} from "@/lib/tenant/colour";

/**
 * Everything a page needs to render as the tenant rather than as us.
 *
 * Four surfaces matter, in order of how many people who are not our users
 * see them: the public tracking page, the printed documents, the
 * notifications, and last the app itself (ADR 001 §3).
 */
export type TenantBranding = {
  orgId: string;
  name: string;
  legalName: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColorHex: string | null;
  accentColorHex: string | null;
  documentFooter: string | null;
  termsText: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  website: string | null;
  currency: string;
  timezone: string;
};

/**
 * Loaded with `basePrisma` deliberately. `Organization` is a global table —
 * the tenant extension does not filter it — and this runs on paths like
 * public tracking where no tenant has been established yet.
 */
export const getBranding = cache(
  async (orgId: string): Promise<TenantBranding | null> =>
    basePrisma.organization.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        legalName: true,
        logoUrl: true,
        faviconUrl: true,
        primaryColorHex: true,
        accentColorHex: true,
        documentFooter: true,
        termsText: true,
        supportEmail: true,
        supportPhone: true,
        website: true,
        currency: true,
        timezone: true,
      },
    }).then((org) => (org ? { ...org, orgId: org.id } : null)),
);

/**
 * The CSS custom properties a tenant palette overrides.
 *
 * Only the brand tokens move. `--ok`, `--warn` and `--bad` stay exactly as
 * globals.css declares them: a status colour that changes per tenant is a
 * status colour nobody can learn, and a carrier whose brand happens to be
 * red must not end up with red meaning "fine".
 */
function paletteBlock(primary: Oklch | null, accent: Oklch | null, dark: boolean): string {
  const lines: string[] = [];

  if (primary) {
    const base = dark ? darkVariantFor(primary) : primary;
    lines.push(`--primary: ${formatOklch(base)};`);
    lines.push(`--primary-foreground: ${formatOklch(foregroundFor(base))};`);
    lines.push(`--ring: ${formatOklch(base)};`);
    lines.push(`--sidebar-primary: ${formatOklch(base)};`);
    lines.push(`--sidebar-primary-foreground: ${formatOklch(foregroundFor(base))};`);
    lines.push(`--sidebar-ring: ${formatOklch(base)};`);
    lines.push(`--chart-1: ${formatOklch(base)};`);
  }

  if (accent) {
    const base = dark ? darkVariantFor(accent) : accent;
    const wash = subtleFor(accent, dark);
    lines.push(`--accent: ${formatOklch(wash)};`);
    lines.push(`--accent-foreground: ${formatOklch(foregroundFor(wash))};`);
    lines.push(`--sidebar-accent: ${formatOklch(wash)};`);
    lines.push(`--sidebar-accent-foreground: ${formatOklch(foregroundFor(wash))};`);
    if (!primary) lines.push(`--chart-2: ${formatOklch(base)};`);
  }

  return lines.join("\n    ");
}

/**
 * A stylesheet for one tenant, or an empty string when they have not chosen
 * a palette — in which case the product's own tokens stand, which is the
 * right default and not a failure.
 */
export function tenantPaletteCss(branding: Pick<TenantBranding, "primaryColorHex" | "accentColorHex">): string {
  const primary = hexToOklch(branding.primaryColorHex);
  const accent = hexToOklch(branding.accentColorHex);
  if (!primary && !accent) return "";

  const light = paletteBlock(primary, accent, false);
  const dark = paletteBlock(primary, accent, true);

  return `:root {\n    ${light}\n  }\n  .dark {\n    ${dark}\n  }`;
}
