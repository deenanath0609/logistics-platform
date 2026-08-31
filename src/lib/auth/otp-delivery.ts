import { getChannelAdapter, isConfigurationFailure } from "@/lib/notifications/channels";
import { carrierIdentity } from "@/lib/notifications/carrier";
import { prisma } from "@/lib/prisma";

/**
 * Getting the login code to the person waiting for it.
 *
 * `issueOtp` mints the code and stores its hash, and until now that was the
 * end of the story: the code was returned to the caller and shown on screen
 * in development. Outside development it went nowhere, which meant a field
 * user — created without a password, by design, because a driver should not
 * be typing one at a loading bay — **could not sign in at all**. The pickup
 * and delivery screens were unreachable by the only people who need them.
 *
 * ── Why this is not `dispatchEvent` ─────────────────────────
 *
 * The notification pipeline hangs off shipments: it resolves recipients from
 * a consignment, suppresses by branch, and refuses an aggregate it has no
 * addressee for. A login code has no consignment, and the recipient is the
 * number that asked. Routing it through that machinery would mean teaching
 * it a second kind of recipient for one message.
 *
 * So it goes straight to the channel adapter — which is where the per-carrier
 * gateway account is resolved anyway, so the code still leaves on the
 * carrier's own SMS account and under their own registered header.
 *
 * ── What a failure means here ───────────────────────────────
 *
 * Nothing is told to the caller. Whether a number belongs to a staff member
 * is not something a sign-in form may reveal, and "we could not send you a
 * code" reveals it as surely as "no such user" does. So a failure is logged
 * with the reason and the screen says the same thing it always says.
 */

export type OtpDelivery =
  | { delivered: true; channel: "SMS" }
  | { delivered: false; reason: string };

/**
 * The message itself.
 *
 * Short, and the code first: it is read off a notification shade with one
 * eye while the other watches a road. The carrier's name is there because a
 * driver may work for two of them and the codes look identical.
 */
function messageFor(code: string, brand: string | null, minutes: number): string {
  const who = brand ? `${brand}: ` : "";
  return `${who}${code} is your sign-in code. It expires in ${minutes} minutes. Do not share it.`;
}

export async function deliverLoginCode(input: {
  mobile: string;
  code: string;
  expiresAt: Date;
}): Promise<OtpDelivery> {
  const minutes = Math.max(
    1,
    Math.round((input.expiresAt.getTime() - Date.now()) / 60_000),
  );

  try {
    const carrier = await carrierIdentity();
    const adapter = getChannelAdapter("SMS");

    const result = await adapter.send({
      channel: "SMS",
      to: input.mobile,
      body: messageFor(input.code, carrier?.brandName ?? null, minutes),
      // The carrier's registered header, resolved by the adapter. A login
      // code sent under an unregistered one is accepted by the aggregator
      // and dropped by the operator, which would look exactly like a code
      // that never arrived.
      dltSenderId: carrier?.dltSenderId ?? null,
      // One code, one send. A resend mints a new code and therefore a new
      // reference, so a provider that collapses duplicates cannot swallow
      // the second one.
      reference: `login:${input.mobile}:${input.expiresAt.getTime()}`,
    });

    if (!result.ok) {
      console.error("[auth/otp] the gateway refused the login code", {
        mobile: mask(input.mobile),
        error: result.error,
      });
      return { delivered: false, reason: result.error ?? "The gateway refused it." };
    }

    // Recorded so a support desk can answer "did it go out?" without being
    // able to read the code — the body is deliberately not stored.
    //
    // Only when there is a carrier to record it against. `carrierIdentity`
    // returns null outside a tenant — a script, a test — and the log is a
    // tenant-owned table, so there would be nowhere to put the row. The
    // code has already been sent either way; failing to file the paperwork
    // must not undo that.
    if (carrier) {
      await recordSent(carrier.orgId, input.mobile, result.providerRef ?? null);
    }

    return { delivered: true, channel: "SMS" };
  } catch (error) {
    const reason =
      isConfigurationFailure(error) || error instanceof Error
        ? (error as Error).message
        : "The SMS gateway could not be reached.";

    console.error("[auth/otp] could not send the login code", {
      mobile: mask(input.mobile),
      reason,
    });

    return { delivered: false, reason };
  }
}

/**
 * A line in the notification log, without the code in it.
 *
 * The log is what a support desk reads, and a login code sitting in it
 * would be the whole of authentication written down next to the number it
 * belongs to. "A code was sent at 14:32" answers the question that actually
 * gets asked.
 */
async function recordSent(
  orgId: string,
  mobile: string,
  providerRef: string | null,
): Promise<void> {
  try {
    await prisma.notificationLog.create({
      data: {
        orgId,
        channel: "SMS",
        recipient: mobile,
        // Not a customer and not a consignee: the person signing in is the
        // carrier's own staff, and the log should say so when somebody
        // filters it later.
        recipientKind: "STAFF",
        status: "SENT",
        eventType: "LOGIN_OTP",
        subject: null,
        body: "A sign-in code was sent. The code itself is never stored.",
        providerRef,
        sentAt: new Date(),
      },
    });
  } catch (error) {
    // Never the reason a person cannot sign in.
    console.error("[auth/otp] could not record the send", error);
  }
}

/** Last four digits only, for a log line. */
function mask(mobile: string): string {
  return mobile.length <= 4 ? "****" : `******${mobile.slice(-4)}`;
}
