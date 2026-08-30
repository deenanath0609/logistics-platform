import { prisma } from "@/lib/prisma";
import { getGpsProvider } from "@/lib/tracking/providers";
import { ingestPings } from "@/lib/tracking/ingest";
import { verifySignature } from "@/lib/tracking/signature";
import {
  runCrossTenant,
  runWithTenant,
  tenantContextFor,
  type ResolvedOrg,
} from "@/lib/tenant";

/**
 * POST /api/tracking/webhook — push-based position delivery.
 *
 * Three properties, in the order they are checked.
 *
 * **Signed.** HMAC-SHA256 over the raw body, compared in constant time. The
 * body is read as text and passed to the adapter as text, because signing
 * is over bytes: re-serialising the parsed object and verifying against
 * that rejects perfectly good deliveries the moment a vendor's encoder
 * orders keys differently from ours. An unsigned or unverifiable request is
 * a 401 and the body is never looked at.
 *
 * **Idempotent.** Vendors retry, load balancers replay, and a delivery that
 * timed out on our side was very likely processed anyway. The unique index
 * on `(deviceId, recordedAt)` makes a re-delivery a no-op, and the response
 * reports how many were dropped so the vendor's dashboard shows something
 * true rather than a duplicate-key error.
 *
 * **Fast.** Providers time out and start retrying, so the handler does the
 * ingest and returns; nothing here waits on a notification or a webhook of
 * our own — those go through the outbox like everything else.
 *
 * Which provider sent this is decided by the secret that verifies, not by a
 * query parameter. That is what lets one endpoint serve several vendors and
 * several organisations without a caller being able to claim an identity it
 * cannot prove.
 *
 * **Which tenant.** The same secret answers that too. Testing every active
 * config is the one genuinely cross-tenant read in the handler — the whole
 * question being asked is whose config this is — and it is declared as such.
 * The moment a config matches, its `orgId` is the answer, and everything
 * afterwards runs inside that tenant: an unsigned request never gets that
 * far, and a signed one can only ever write to the organisation whose secret
 * it proved it holds.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Signature header names, in the order they are looked for. */
const SIGNATURE_HEADERS = [
  "x-cl-signature",
  "x-signature",
  "x-hub-signature-256",
  "x-gps-signature",
];

/** A position batch is small. Anything larger is not one. */
const MAX_BODY_BYTES = 1_048_576;

type ResolvedProvider = {
  configId: string;
  code: string;
  secret: string;
  /** The tenant that owns the config whose secret verified the body. */
  org: ResolvedOrg;
};

/**
 * `bootstrap` is a body that verifies against `GPS_WEBHOOK_SECRET` and
 * therefore names no organisation. Kept as its own outcome rather than
 * folded into `unknown` because the two need opposite answers: one is a
 * stranger, the other is a configuration gap on our side.
 */
type Resolution =
  | { kind: "provider"; resolved: ResolvedProvider }
  | { kind: "bootstrap" }
  | { kind: "unknown" };

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();

  if (raw.length === 0) {
    return json(400, { error: "empty_body", message: "Nothing to ingest." });
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return json(413, { error: "too_large", message: "Position batch is too large." });
  }

  let signature: string | null = null;
  for (const header of SIGNATURE_HEADERS) {
    const value = request.headers.get(header);
    if (value) {
      signature = value;
      break;
    }
  }

  if (!signature) {
    return json(401, {
      error: "unsigned",
      message: `Sign the raw body with HMAC-SHA256 and send it as ${SIGNATURE_HEADERS[0]}.`,
    });
  }

  const resolution = await resolveProvider(raw, signature);

  if (resolution.kind === "unknown") {
    // Deliberately vague. Telling a caller whether the secret was wrong or
    // simply absent tells them something about our configuration.
    return json(401, { error: "invalid_signature", message: "Signature rejected." });
  }

  if (resolution.kind === "bootstrap") {
    // The bootstrap secret proves the caller is trusted; it does not say
    // whose vehicles these are. Every row an ingest writes — GpsPing,
    // VehicleLocation, the geofence events and trip events that follow — is
    // tenant-owned, so accepting this batch would mean inventing a tenant
    // for it, and the wrong guess puts one carrier's truck on another
    // carrier's live map. Refused instead.
    //
    // 503 rather than 401 because the caller is not the problem: every
    // vendor worth integrating retries a 503, so the fixes are not lost and
    // the retry succeeds as soon as the vendor is configured.
    console.error(
      "[tracking/webhook] refused a batch signed with GPS_WEBHOOK_SECRET: the " +
        "bootstrap secret belongs to no organisation, so the pings have no " +
        "tenant to be stored against. Add the vendor on the tracking provider " +
        "screen — that row carries the orgId this needs.",
    );
    return json(503, {
      error: "provider_not_configured",
      message:
        "This sender is not linked to an organisation. Configure the provider and retry.",
    });
  }

  const { resolved } = resolution;

  const tenant = tenantContextFor(resolved.org, "job");
  if (!tenant || tenant.readOnly) {
    // CLOSED yields no context at all; SUSPENDED yields a read-only one,
    // and an ingest is nothing but writes. Saying so plainly beats a 500
    // from the write that would otherwise be refused three frames down.
    return json(503, {
      error: "tenant_inactive",
      message: "This organisation is not accepting position data.",
    });
  }

  return runWithTenant(tenant, () => ingestBatch(raw, signature, resolved));
}

