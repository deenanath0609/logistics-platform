import type { NotificationChannel } from "@/generated/prisma/client";
import { getChannelAdapter } from "./channels";

/**
 * Which channels can actually deliver anything, for the screens to say so.
 *
 * The send log's whole purpose is to settle "the customer says they never
 * got the SMS". It cannot settle it while a row written by the mock adapter
 * reads SENT and looks exactly like a row written by a real gateway — the
 * only difference is a `provider` key inside a JSON column nobody opens.
 *
 * So the two notification screens ask this what is behind each channel and
 * print the answer. It is deliberately a statement about the *deployment*,
 * not about one row: an operator who has just been handed a screen full of
 * green needs to know before they read a single line of it.
 *
 * Cheap enough to call per render — `getChannelAdapter` caches, and every
 * adapter decides `live` at construction from the environment.
 */
export type ChannelTransport = {
  channel: NotificationChannel;
  provider: string;
  live: boolean;
  note: string | null;
};

/** The channels a template can be pointed at, in the order the screens list them. */
export const NOTIFIABLE_CHANNELS: NotificationChannel[] = [
  "SMS",
  "EMAIL",
  "WHATSAPP",
  "PUSH",
  "IN_APP",
];

export function transportFor(channel: NotificationChannel): ChannelTransport {
  const adapter = getChannelAdapter(channel);
  return {
    channel,
    provider: adapter.provider,
    live: adapter.live,
    note: adapter.note ?? null,
  };
}

/** Every channel, so a screen can list the ones with nothing behind them. */
export function transportStatus(): ChannelTransport[] {
  return NOTIFIABLE_CHANNELS.map(transportFor);
}

/**
 * True when a log row was written by the mock rather than by a gateway.
 *
 * Read off the row rather than off the current environment on purpose: a
 * carrier who connected a real gateway last week still has last month's
 * mock rows in the log, and those rows did not become real deliveries when
 * the credentials landed.
 */
export function wasSimulated(providerResponse: unknown): boolean {
  if (!providerResponse || typeof providerResponse !== "object") return false;
  return (providerResponse as Record<string, unknown>).provider === "mock";
}
