import type { NotificationChannel } from "@/generated/prisma/client";

/**
 * The contract every gateway hides behind.
 *
 * Deliberately narrow: one method, no batching, no templates. Providers
 * disagree about everything else — segment counting, delivery receipts,
 * template registration — so the only thing worth standardising is "here
 * is a message, tell me what happened to it".
 */

export type OutboundMessage = {
  channel: NotificationChannel;
  /** Phone in E.164 or local form, or an email address. Never masked here. */
  to: string;
  /** Email only. */
  subject?: string | null;
  body: string;
  /**
   * DLT registration for Indian transactional SMS. Without these the
   * operator drops the message without telling anyone, so the adapter
   * refuses rather than letting it disappear.
   */
  dltTemplateId?: string | null;
  dltSenderId?: string | null;
  /**
   * Stable per-send token. Providers that support it will collapse a
   * duplicate submission; ours also carries it into the log so a support
   * query can be answered from either side.
   */
  reference?: string;
};

export type SendResult = {
  ok: boolean;
  /** The gateway's own message id, for a "did it arrive" query later. */
  providerRef?: string | null;
  /** Whatever the gateway said, stored verbatim on the log row. */
  response?: Record<string, unknown> | null;
  /** Billable SMS segments, where the gateway reports them. */
  segments?: number | null;
  /** Cost in the org currency, where the gateway reports it. */
  cost?: number | null;
  error?: string | null;
};

export interface ChannelAdapter {
  /** Provider name as it appears in `SMS_PROVIDER` etc. */
  readonly provider: string;
  readonly channel: NotificationChannel;
  send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * Thrown when a real provider is selected but its credentials are absent.
 *
 * Distinct from a send failure: nothing was attempted, and no amount of
 * retrying will help until someone edits `.env`. The message names the
 * exact variables so the person reading the log does not have to guess.
 */
export class ChannelNotConfiguredError extends Error {
  constructor(
    public readonly channel: NotificationChannel,
    public readonly provider: string,
    missing: string[],
  ) {
    super(
      `${channel} provider "${provider}" is selected but not configured. ` +
        `Set ${missing.join(", ")} in the environment, or set the provider ` +
        `back to "mock" while the account is being opened.`,
    );
    this.name = "ChannelNotConfiguredError";
  }
}

/**
 * Thrown when credentials exist but nobody has written the client yet.
 *
 * The gateway contracts are not signed at the time of writing, so guessing
 * an API shape here would produce code that has never spoken to the thing
 * it claims to speak to. Failing loudly is the honest option.
 */
export class ProviderNotImplementedError extends Error {
  constructor(
    public readonly channel: NotificationChannel,
    public readonly provider: string,
    file: string,
  ) {
    super(
      `No client is implemented for ${channel} provider "${provider}". ` +
        `Implement it in ${file} once the provider is chosen and its API ` +
        `documented — do not guess at the request shape.`,
    );
    this.name = "ProviderNotImplementedError";
  }
}

/** True when the failure is a configuration problem, not a gateway problem. */
export function isConfigurationFailure(error: unknown): boolean {
  return (
    error instanceof ChannelNotConfiguredError ||
    error instanceof ProviderNotImplementedError
  );
}
