import nodemailer, { type Transporter } from "nodemailer";
import { getEnv } from "@/lib/env";
import { credentialFor, type ResolvedCredential } from "@/lib/integrations/credentials";
import type { ChannelAdapter, OutboundMessage, SendResult } from "./types";
import { ChannelNotConfiguredError } from "./types";
import { carrierIdentity, firstConfigured } from "../carrier";
import { mockAdapter } from "./mock";


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
 * The transport is built from the resolved settings and cached per account,
 * because opening a connection and an EHLO handshake for every delivery
 * notice is how a relay starts refusing you for abuse.
 *
 * On the dependency: `nodemailer` was dropped from this project once, because
 * carrying an unused package with a live advisory is a standing audit failure
 * bought for nothing. It is back because it is no longer unused, and it is
 * pinned to the version `@auth/core` already resolves — so the copy in
 * `node_modules` is the one that was there anyway and the advisory count is
 * unchanged. Every version Auth.js accepts is named by that advisory; there
 * is no clean version to move to without downgrading Auth.js itself.
 *
 * What those advisories describe are the `raw` message option,
 * `jsonTransport`, `List-*` header comments, `envelope.size` and the
 * transport *name* — none of which this code passes. What it does pass is
 * customer-supplied text into `to` and `subject`, so both are stripped of CR
 * and LF before nodemailer sees them: a line break in a header value is how
 * one message quietly becomes two.
 */
export function emailAdapter(): ChannelAdapter {
  const noRelay = mockAdapter("EMAIL");

  return {
    provider: "smtp",
    channel: "EMAIL",
    // Mail leaves the building over SMTP. A carrier with no relay of their
    // own still falls back to the mock, and the log row says so through
    // `wasSimulated` — `live` describes the transport, not a promise that
    // every row went out over it.
    live: true,
    note:
      "Mail is sent over SMTP — the carrier's own relay where they have one, " +
      "the platform's where they do not. With neither, sends are simulated " +
      "and each log row is marked as such.",
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

/**
 * A header value with no way out of its own field.
 *
 * `to` is a customer's address and `subject` renders a template against
 * customer data, so either can carry whatever somebody typed into a booking
 * form. A CR or LF in a header value ends that header and begins writing
 * new ones — a Bcc, a second body. Stripped rather than escaped, because no
 * legitimate address or subject line contains a line break.
 */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * One transport per account, kept for the life of the process.
 *
 * Keyed on everything that decides where the connection goes and who it
 * authenticates as, so a rotated password produces a new transport rather
 * than a stale authenticated one. Pooled, because a busy branch can raise a
 * dozen notices in a second and a connection each is how a sender gets
 * rate-limited.
 */
const transports = new Map<string, Transporter>();

function transportFor(account: ResolvedCredential<"SMTP">): Transporter {
  const { host, port, user, secure } = account.settings;
  const key = [host, port, user, secure, account.secret].join("|");

  const existing = transports.get(key);
  if (existing) return existing;

  const created = nodemailer.createTransport({
    host: host as string,
    // 587 is submission with STARTTLS, which is what most relays want and
    // what `secure: false` means here — not "unencrypted".
    port: port ?? (secure ? 465 : 587),
    secure,
    auth: { user: user as string, pass: account.secret as string },
    pool: true,
    maxConnections: 3,
    // A relay that has stopped answering must not hold a worker pass open.
    // The outbox will retry the event.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  transports.set(key, created);
  return created;
}

/** Drops cached transports, so a changed credential is re-read. */
export function resetEmailTransports(): void {
  for (const transport of transports.values()) transport.close();
  transports.clear();
}

async function dispatch(
  message: OutboundMessage,
  // The From address the carrier sends as — see `resolveFrom`. Passed in for
  // the same reason the SMS sender header is: the environment holds one
  // address, and the platform has many carriers.
  from: string,
  // Host, port, user and the decrypted password. Everything the transport
  // needs, already resolved to one carrier's account.
  account: ResolvedCredential<"SMTP">,
): Promise<SendResult> {
  const sent = await transportFor(account).sendMail({
    from: headerSafe(from),
    to: headerSafe(message.to),
    subject: headerSafe(message.subject ?? ""),
    text: message.body,
    // Carried as a header so a bounce, or a support query weeks later, can
    // be tied back to the log row that produced it.
    headers: message.reference
      ? { "X-Logistics-Reference": headerSafe(message.reference) }
      : undefined,
  });

  // `accepted` is per recipient. One address goes in, so an empty list is
  // the relay taking the message and refusing the person — a success that
  // delivers nothing, and it must not be recorded as sent.
  const accepted = Array.isArray(sent.accepted) ? sent.accepted.length : 0;

  return {
    ok: accepted > 0,
    providerRef: sent.messageId ?? null,
    response: {
      provider: "smtp",
      host: account.settings.host,
      accepted: sent.accepted,
      rejected: sent.rejected,
      response: sent.response,
    },
    error:
      accepted > 0
        ? null
        : `The relay accepted no recipient: ${sent.response ?? "no response given"}`,
  };
}
