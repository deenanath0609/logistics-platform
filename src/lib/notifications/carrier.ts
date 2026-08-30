import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { currentTenant } from "@/lib/tenant/context";
import { tenantOrigin } from "@/lib/tenant/host";

/**
 * Who a notification goes out as.
 *
 * A consignee never asked to hear from us. They hear from the carrier whose
 * driver is at their door, and every part of the message has to agree with
 * that: the name in the body, the header an SMS arrives under, the address an
 * email is from, and the host the tracking link points at. Notifications are
 * the third of the four white-label surfaces in ADR 001 §3, and the only one
 * where getting it wrong is also a deliverability problem rather than just an
 * embarrassment.
 *
 * Everything here degrades to the environment rather than throwing. The
 * template editor's preview, the seed and the tests all render notifications
 * with no tenant established, and none of them should have to invent one.
 *
 * Imports the leaf tenant modules rather than the `@/lib/tenant` barrel: the
 * barrel pulls in host resolution, and with it a second Prisma client, into
 * every process that only wants to know which carrier it is acting as.
 */
export type CarrierIdentity = {
  orgId: string;
  /** `Organization.name` — the trading name, not the legal one. */
  brandName: string;
  supportPhone: string | null;
  supportEmail: string | null;
  /** Scheme and host that public links must be built on. No trailing slash. */
  origin: string;
  /** The carrier's DLT-registered SMS header, once approval comes through. */
  dltSenderId: string | null;
  smtpFrom: string | null;
  /** The carrier's own WhatsApp Business number, in E.164. */
  whatsappNumber: string | null;
};

/**
 * Held for a few seconds because one outbox event asks for this several times
 * over — once to render the body, once per SMS for the sender header, once
 * per email for the From address — and the drain is not a request, so there
 * is no request cache under it to lean on.
 *
 * Short on purpose, for the same reason the host cache in `tenant/resolve.ts`
 * is: a sender header that finished DLT approval this morning has to start
 * being used minutes later, not on the next deploy.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { identity: CarrierIdentity; expires: number }>();

/** Called by tests, and after an organisation's branding is edited. */
export function resetCarrierCache(): void {
  cache.clear();
}

/**
 * The carrier the work currently running belongs to, or null when no tenant
 * has been established — which is a normal state in development and in the
 * template preview, not an error.
 */
export async function carrierIdentity(): Promise<CarrierIdentity | null> {
  const tenant = currentTenant();
  if (!tenant) return null;

  const hit = cache.get(tenant.orgId);
  if (hit && hit.expires > Date.now()) return hit.identity;

  // `Organization` is one of the handful of global tables the tenant
  // extension passes through untouched, so the ordinary client reads it by
  // id without needing the unextended one.
  const org = await prisma.organization.findUnique({
    where: { id: tenant.orgId },
    select: {
      name: true,
      supportPhone: true,
      supportEmail: true,
      subdomain: true,
      customDomain: true,
      dltSenderId: true,
      smtpFrom: true,
      whatsappNumber: true,
    },
  });
  if (!org) return null;

  const identity: CarrierIdentity = {
    orgId: tenant.orgId,
    brandName: org.name,
    supportPhone: firstConfigured(org.supportPhone),
    supportEmail: firstConfigured(org.supportEmail),
    origin: originFor(org),
    dltSenderId: firstConfigured(org.dltSenderId),
    smtpFrom: firstConfigured(org.smtpFrom),
    whatsappNumber: firstConfigured(org.whatsappNumber),
  };

  cache.set(tenant.orgId, { identity, expires: Date.now() + TTL_MS });
  return identity;
}

/**
 * The host a consignee's link must point at.
 *
 * Public tracking is the most-seen surface the platform has and it is seen by
 * people who have never heard of us, so the link goes to the carrier's own
 * host — their custom domain where they have one, their subdomain otherwise.
 *
 * `APP_URL` is what is left when there is no tenant: local development
 * against a bare `localhost`, the template editor's preview, and the tests.
 * It is a single origin shared by everyone, which is precisely why it cannot
 * be what a real notification uses.
 */
export async function notificationOrigin(): Promise<string> {
  const carrier = await carrierIdentity();
  return carrier?.origin ?? stripTrailingSlash(getEnv().APP_URL);
}

/** A public tracking link, on the carrier's host, for one consignment. */
export async function trackingLink(
  lrNumber: string,
  path = "",
): Promise<string> {
  const origin = await notificationOrigin();
  return `${origin}/track/${encodeURIComponent(lrNumber)}${path}`;
}

/**
 * The first value in a fallback chain that is actually set.
 *
 * Every chain in this module ends at an environment variable that is usually
 * the empty string, and `??` treats `""` as a value — which is how an empty
 * sender header reaches a gateway instead of the fallback behind it.
 */
export function firstConfigured(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function originFor(org: { subdomain: string; customDomain: string | null }): string {
  const env = getEnv();

  // Scheme and port are facts about the deployment, not about the tenant:
  // production serves https on 443, development serves http on 3010, and
  // `acme.localhost:3010` has to be reachable or nobody exercises the
  // per-tenant link path before a consignee does.
  let protocol = "https";
  let port: string | undefined;
  try {
    const app = new URL(env.APP_URL);
    protocol = app.protocol.replace(":", "");
    port = app.port || undefined;
  } catch {
    // APP_URL is not constrained to a URL by the schema. A malformed one
    // costs the right port, not a thrown error halfway through a send.
  }

  return tenantOrigin(org, env.APP_ROOT_DOMAIN, protocol, port);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
