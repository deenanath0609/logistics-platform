import type { NotificationChannel } from "@/generated/prisma/client";
import type { ChannelAdapter } from "./types";
import { mockAdapter } from "./mock";
import { smsAdapter } from "./sms";
import { whatsappAdapter } from "./whatsapp";
import { emailAdapter } from "./email";

export type { ChannelAdapter, OutboundMessage, SendResult } from "./types";
export {
  ChannelNotConfiguredError,
  ProviderNotImplementedError,
  isConfigurationFailure,
} from "./types";
export { segmentsFor } from "./mock";

/**
 * One adapter per channel, chosen from the environment at first use.
 *
 * Cached because the choice cannot change while the process runs, and
 * because a template editor previewing twenty rows should not re-read the
 * environment twenty times. Tests reset it through `resetChannels`.
 */
const cache = new Map<NotificationChannel, ChannelAdapter>();

export function getChannelAdapter(
  channel: NotificationChannel,
): ChannelAdapter {
  const cached = cache.get(channel);
  if (cached) return cached;

  const adapter = build(channel);
  cache.set(channel, adapter);
  return adapter;
}

function build(channel: NotificationChannel): ChannelAdapter {
  switch (channel) {
    case "SMS":
      return smsAdapter();
    case "WHATSAPP":
      return whatsappAdapter();
    case "EMAIL":
      return emailAdapter();
    // PUSH and IN_APP have no gateway: push needs the field app's device
    // tokens, which arrive in Phase 7, and in-app is a database row the
    // shell reads. Both log through the mock until then, so a template
    // pointed at either is still recorded rather than silently dropped.
    case "PUSH":
    case "IN_APP":
      return mockAdapter(channel);
  }
}

/** Test seam. Also useful after an environment reload in development. */
export function resetChannels(): void {
  cache.clear();
}

/** Replaces one adapter. Used by tests; never call this from application code. */
export function setChannelAdapter(
  channel: NotificationChannel,
  adapter: ChannelAdapter,
): void {
  cache.set(channel, adapter);
}
