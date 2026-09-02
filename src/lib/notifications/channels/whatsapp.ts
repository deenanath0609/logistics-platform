import { getEnv } from "@/lib/env";
import { credentialFor, type ResolvedCredential } from "@/lib/integrations/credentials";
import type { ChannelAdapter, OutboundMessage, SendResult } from "./types";
import { ChannelNotConfiguredError, ProviderNotImplementedError } from "./types";
import { carrierIdentity, firstConfigured } from "../carrier";
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
    live: false,
    note:
      `WHATSAPP_PROVIDER is "${provider}", but no client is implemented for ` +
      "it. Every send is refused and recorded as skipped.",
    async send(message: OutboundMessage): Promise<SendResult> {
      const account = await credentialFor("WHATSAPP");

      if (!account.secret) {
        throw new ChannelNotConfiguredError("WHATSAPP", provider, [
          "WHATSAPP_API_KEY",
        ]);
      }

      const sender = await resolveWhatsAppSender(account);
      if (!sender) {
        throw new Error(
          "No WhatsApp sender for this message: the carrier has no " +
            "Business number on file and their BSP account names no phone " +
            "number id. A send with no registered sender is rejected by the " +
            "provider, so it is refused here rather than attempted — record " +
            "the carrier's WhatsApp Business number on the tenant screen.",
        );
      }

      return dispatch(provider, message, sender, account);
    },
  };
}

/**
 * Which number this message leaves as.
 *
 * Two halves of the same fact, and the narrower one wins. A BSP identifies
 * a sending number by its own opaque id, which is a property of the
 * account; `Organization.whatsappNumber` is the E.164 number itself, which
 * is the carrier's public identity and stays theirs across a change of
 * provider. There is no environment fallback on purpose: a WhatsApp
 * Business number belongs to one business, and there is no such thing as a
 * shared one to degrade to.
 */
export async function resolveWhatsAppSender(
  credential?: ResolvedCredential<"WHATSAPP">,
): Promise<string | null> {
  const account = credential ?? (await credentialFor("WHATSAPP"));
  const carrier = await carrierIdentity();

  return firstConfigured(
    account.settings.phoneNumberId,
    carrier?.whatsappNumber,
  );
}

async function dispatch(
  provider: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  message: OutboundMessage,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sender: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  account: ResolvedCredential<"WHATSAPP">,
): Promise<SendResult> {
  throw new ProviderNotImplementedError("WHATSAPP", provider, FILE);
}
