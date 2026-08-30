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

/**
 * The provider call.
 *
 * Every aggregator in this market speaks plain HTTPS with an API key, so no
 * dependency is needed here — `fetch` and the provider's documented request
 * body are enough. Add a branch per provider as each is contracted.
 */
async function dispatch(
  provider: string,
  // The parameters stay in the signature because they are the whole input the
  // real client needs; they are unused only because there is no client yet.
  // Neither the sender id nor the account is read from the environment
  // inside: both belong to the carrier this message is for, and the
  // environment does not know which carrier that is.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  message: OutboundMessage,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  senderId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  account: ResolvedCredential<"SMS">,
): Promise<SendResult> {
  throw new ProviderNotImplementedError("SMS", provider, FILE);
}
