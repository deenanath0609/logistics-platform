import { getEnv } from "@/lib/env";
import { credentialFor, type ResolvedCredential } from "@/lib/integrations/credentials";
import { carrierIdentity, firstConfigured } from "../carrier";
import type { OutboundMessage } from "./types";

/**
 * The header an SMS goes out under.
 *
 * Its own module because two files need the same answer and must not each
 * have their own copy of it: `sms.ts`, which refuses the send without one,
 * and `mock.ts`, which warns about it in every environment that has not yet
 * contracted a gateway. A drifted second copy would mean development stops
 * warning about exactly the carriers production is about to refuse.
 *
 * Four sources, narrowest first:
 *
 * 1. **the template's own.** DLT approves a header and a template together,
 *    so where a template names one, that is the pairing that was approved;
 * 2. **the header registered on the carrier's own gateway account**, when
 *    they have one. A header is registered against an aggregator account,
 *    so a carrier with their own account may have a different one there
 *    from the one recorded on their organisation;
 * 3. **the carrier's registered header** — `Organization.dltSenderId`, which
 *    is what the rest of their traffic goes out as;
 * 4. **`SMS_SENDER_ID`**, a development convenience and nothing more. One
 *    header shared by every tenant is exactly what white-label is not, and
 *    in production it should be empty.
 */
export async function senderHeaderFor(
  message: OutboundMessage,
  credential?: ResolvedCredential<"SMS">,
): Promise<string | null> {
  const account = credential ?? (await credentialFor("SMS"));
  const carrier = await carrierIdentity();

  return firstConfigured(
    message.dltSenderId,
    // Only when the account really is the carrier's. On the platform's
    // shared account these settings *are* `SMS_SENDER_ID`, and letting them
    // in here would move that development convenience to the front of the
    // chain — ahead of the carrier's own registered header, which is the one
    // thing this chain exists to prefer.
    account.source === "tenant" ? account.settings.senderId : null,
    carrier?.dltSenderId,
    getEnv().SMS_SENDER_ID,
  );
}

/**
 * The same chain, as a refusal rather than a null.
 *
 * With none of the four there is nothing to send under, and the send is
 * refused rather than attempted. An unregistered — or absent — header is
 * rejected downstream by the operator, *after* the aggregator has returned
 * an accepted-looking response, so an attempt made here would be recorded as
 * a success for a message the consignee never receives. A refusal is the
 * only outcome anybody can act on, and what it needs is the carrier's DLT
 * registration, which takes weeks (ADR 001 §3).
 */
export async function resolveSenderId(
  message: OutboundMessage,
  credential?: ResolvedCredential<"SMS">,
): Promise<string> {
  const senderId = await senderHeaderFor(message, credential);
  if (senderId) return senderId;

  const carrier = await carrierIdentity();

  throw new Error(
    "No DLT sender header for this SMS: neither the template, nor " +
      (carrier ? `"${carrier.brandName}"` : "the organisation") +
      ", nor their gateway account has one registered. Indian operators " +
      "reject an unregistered header after the aggregator has already " +
      "accepted the message, so it would be logged as sent and never " +
      "delivered. Record the carrier's approved header on the organisation, " +
      "or the approved header on the template, before enabling SMS.",
  );
}
