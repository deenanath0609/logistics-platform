import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import { getGpsProvider } from "@/lib/tracking/providers";
import { ingestPings } from "@/lib/tracking/ingest";
import { verifySignature } from "@/lib/tracking/signature";

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
  configId: string | null;
  code: string;
  secret: string;
};

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

  const resolved = await resolveProvider(raw, signature);
  if (!resolved) {
    // Deliberately vague. Telling a caller whether the secret was wrong or
    // simply absent tells them something about our configuration.
    return json(401, { error: "invalid_signature", message: "Signature rejected." });
  }

  const config = resolved.configId
    ? await prisma.trackingProviderConfig.findUnique({
        where: { id: resolved.configId },
        select: { baseUrl: true, apiKey: true, webhookSecret: true },
      })
    : null;

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
    if (resolved.configId) {
      await noteError(resolved.configId, `${parsed.reason}: ${parsed.detail}`);
    }
    return parsed.reason === "signature"
      ? json(401, { error: "invalid_signature", message: "Signature rejected." })
      : json(400, { error: "invalid_payload", message: parsed.detail });
  }

  try {
    const summary = await ingestPings(parsed.pings);

    if (resolved.configId) {
      await prisma.trackingProviderConfig.update({
        where: { id: resolved.configId },
        data: { lastPolledAt: new Date(), lastError: null },
      });
    }

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
    if (resolved.configId) {
      await noteError(
        resolved.configId,
        error instanceof Error ? error.message : "Ingest failed",
      );
    }
    // A 500 is the honest answer and the useful one: every provider worth
    // integrating retries on it, and the fixes are not lost.
    return json(500, { error: "ingest_failed", message: "Could not store the batch." });
  }
}

/**
 * Identifies the sender by which configured secret verifies the body.
 *
 * Falls back to `GPS_WEBHOOK_SECRET` from the environment when no provider
 * row exists yet, so an integration can be tested before anybody has filled
 * in the configuration screen. Read from `process.env` directly because it
 * is a bootstrap secret rather than part of the validated application
 * configuration.
 */
async function resolveProvider(
  body: string,
  signature: string,
): Promise<ResolvedProvider | null> {
  const configs = await prisma.trackingProviderConfig.findMany({
    where: { isActive: true, webhookSecret: { not: null } },
    select: { id: true, code: true, webhookSecret: true },
  });

  for (const config of configs) {
    if (!config.webhookSecret) continue;
    if (verifySignature({ secret: config.webhookSecret, body, signature }).ok) {
      return { configId: config.id, code: config.code, secret: config.webhookSecret };
    }
  }

  const bootstrap = process.env.GPS_WEBHOOK_SECRET;
  if (bootstrap && verifySignature({ secret: bootstrap, body, signature }).ok) {
    return { configId: null, code: getEnv().GPS_PROVIDER, secret: bootstrap };
  }

  return null;
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