/**
 * Everything past identification, inside the sender's own tenant.
 *
 * Split out so the `runWithTenant` boundary is a single expression: no
 * query below this line can reach another organisation's rows, and none of
 * it has to name an `orgId` to be sure of that.
 */
async function ingestBatch(
  raw: string,
  signature: string,
  resolved: ResolvedProvider,
): Promise<Response> {
  const config = await prisma.trackingProviderConfig.findUnique({
    where: { id: resolved.configId },
    select: { baseUrl: true, apiKey: true, webhookSecret: true },
  });

  let provider;
  try {
    provider = getGpsProvider(resolved.code, {
      baseUrl: config?.baseUrl ?? null,
      apiKey: config?.apiKey ?? null,
      webhookSecret: resolved.secret,
    });
  } catch (error) {
    console.error("[tracking/webhook] no adapter", error);
    return json(501, {
      error: "no_adapter",
      message: `No adapter is configured for provider "${resolved.code}".`,
    });
  }

  const parsed = provider.parseWebhook(raw, signature);
  if (!parsed.ok) {
    await noteError(resolved.configId, `${parsed.reason}: ${parsed.detail}`);
    return parsed.reason === "signature"
      ? json(401, { error: "invalid_signature", message: "Signature rejected." })
      : json(400, { error: "invalid_payload", message: parsed.detail });
  }

  try {
    const summary = await ingestPings(parsed.pings);

    await prisma.trackingProviderConfig.update({
      where: { id: resolved.configId },
      data: { lastPolledAt: new Date(), lastError: null },
    });

    return json(202, {
      received: summary.received,
      accepted: summary.accepted,
      duplicates: summary.duplicates,
      unknownDevices: summary.unknownDevices,
      fenceEvents: summary.fenceEvents,
      shipmentEvents: summary.shipmentEvents,
    });
  } catch (error) {
    console.error("[tracking/webhook] ingest failed", error);
    await noteError(
      resolved.configId,
      error instanceof Error ? error.message : "Ingest failed",
    );
    // A 500 is the honest answer and the useful one: every provider worth
    // integrating retries on it, and the fixes are not lost.
    return json(500, { error: "ingest_failed", message: "Could not store the batch." });
  }
}

/**
 * Identifies the sender — and with it the tenant — by which configured
 * secret verifies the body.
 *
 * Every active config in the platform is tested, which is a cross-tenant
 * read by necessity: whose config this is, is the question. It is declared
 * as one rather than left to run without a tenant, so the reason appears in
 * the audit trail beside every other deliberate cross-tenant read.
 *
 * `GPS_WEBHOOK_SECRET` is still recognised, but it is no longer a way in.
 * It used to stand in for a provider row so an integration could be tested
 * before anyone filled in the configuration screen; under tenancy it stands
 * in for nothing, because a ping needs an organisation and that secret
 * names none. It is reported to the caller instead — see the `bootstrap`
 * branch in `POST`. Read from `process.env` directly because it is a
 * bootstrap secret rather than part of the validated configuration.
 */
async function resolveProvider(
  body: string,
  signature: string,
): Promise<Resolution> {
  const matched = await runCrossTenant(
    "gps webhook provider resolution",
    async (): Promise<ResolvedProvider | null> => {
      const configs = await prisma.trackingProviderConfig.findMany({
        where: { isActive: true, webhookSecret: { not: null } },
        select: { id: true, code: true, orgId: true, webhookSecret: true },
      });

      for (const config of configs) {
        if (!config.webhookSecret) continue;
        if (!verifySignature({ secret: config.webhookSecret, body, signature }).ok) {
          continue;
        }

        const org = await prisma.organization.findUnique({
          where: { id: config.orgId },
          select: {
            id: true,
            slug: true,
            subdomain: true,
            customDomain: true,
            status: true,
          },
        });
        if (!org) return null;

        return {
          configId: config.id,
          code: config.code,
          secret: config.webhookSecret,
          org,
        };
      }

      return null;
    },
  );

  if (matched) return { kind: "provider", resolved: matched };

  const bootstrap = process.env.GPS_WEBHOOK_SECRET;
  if (bootstrap && verifySignature({ secret: bootstrap, body, signature }).ok) {
    return { kind: "bootstrap" };
  }

  return { kind: "unknown" };
}

async function noteError(configId: string, message: string): Promise<void> {
  try {
    await prisma.trackingProviderConfig.update({
      where: { id: configId },
      data: { lastError: message.slice(0, 500) },
    });
  } catch {
    // Recording why a delivery failed must not be why the next one does.
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
