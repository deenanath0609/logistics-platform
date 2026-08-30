import { format } from "date-fns";
import { prisma } from "@/lib/prisma";
import { IMPERSONATION_EXIT_PATH } from "@/lib/platform/impersonation-credential";
import { currentImpersonation } from "@/lib/platform/impersonation-session";
import { getBranding } from "@/lib/tenant/branding";
import { resolveTenant } from "@/lib/tenant/resolve";
import { ImpersonationBanner } from "@/components/platform/impersonation-banner";

/**
 * Decides whether the banner belongs on this page, and with what on it.
 *
 * Split from the banner itself because the two halves have different jobs:
 * this one reads the tenant context and the grant row on the server, the
 * other one is a client component that ticks a clock. Only serialisable
 * values cross between them — strings and booleans, and an icon *name*
 * rather than a Lucide component, which could not cross at all.
 *
 * The check is on `TenantContext.source`, not on the cookie. That is the
 * same value the Prisma extension uses to refuse writes, so the banner and
 * the enforcement cannot disagree: if the app is read-only because of a
 * support grant, the bar saying so is on the page, and if the grant has
 * ended between two requests neither of them is.
 */
export async function ImpersonationNotice() {
  const tenant = await resolveTenant();
  if (tenant?.source !== "impersonation" || !tenant.impersonation) return null;

  // Re-read, not remembered. Between the layout resolving the tenant and
  // this component rendering, the grant may have been ended from the
  // console — in which case there is nothing to announce.
  const grant = await currentImpersonation();
  if (!grant) return null;

  const [branding, actingAs] = await Promise.all([
    getBranding(tenant.orgId),
    grant.asUserId
      ? prisma.user.findUnique({
          where: { id: grant.asUserId },
          select: { name: true },
        })
      : Promise.resolve(null),
  ]);

  return (
    <ImpersonationBanner
      // `readOnly` rather than `allowWrites`: a suspended carrier stays
      // read-only whatever the grant asked for, and the bar must say what
      // is true rather than what was requested.
      iconName={tenant.readOnly ? "shield-alert" : "pencil-line"}
      writesAllowed={!tenant.readOnly}
      operatorName={grant.operator.name}
      operatorEmail={grant.operator.email}
      carrierName={branding?.name ?? tenant.slug}
      actingAs={actingAs?.name ?? null}
      reason={grant.reason}
      expiresAtLabel={format(grant.expiresAt, "HH:mm")}
      expiresAtIso={grant.expiresAt.toISOString()}
      exitPath={IMPERSONATION_EXIT_PATH}
    />
  );
}
