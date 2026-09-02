import { getEnv } from "@/lib/env";
import { credentialFor, type ResolvedCredential } from "@/lib/integrations/credentials";
import type { ChannelAdapter, OutboundMessage, SendResult } from "./types";
import { ChannelNotConfiguredError, ProviderNotImplementedError } from "./types";
import { resolveSenderId, senderHeaderFor } from "./sender";
import { mockAdapter } from "./mock";

const FILE = "src/lib/notifications/channels/sms.ts";

// Re-exported because this is where a reader looks for it, and where the
// tests already import it from. The chain lives in `sender.ts` so `mock.ts`
// can warn about the same answer without importing this file back.
export { resolveSenderId, senderHeaderFor };

/**
 * SMS.
 *
 * `SMS_PROVIDER` chooses the gateway. It ships as "mock", and stays that
 * way until an aggregator is contracted — writing a speculative client for
 * an API nobody has read would be worse than having none, because it would
 * look finished.
 *
 * The provider *code* stays a deployment-wide choice while the API key does
 * not: a code selects which client in this folder runs, and a client is
 * code that has to exist before anyone can be pointed at it. The account
 * that code authenticates with is per carrier — see
 * `lib/integrations/credentials.ts`.
 *
 * Whoever wires the real one only has to fill in `dispatch()` below. The
 * DLT guard above it applies to every Indian provider and should stay.
 */
export function smsAdapter(): ChannelAdapter {
  const provider = (getEnv().SMS_PROVIDER || "mock").toLowerCase();

  if (provider === "mock") return mockAdapter("SMS");

  return {
    provider,
    channel: "SMS",
    // True only for the providers `dispatch()` below actually speaks. Any
    // other value of SMS_PROVIDER still resolves to an adapter that refuses,
    // and the screens must keep saying so rather than showing a green tick
    // for a gateway nobody wrote.
    live: IMPLEMENTED_PROVIDERS.has(provider),
    note: IMPLEMENTED_PROVIDERS.has(provider)
      ? "Messages are submitted to MSG91. Each template still needs its DLT " +
        "id recorded before it can be switched on."
      : `SMS_PROVIDER is "${provider}", and no client is implemented for it. ` +
        `Implemented: ${[...IMPLEMENTED_PROVIDERS].join(", ")}. Every send is refused.`,
    async send(message: OutboundMessage): Promise<SendResult> {
      // The carrier's own aggregator account where they have one, ours
      // where they do not. Resolved before anything else because the sender
      // header may be registered against that account rather than against
      // the organisation.
      const account = await credentialFor("SMS");

      if (!account.secret) {
        throw new ChannelNotConfiguredError("SMS", provider, ["SMS_API_KEY"]);
      }

      // DLT is not optional and not recoverable at send time: an unregistered
      // template is accepted by the aggregator and dropped by the operator,
      // so the only place this can be caught is here.
      if (!message.dltTemplateId) {
        throw new Error(
          "This SMS template has no DLT template id. Indian operators drop " +
            "unregistered transactional templates without a delivery report. " +
            "Register the template on the DLT portal and record its id on the " +
            "template before enabling it.",
        );
      }

      return dispatch(
        provider,
        message,
        await resolveSenderId(message, account),
        account,
      );
    },
  };
}

/** Providers `dispatch()` can actually speak. Anything else is refused. */
const IMPLEMENTED_PROVIDERS = new Set(["msg91"]);

/** MSG91's own host, unless the carrier's account is on another one. */
const MSG91_BASE = "https://api.msg91.com";

/**
 * Ten digits, or the same number wearing a country code.
 *
 * MSG91 wants the number with the country code and no punctuation, and what
 * arrives here is whatever a booking clerk typed — `+91 98111 00011`,
 * `098111-00011`, `9811100011`. Normalising is not cosmetic: the aggregator
 * accepts a malformed number and reports it undelivered hours later, by
 * which time the consignee has not been told their parcel is coming.
 */
export function toMsg91Mobile(raw: string, countryCode = "91"): string | null {
  // Leading zeros are a trunk prefix, not a country code — `098111 00011` is
  // the same subscriber as `9811100011`, and reading the zero as part of the
  // number sends the message to a different one. Stripped before the length
  // is judged, because the length is what decides whether a country code is
  // already there.
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");

  if (digits.length === 10) return `${countryCode}${digits}`;
  if (digits.length > 10 && digits.length <= 15) return digits;
  return null;
}

/**
 * The provider call.
 *
 * Every aggregator in this market speaks plain HTTPS with an API key, so no
 * dependency is needed — `fetch` and the documented body are enough. One
 * branch per provider as each is contracted.
 *
 * MSG91's v2 endpoint is the one used here rather than the v5 "flow" API,
 * and the reason is the shape of what we hold: this platform renders a
 * template into a finished string and knows the DLT template id it was
 * registered under. v5 wants the *variables* and the flow id it holds its
 * own copy of the template against, which would mean the message text lived
 * in two places — the carrier could edit it here and change nothing that
 * goes out. v2 takes the rendered body and the DLT id, which is exactly what
 * we have and keeps one copy of the words.
 */
async function dispatch(
  provider: string,
  message: OutboundMessage,
  // Neither the sender id nor the account is read from the environment
  // inside: both belong to the carrier this message is for, and the
  // environment does not know which carrier that is.
  senderId: string,
  account: ResolvedCredential<"SMS">,
): Promise<SendResult> {
  if (provider !== "msg91") {
    throw new ProviderNotImplementedError("SMS", provider, FILE);
  }

  const mobile = toMsg91Mobile(message.to);
  if (!mobile) {
    return {
      ok: false,
      error:
        `"${message.to}" is not a mobile number MSG91 will accept. ` +
        "Ten digits, or a country code and up to fifteen.",
    };
  }

  const base = account.settings.baseUrl?.replace(/\/+$/, "") || MSG91_BASE;

  let response: Response;
  try {
    response = await fetch(`${base}/api/v2/sendsms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authkey: account.secret as string,
      },
      body: JSON.stringify({
        sender: senderId,
        // 4 is MSG91's transactional route. Everything this platform sends
        // is transactional — a consignment moved, a delivery failed — and
        // the promotional route is blocked by DND registries, which is most
        // consignees.
        route: "4",
        country: "91",
        DLT_TE_ID: message.dltTemplateId,
        sms: [{ message: message.body, to: [mobile] }],
      }),
      // The worker holds a pass open while this runs; a gateway that has
      // stopped answering must not hold the whole drain with it.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // A refused connection, a DNS failure, the timeout above. Reported as a
    // send failure so the outbox retries it, rather than thrown, which would
    // retry every other handler on the same event too.
    return {
      ok: false,
      error: `MSG91 could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text.slice(0, 500) };
  }

  // MSG91 answers 200 with `{"type":"error"}` for a rejected submission, so
  // the status code alone is not the answer. Both have to agree.
  const accepted = response.ok && body.type !== "error";

  return {
    ok: accepted,
    providerRef: typeof body.message === "string" ? body.message : null,
    response: { provider, status: response.status, ...body },
    error: accepted
      ? null
      : `MSG91 refused the message (HTTP ${response.status}): ${
          typeof body.message === "string" ? body.message : text.slice(0, 200)
        }`,
  };
}
