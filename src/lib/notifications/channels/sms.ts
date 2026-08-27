import { getEnv } from "@/lib/env";
import type { ChannelAdapter, OutboundMessage, SendResult } from "./types";
import { ChannelNotConfiguredError, ProviderNotImplementedError } from "./types";
import { mockAdapter } from "./mock";

const FILE = "src/lib/notifications/channels/sms.ts";

/**
 * SMS.
 *
 * `SMS_PROVIDER` chooses the gateway. It ships as "mock", and stays that
 * way until an aggregator is contracted — writing a speculative client for
 * an API nobody has read would be worse than having none, because it would
 * look finished.
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
    async send(message: OutboundMessage): Promise<SendResult> {
      const missing: string[] = [];
      if (!process.env.SMS_API_KEY) missing.push("SMS_API_KEY");
      if (!process.env.SMS_SENDER_ID && !message.dltSenderId) {
        missing.push("SMS_SENDER_ID");
      }
      if (missing.length > 0) {
        throw new ChannelNotConfiguredError("SMS", provider, missing);
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

      return dispatch(provider, message);
    },
  };
}

/**
 * The provider call.
 *
 * Every aggregator in this market speaks plain HTTPS with an API key, so no
 * dependency is needed here — `fetch` and the provider's documented request
 * body are enough. Add a branch per provider as each is contracted.
 */
async function dispatch(
  provider: string,
  // The parameter stays in the signature because it is the whole input the
  // real client needs; it is unused only because there is no client yet.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  message: OutboundMessage,
): Promise<SendResult> {
  throw new ProviderNotImplementedError("SMS", provider, FILE);
}
