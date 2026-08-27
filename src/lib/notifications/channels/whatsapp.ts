import { getEnv } from "@/lib/env";
import type { ChannelAdapter, OutboundMessage, SendResult } from "./types";
import { ChannelNotConfiguredError, ProviderNotImplementedError } from "./types";
import { mockAdapter } from "./mock";

const FILE = "src/lib/notifications/channels/whatsapp.ts";

/**
 * WhatsApp.
 *
 * Business API access runs through a Meta-approved Business Solution
 * Provider, and every outbound template needs Meta's approval on top of
 * that. Neither is in place, so this ships as a stub behind the same
 * interface as everything else and `WHATSAPP_PROVIDER` stays "mock".
 *
 * Worth knowing when the real one is written: outside a 24-hour customer
 * service window only an approved template may be sent, and the body has
 * to match the approved text exactly — the placeholders our templates
 * carry become the numbered components of the approved template.
 */
export function whatsappAdapter(): ChannelAdapter {
  const provider = (getEnv().WHATSAPP_PROVIDER || "mock").toLowerCase();

  if (provider === "mock") return mockAdapter("WHATSAPP");

  return {
    provider,
    channel: "WHATSAPP",
    async send(message: OutboundMessage): Promise<SendResult> {
      if (!process.env.WHATSAPP_API_KEY) {
        throw new ChannelNotConfiguredError("WHATSAPP", provider, [
          "WHATSAPP_API_KEY",
        ]);
      }

      return dispatch(provider, message);
    },
  };
}

async function dispatch(
  provider: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  message: OutboundMessage,
): Promise<SendResult> {
  throw new ProviderNotImplementedError("WHATSAPP", provider, FILE);
}
