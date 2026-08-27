import type { ChannelAdapter, OutboundMessage, SendResult } from "./types";
import { ChannelNotConfiguredError, ProviderNotImplementedError } from "./types";
import { mockAdapter } from "./mock";

const FILE = "src/lib/notifications/channels/email.ts";

/**
 * Email.
 *
 * There is no `EMAIL_PROVIDER`: the presence of `SMTP_HOST` is the switch.
 * An empty host means the mock, which is what every environment runs on
 * until a relay is chosen.
 *
 * `nodemailer` is already a dependency of this project, so the real
 * implementation is a transport built from the SMTP_* variables and a
 * `sendMail` call — but it is not written here, because a relay that has
 * never been tested against is not a relay.
 */
export function emailAdapter(): ChannelAdapter {
  const host = process.env.SMTP_HOST?.trim();

  if (!host) return mockAdapter("EMAIL");

  return {
    provider: "smtp",
    channel: "EMAIL",
    async send(message: OutboundMessage): Promise<SendResult> {
      const missing: string[] = [];
      if (!process.env.SMTP_USER) missing.push("SMTP_USER");
      if (!process.env.SMTP_PASSWORD) missing.push("SMTP_PASSWORD");
      if (!process.env.SMTP_FROM) missing.push("SMTP_FROM");
      if (missing.length > 0) {
        throw new ChannelNotConfiguredError("EMAIL", "smtp", missing);
      }

      return dispatch(message);
    },
  };
}

async function dispatch(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  message: OutboundMessage,
): Promise<SendResult> {
  throw new ProviderNotImplementedError("EMAIL", "smtp", FILE);
}
