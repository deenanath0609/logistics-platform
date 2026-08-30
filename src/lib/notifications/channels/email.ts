import { getEnv } from "@/lib/env";
import { credentialFor, type ResolvedCredential } from "@/lib/integrations/credentials";
import type { ChannelAdapter, OutboundMessage, SendResult } from "./types";
import { ChannelNotConfiguredError, ProviderNotImplementedError } from "./types";
import { carrierIdentity, firstConfigured } from "../carrier";
import { mockAdapter } from "./mock";

const FILE = "src/lib/notifications/channels/email.ts";

/**
 * Email.
 *
 * There is no `EMAIL_PROVIDER`: the presence of an SMTP host is the switch.
 * No host anywhere means the mock, which is what every environment runs on
 * until a relay is chosen.
 *
 * What changed when relays became per-carrier is *when* that switch is
 * read. It used to be a process-wide decision taken once, at startup, from
 * `SMTP_HOST`; a carrier with their own relay and a platform with none would
 * have been stuck on the mock for ever. So the adapter is always built, and
 * decides per message — which is also per tenant, because the credential is.
 *
 * The real implementation is a transport built from the resolved settings
 * and one `sendMail` call — but it is not written here, because a relay
 * that has never been tested against is not a relay. `nodemailer` was
 * carried as a dependency in anticipation of it and has been dropped again:
 * an unused package with a live SMTP-injection advisory against it is a
 * standing audit failure bought in exchange for nothing. Add it back with
 * the transport, on a version the advisory does not name.
 */
export function emailAdapter(): ChannelAdapter {
  const noRelay = mockAdapter("EMAIL");

  return {
    provider: "smtp",
    channel: "EMAIL",
    async send(message: OutboundMessage): Promise<SendResult> {
      // The carrier's own relay where they have one, the platform's where
      // they do not — never one carrier's host with the platform's
      // password, which would authenticate as us to a relay that is not
      // ours. See `lib/integrations/credentials.ts`.
      const account = await credentialFor("SMTP");

      // No relay for this carrier and none for the platform. The mock, as
      // before — its result records `provider: "mock"` in the response
      // stored on the log row, so a send that took this branch is
      // distinguishable from one that reached a real relay.
      if (!account.settings.host) return noRelay.send(message);

      const missing: string[] = [];
      if (!account.settings.user) missing.push("SMTP_USER");
      if (!account.secret) missing.push("SMTP_PASSWORD");
      if (missing.length > 0) {
        throw new ChannelNotConfiguredError("EMAIL", "smtp", missing);
      }

      const from = await resolveFrom();
      if (!from) {
        throw new ChannelNotConfiguredError("EMAIL", "smtp", ["SMTP_FROM"]);
      }

      return dispatch(message, from, account);
    },
  };
}

/**
 * The From address, carrier first.
 *
 * A delivery confirmation arriving from our domain tells the consignee that
 * some company they have never dealt with is holding their goods — and it is
 * the carrier's domain, not ours, that carries the SPF and DKIM records
 * saying this relay may send on their behalf, so our own address is a
 * deliverability problem as much as a branding one.
 *
 * `SMTP_FROM` behind it is the development fallback, for a tenant whose mail
 * domain has not been set up yet.
 *
 * Kept on `Organization` rather than in the credential's settings for the
 * same reason the DLT header is: the address a carrier sends as is their
 * public identity, not a fact about which relay account carries it, and it
 * stays theirs when the relay is swapped.
 */
export async function resolveFrom(): Promise<string | null> {
  const carrier = await carrierIdentity();
  return firstConfigured(carrier?.smtpFrom, getEnv().SMTP_FROM);
}

async function dispatch(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  message: OutboundMessage,
  // The From address the carrier sends as — see `resolveFrom`. Passed in for
  // the same reason the SMS sender header is: the environment holds one
  // address, and the platform has many carriers.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  from: string,
  // Host, port, user and the decrypted password. Everything the transport
  // needs, already resolved to one carrier's account.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  account: ResolvedCredential<"SMTP">,
): Promise<SendResult> {
  throw new ProviderNotImplementedError("EMAIL", "smtp", FILE);
}
